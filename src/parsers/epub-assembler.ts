/**
 * EPUB Assembler — builds a valid EPUB file from database blocks + files.
 *
 * Unlike EpubWriter (which patches an existing ZIP), this creates an EPUB
 * from scratch using only the data stored in SQLite. This allows exporting
 * both original and translated versions without needing the original file.
 *
 * Output structure:
 *   mimetype                        (uncompressed, must be first)
 *   META-INF/container.xml          (points to content.opf)
 *   OEBPS/content.opf              (package document — manifest + spine)
 *   OEBPS/toc.ncx                   (navigation for EPUB2 readers)
 *   OEBPS/nav.xhtml                (navigation for EPUB3 readers)
 *   OEBPS/chapter_0.xhtml           (content documents)
 *   OEBPS/chapter_1.xhtml
 *   OEBPS/images/*.jpg              (image files from files table)
 *   OEBPS/styles.css                (minimal stylesheet)
 */

import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { TranslateDb } from '../db/database.js';
import type { BookRecord, Block, FileRecord } from '../types.js';
import { assembleDocHtml } from './block-assembler.js';

export interface AssembleOptions {
  /** 'original' uses originalMd, 'translated' uses translatedMd (fallback: originalMd) */
  mode: 'original' | 'translated';
  /** Language code for the output EPUB (default: source language) */
  lang?: string;
}

/**
 * Assemble an EPUB file from database content.
 *
 * @param bookId - Book ID in the database
 * @param db - TranslateDb instance (caller manages lifecycle)
 * @param outputPath - Where to write the .epub file
 * @param options - Assembly mode and language
 */
export function assembleEpub(
  bookId: string,
  db: TranslateDb,
  outputPath: string,
  options: AssembleOptions = { mode: 'translated' },
): void {
  const book = db.getBook(bookId);
  if (!book) throw new Error(`Book not found: ${bookId}`);

  // Gather data from DB
  const allBlocks = db.getBlocksByBook(bookId);
  const docPaths = db.getDocPaths(bookId);
  const files = db.getFilesByBook(bookId);

  // Build a path mapping: original image path → file ID
  // Keys include the original_path and variations (basename, relative paths)
  const pathToId = new Map<string, string>();
  for (const file of files) {
    const ext = mimeTypeToExt(file.mimeType);
    const resolved = `images/${file.id}${ext}`;
    pathToId.set(file.id, resolved);           // file:ID → resolved
    pathToId.set(file.originalPath, resolved); // ops/images/x.jpg → resolved
    // Also map by basename for relative path matching (../images/x.jpg)
    const basename = file.originalPath.split('/').pop();
    if (basename) {
      pathToId.set(basename, resolved);
      pathToId.set(`images/${basename}`, resolved);
      pathToId.set(`../images/${basename}`, resolved);
    }
  }

  // If mode is 'translated', swap originalMd ↔ translatedMd so assembler uses translated
  if (options.mode === 'translated') {
    for (const block of allBlocks) {
      if (block.translatedMd !== null) {
        // blockToHtml already prefers translatedMd over originalMd
        // No swap needed — assembler picks translatedMd ?? originalMd
      }
    }
  }

  // Build EPUB structure
  const zip = new AdmZip();
  const bookIdUri = `urn:uuid:${bookId}`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  // Unique ID for the EPUB publication
  const uid = uuidv4();
  const uidUri = `urn:uuid:${uid}`;

  // Determine output language
  const outputLang = options.lang || book.targetLang || book.language;

  // ── 1. mimetype (MUST be first entry, uncompressed) ──────────
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), '', 0);

  // ── 2. META-INF/container.xml ───────────────────────────────
  zip.addFile('META-INF/container.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`, 'utf8'), '', 8);

  // ── 3. Build content documents ──────────────────────────────
  const chapterEntries: { href: string; id: string; title: string }[] = [];

  for (let i = 0; i < docPaths.length; i++) {
    const docPath = docPaths[i];
    const docBlocks = allBlocks.filter(b => b.docPath === docPath);
    const chapterId = `chapter_${i}`;
    const href = `chapter_${i}.xhtml`;

    // Use translated text if mode is 'translated' and translation exists
    const blocksForAssembly = options.mode === 'translated'
      ? docBlocks
      : docBlocks.map(b => ({ ...b, translatedMd: null })); // force original

    // Find a title from heading blocks, skipping trivial ones
    let chapterTitle = '';
    const headings = blocksForAssembly.filter(b => b.type === 'heading');
    for (let hi = 0; hi < headings.length; hi++) {
      const mdText = headings[hi].translatedMd ?? headings[hi].originalMd;
      const cleaned = cleanTitle(mdText);
      if (!cleaned) continue;

      // If this is just a number (chapter number) and there's a next heading,
      // combine: "1. The Myth of the Ant Queen"
      if (/^\d+$/.test(cleaned) && hi + 1 < headings.length) {
        const nextMd = headings[hi + 1].translatedMd ?? headings[hi + 1].originalMd;
        const nextCleaned = cleanTitle(nextMd);
        if (nextCleaned && !/^\d+$/.test(nextCleaned)) {
          chapterTitle = `${cleaned}. ${nextCleaned}`;
          break;
        }
      }

      chapterTitle = cleaned;
      break;
    }

    // No heading found — try first text paragraph
    if (!chapterTitle) {
      const textBlock = blocksForAssembly.find(b => b.type === 'paragraph');
      if (textBlock) {
        const mdText = textBlock.translatedMd ?? textBlock.originalMd;
        chapterTitle = cleanTitle(mdText, 80);
      }
    }

    // Still no title — derive from doc_path basename
    if (!chapterTitle) {
      const baseName = docPath.split('/').pop()?.replace(/\.\w+$/, '') || docPath;
      // Convert kebab/snake case to title case
      chapterTitle = baseName
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
    }

    // Build file resolver for EPUB: file:ID or original path → images/ID.ext
    const fileResolver = (src: string): string => {
      // Direct file:ID reference
      if (src.startsWith('file:')) {
        const fileId = src.slice(5);
        const resolved = pathToId.get(fileId);
        if (resolved) return resolved;
        const ext = mimeTypeToExt(
          files.find(f => f.id === fileId)?.mimeType || 'image/jpeg'
        );
        return `images/${fileId}${ext}`;
      }
      // Try original path lookup
      const resolved = pathToId.get(src);
      if (resolved) return resolved;
      // Try basename match
      const basename = src.split('/').pop();
      if (basename) {
        const byBasename = pathToId.get(basename);
        if (byBasename) return byBasename;
      }
      // Fallback: return as-is
      return src;
    };

    const bodyContent = assembleDocHtml(blocksForAssembly, db, bookId, fileResolver);

    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${escapeXml(outputLang)}" lang="${escapeXml(outputLang)}">
<head>
  <meta charset="UTF-8"/>
  <title>${escapeXml(chapterTitle)}</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
${bodyContent}
</body>
</html>`;

    zip.addFile(`OEBPS/${href}`, Buffer.from(xhtml, 'utf8'), '', 8);
    chapterEntries.push({ href, id: chapterId, title: chapterTitle });
  }

  // ── 4. Add image files ──────────────────────────────────────
  const imageEntries: { href: string; id: string; mimeType: string }[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const ext = mimeTypeToExt(file.mimeType);
    const fileId = file.id;
    const href = `images/${fileId}${ext}`;

    zip.addFile(`OEBPS/${href}`, file.data, '', 8);
    imageEntries.push({ href, id: `img_${i}`, mimeType: file.mimeType });
  }

  // ── 5. Minimal stylesheet ──────────────────────────────────
  const css = `/* ai-translate default stylesheet */
body {
  font-family: serif;
  margin: 1em;
  line-height: 1.5;
}
h1, h2, h3, h4, h5, h6 {
  margin-top: 1.5em;
  margin-bottom: 0.5em;
  page-break-after: avoid;
}
p {
  margin: 0.5em 0;
  text-indent: 1em;
}
blockquote {
  margin: 1em 2em;
  font-style: italic;
}
img {
  max-width: 100%;
}
div[style*="page-break-before:always"] {
  page-break-before: always;
}
`;

  zip.addFile('OEBPS/styles.css', Buffer.from(css, 'utf8'), '', 8);

  // ── 6. content.opf (package document) ───────────────────────
  const manifestItems: string[] = [
    `    <item id="styles" href="styles.css" media-type="text/css"/>`,
    `    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
  ];

  for (const ch of chapterEntries) {
    manifestItems.push(`    <item id="${ch.id}" href="${ch.href}" media-type="application/xhtml+xml"/>`);
  }
  for (const img of imageEntries) {
    manifestItems.push(`    <item id="${img.id}" href="${img.href}" media-type="${img.mimeType}"/>`);
  }

  const spineItems = chapterEntries.map(ch => `    <itemref idref="${ch.id}"/>`).join('\n');

  // Cover image (first image if any)
  const coverMeta = imageEntries.length > 0
    ? `    <meta name="cover" content="${imageEntries[0].id}"/>\n`
    : '';

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">${uidUri}</dc:identifier>
    <dc:title>${escapeXml(book.title)}</dc:title>
    <dc:creator>${escapeXml(book.author)}</dc:creator>
    <dc:language>${escapeXml(outputLang)}</dc:language>
    <dc:date>${now}</dc:date>
    <meta property="dcterms:modified">${now}</meta>
${coverMeta}  </metadata>
  <manifest>
${manifestItems.join('\n')}
  </manifest>
  <spine toc="ncx">
${spineItems}
  </spine>
</package>`;

  zip.addFile('OEBPS/content.opf', Buffer.from(opf, 'utf8'), '', 8);

  // ── 7. nav.xhtml (EPUB3 navigation) ─────────────────────────
  const navItems = chapterEntries.map((ch, i) =>
    `      <li><a href="${ch.href}">${escapeXml(ch.title)}</a></li>`
  ).join('\n');

  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(outputLang)}" lang="${escapeXml(outputLang)}">
<head>
  <meta charset="UTF-8"/>
  <title>Table of Contents</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Table of Contents</h1>
    <ol>
${navItems}
    </ol>
  </nav>
</body>
</html>`;

  zip.addFile('OEBPS/nav.xhtml', Buffer.from(nav, 'utf8'), '', 8);

  // ── 8. toc.ncx (EPUB2 navigation for older readers) ────────────
  const ncxNavPoints = chapterEntries.map((ch, i) =>
    `  <navPoint id="${ch.id}" playOrder="${i + 1}">
    <navLabel><text>${escapeXml(ch.title)}</text></navLabel>
    <content src="${ch.href}"/>
  </navPoint>`
  ).join('\n');

  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${escapeXml(outputLang)}">
<head>
  <meta name="dtb:uid" content="${uidUri}"/>
  <meta name="dtb:depth" content="1"/>
  <meta name="dtb:totalPageCount" content="0"/>
  <meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle>
  <text>${escapeXml(book.title)}</text>
</docTitle>
<navMap>
${ncxNavPoints}
</navMap>
</ncx>`;

  zip.addFile('OEBPS/toc.ncx', Buffer.from(ncx, 'utf8'), '', 8);

  // ── Write to disk ───────────────────────────────────────────
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  zip.writeZip(outputPath);
}

// ── Helpers ────────────────────────────────────────────────────

/**
 * Clean markdown text to produce a plain-text title for TOC.
 * Removes: heading markers, images, links, bold/italic/underline markers.
 * If result is empty or trivial (just "Image"/"images"), returns empty string.
 */
function cleanTitle(md: string, maxLen: number = 0): string {
  let title = md
    .replace(/^#+\s*/, '')          // Remove heading markers
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')  // Remove ![alt](src) entirely
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // [text](url) → text
    .replace(/\*\*([^*]+)\*\*/g, '$1')  // **bold** → bold
    .replace(/__([^_]+)__/g, '$1')      // __bold__ → bold
    .replace(/\*([^*]+)\*/g, '$1')     // *italic* → italic
    .replace(/_([^_]+)_/g, '$1')       // _italic_ → italic
    .replace(/\+\+([^+]+)\+\+/g, '$1') // ++underline++ → underline
    .replace(/`([^`]+)`/g, '$1')       // `code` → code
    .replace(/~~([^~]+)~~/g, '$1')     // ~~strike~~ → strike
    .trim();

  // Skip trivial titles that are just image alt text
  if (/^(images?|cover|image)$/i.test(title)) {
    title = '';
  }

  if (maxLen > 0 && title.length > maxLen) {
    title = title.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
  }
  return title;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mimeTypeToExt(mimeType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
  };
  return map[mimeType] || '.bin';
}
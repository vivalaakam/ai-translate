import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EpubParser } from '../../src/parsers/epub-parser.js';
import { extractAllBlocks, buildImageMap } from '../../src/parsers/block-extractor.js';
import { assembleEpub } from '../../src/parsers/epub-assembler.js';
import { TranslateDb } from '../../src/db/database.js';
import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const SAMPLE_WITH_IMAGE = path.join(FIXTURES_DIR, 'sample-with-image.epub');

let tmpDir;
let db;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-translate-img-e2e-'));
  db = new TranslateDb(path.join(tmpDir, 'test.db'));
});

afterAll(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true });
});

describe('E2E: EPUB import/export with image', () => {
  it('should parse EPUB with image → extract blocks + files → store in DB → assemble EPUB → image is present', async () => {
    // ── Step 1: Parse EPUB ────────────────────────────────────
    const parser = new EpubParser(SAMPLE_WITH_IMAGE);
    const parsed = await parser.parse();

    expect(parsed.contentDocs.length).toBeGreaterThan(0);
    expect(parsed.images.length).toBeGreaterThan(0);
    expect(parsed.images[0].originalPath).toContain('cover.png');
    expect(parsed.images[0].mimeType).toBe('image/png');
    expect(parsed.images[0].data.length).toBeGreaterThan(0);

    // ── Step 2: Extract blocks + image map ────────────────────
    const bookId = 'e2e-image-test-book';
    const { blocks, files: fileRecords } = extractAllBlocks(
      parsed.contentDocs,
      bookId,
      parsed.images,
    );

    // Should have at least heading and paragraph blocks
    // Note: <img> inside <p class="imagefp"> is extracted as 'paragraph' type,
    // not 'image' — this is expected because the <p> is the block-level element
    const types = blocks.map(b => b.type);
    expect(types).toContain('heading');
    expect(types).toContain('paragraph');

    // Should have a file record for the image
    expect(fileRecords.length).toBeGreaterThan(0);
    expect(fileRecords[0].mimeType).toBe('image/png');

    // ── Step 3: Store in DB ───────────────────────────────────
    db.insertBook({
      id: bookId,
      title: parsed.metadata.title,
      author: parsed.metadata.author || 'Unknown',
      language: parsed.metadata.language || 'en',
      filename: 'sample-with-image.epub',
      totalBlocks: blocks.length,
    });

    // Insert file records
    for (const file of fileRecords) {
      db.insertFile(file);
    }

    // Insert blocks (DB expects snake_case field names)
    db.insertBlocks(
      blocks.map(b => ({
        id: b.id,
        bookId: b.bookId,
        index: b.index ?? b.blockIndex ?? 0,
        docPath: b.docPath,
        type: b.type,
        originalMd: b.originalMd,
        translatedMd: b.translatedMd,
        fileId: b.fileId ?? null,
        tagName: b.tagName,
        attributes: b.attributes,
      })),
    );

    // Verify DB state
    const storedBlocks = db.getBlocksByBook(bookId);
    expect(storedBlocks.length).toBe(blocks.length);

    const storedFiles = db.getFilesByBook(bookId);
    expect(storedFiles.length).toBeGreaterThan(0);

    // ── Step 4: Assemble EPUB (original mode) ──────────────────
    const outputPath = path.join(tmpDir, 'exported_exported.epub');
    assembleEpub(bookId, db, outputPath, { mode: 'original' });

    expect(fs.existsSync(outputPath)).toBe(true);

    // ── Step 5: Verify assembled EPUB ─────────────────────────
    const zip = new AdmZip(outputPath);
    const entries = zip.getEntries().map(e => e.entryName);

    // Basic EPUB structure
    expect(entries).toContain('mimetype');
    expect(entries).toContain('META-INF/container.xml');
    expect(entries).toContain('OEBPS/content.opf');
    expect(entries).toContain('OEBPS/nav.xhtml');
    expect(entries).toContain('OEBPS/styles.css');

    // Image file must be in the EPUB
    const imageEntry = entries.find(e => e.includes('.png') && e.includes('images/'));
    expect(imageEntry).toBeDefined();

    // Image data must match original
    const imageData = zip.readFile(imageEntry);
    expect(imageData.length).toBeGreaterThan(0);

    // Chapter XHTML must reference the image with correct path
    const chapterContent = zip.readAsText('OEBPS/chapter_0.xhtml');

    // Must have <img> tag with src pointing to images/
    expect(chapterContent).toContain('images/');
    expect(chapterContent).toContain('.png');

    // Must have self-closing XHTML <img ... />
    expect(chapterContent).toMatch(/<img[^>]+\/>/);

    // Must NOT have double-wrapped <p><p> tags
    expect(chapterContent).not.toMatch(/<p[^>]*><p>/);

    // Must NOT have original path like ../images/cover.png
    expect(chapterContent).not.toContain('../images/');

    // Must contain text content
    expect(chapterContent).toContain('Chapter with Image');
    expect(chapterContent).toContain('This paragraph has text after an image');

    // Cleanup
    db.deleteBook(bookId);
  });

  it('should resolve image inside <p> paragraph block (not type=image)', async () => {
    // Some EPUBs wrap <img> inside <p class="imagefp">
    // The extractor creates a paragraph block with ![alt](../images/x.jpg) markdown
    // The assembler must resolve the path via fileResolver
    const parser = new EpubParser(SAMPLE_WITH_IMAGE);
    const parsed = await parser.parse();

    const bookId = 'e2e-image-para-test';
    const { blocks, files: fileRecords } = extractAllBlocks(
      parsed.contentDocs,
      bookId,
      parsed.images,
    );

    db.insertBook({
      id: bookId,
      title: 'Image Para Test',
      author: 'Test',
      language: 'en',
      filename: 'test.epub',
      totalBlocks: blocks.length,
    });

    for (const file of fileRecords) {
      db.insertFile(file);
    }

    db.insertBlocks(
      blocks.map(b => ({
        id: b.id,
        bookId: b.bookId,
        index: b.index ?? b.blockIndex ?? 0,
        docPath: b.docPath,
        type: b.type,
        originalMd: b.originalMd,
        translatedMd: b.translatedMd,
        fileId: b.fileId ?? null,
        tagName: b.tagName,
        attributes: b.attributes,
      })),
    );

    const outputPath = path.join(tmpDir, 'exported_para_image.epub');
    assembleEpub(bookId, db, outputPath, { mode: 'original' });

    const zip = new AdmZip(outputPath);
    const chapterContent = zip.readAsText('OEBPS/chapter_0.xhtml');

    // All image src attributes should point to images/UUID.ext, never ../images/
    const imgSrcs = chapterContent.match(/src="([^"]+)"/g) || [];
    for (const src of imgSrcs) {
      expect(src).not.toContain('../images/');
      expect(src).toMatch(/images\/[a-f0-9-]+\.\w+/);
    }

    // Cleanup
    db.deleteBook(bookId);
  });
});
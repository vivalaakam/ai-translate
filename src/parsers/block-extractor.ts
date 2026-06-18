import TurndownService from 'turndown';
import { generateBlockId, generateFileId } from '../db/database.js';
import type { Block, BlockType, ContentDoc, ExtractedImage, FileRecord } from '../types.js';

/**
 * HTML tag → BlockType mapping.
 */
const TAG_TO_TYPE: Record<string, BlockType> = {
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
  p: 'paragraph',
  img: 'image', image: 'image',
  li: 'list_item',
  blockquote: 'quote',
  pre: 'code', code: 'code',
  tr: 'table_row',
  hr: 'page_break',
};

/**
 * Block-level tags that should be extracted as separate blocks.
 */
const BLOCK_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'blockquote', 'pre', 'ul', 'ol', 'li', 'table', 'tr', 'img', 'figure', 'dl', 'dt', 'dd', 'hr']);

/**
 * Result of extracting blocks from a book.
 * Includes both the text blocks and any file records for images.
 */
export interface ExtractionResult {
  blocks: Block[];
  /** File records for images that should be stored in the files table. */
  files: FileRecord[];
}

/**
 * Extract blocks from a ContentDoc's DOM.
 * Each direct block-level child of <body> becomes one Block row.
 */
export function extractBlocksFromDoc(doc: ContentDoc, bookId: string, imageMap: Map<string, string>): Block[] {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
  });
  // Don't escape Markdown special chars inside code
  turndown.keep(['code']);

  // ── Custom rules for inline formatting ──────────────────────
  // <u> → ++underline++ (custom syntax, will be rendered back to <u>)
  turndown.addRule('underline', {
    filter: 'u',
    replacement: (content) => `++${content}++`,
  });

  // <span style="font-style:italic"> → _italic_
  turndown.addRule('styledItalic', {
    filter: (node) => {
      if (node.nodeName !== 'SPAN') return false;
      const style = node.getAttribute('style') || '';
      return /font-style\s*:\s*(italic|oblique)/i.test(style);
    },
    replacement: (content) => `_${content}_`,
  });

  // <span style="font-weight:bold/700"> → **bold**
  turndown.addRule('styledBold', {
    filter: (node) => {
      if (node.nodeName !== 'SPAN') return false;
      const style = node.getAttribute('style') || '';
      return /font-weight\s*:\s*(bold|[7-9]00)/i.test(style);
    },
    replacement: (content) => `**${content}**`,
  });

  // <span style="text-decoration:underline"> → ++underline++
  turndown.addRule('styledUnderline', {
    filter: (node) => {
      if (node.nodeName !== 'SPAN') return false;
      const style = node.getAttribute('style') || '';
      return /text-decoration\s*:\s*.*underline/i.test(style);
    },
    replacement: (content) => `++${content}++`,
  });

  const blocks: Block[] = [];
  const body = doc.dom.querySelector('body') || doc.dom;
  const children = body.childNodes;

  let blockIndex = 0;

  for (const child of children) {
    // Skip text nodes that are just whitespace
    if (child.nodeType === 3 && !child.textContent.trim()) continue;
    // Skip comment nodes
    if (child.nodeType === 8) continue;

    const block = extractBlock(child, bookId, doc.path, blockIndex, turndown, imageMap);
    if (block) {
      blocks.push(block);
      blockIndex++;
    }
  }

  return blocks;
}

/**
 * Extract a single block from a DOM node.
 */
function extractBlock(node: any, bookId: string, docPath: string, index: number, turndown: TurndownService, imageMap: Map<string, string>): Block | null {
  // Get tag name (lowercase), default to 'div' for non-element nodes
  const tagName = node.tagName ? node.tagName.toLowerCase() : 'div';

  // Skip non-content elements
  if (['script', 'style', 'link', 'meta', 'head'].includes(tagName)) return null;

  const type = TAG_TO_TYPE[tagName] || 'other';
  const attributes = extractAttributes(node);

  // Detect page breaks: <hr>, or elements with page-break-before/after CSS
  if (type === 'page_break' || hasPageBreak(node)) {
    const blockId = generateBlockId(bookId, `page_break:${docPath}:${index}`);
    return {
      id: blockId,
      bookId,
      index,
      docPath,
      type: 'page_break',
      content: '---',
      lang: '',
      model: null,
      sourceId: null,
      fileId: null,
      tagName,
      attributes,
    };
  }

  // Handle image blocks specially
  if (type === 'image' || tagName === 'img' || tagName === 'image') {
    const src = node.getAttribute('src') || node.getAttribute('xlink:href') || '';
    const alt = node.getAttribute('alt') || node.getAttribute('title') || '';

    // Look up the file ID from the image map
    let fileId: string | null = null;
    const resolvedSrc = resolveImageSrc(src, imageMap);
    if (resolvedSrc) {
      fileId = resolvedSrc;
    }

    // Use file:ID reference in markdown so we can resolve it later
    const mdSrc = fileId ? `file:${fileId}` : src;
    const content = alt ? `![${alt}](${mdSrc})` : `![](${mdSrc})`;
    const blockId = generateBlockId(bookId, content);

    return {
      id: blockId,
      bookId,
      index,
      docPath,
      type: 'image',
      content,
      lang: '',
      model: null,
      sourceId: null,
      fileId,
      tagName,
      attributes,
    };
  }

  // For container elements (ul, ol, table, figure, div) that contain block children, flatten them
  if (['ul', 'ol', 'table', 'figure', 'div'].includes(tagName)) {
    const childBlocks: Block[] = [];
    let childIndex = index;

    for (const child of node.childNodes) {
      if (child.nodeType === 3 && !child.textContent.trim()) continue;
      if (child.nodeType === 8) continue;

      const childTagName = child.tagName ? child.tagName.toLowerCase() : '';
      // Only extract block-level children, inline text goes to the parent
      if (BLOCK_TAGS.has(childTagName)) {
        const block = extractBlock(child, bookId, docPath, childIndex, turndown, imageMap);
        if (block) {
          childBlocks.push(block);
          childIndex++;
        }
      } else if (childTagName === 'li') {
        const block = extractBlock(child, bookId, docPath, childIndex, turndown, imageMap);
        if (block) {
          childBlocks.push(block);
          childIndex++;
        }
      }
    }

    // If we found block children, return them instead of the container
    if (childBlocks.length > 0) {
      return childBlocks.length === 1 ? childBlocks[0] : childBlocks[0]; // Return first; caller will handle the rest
    }

    // If the container has only inline content, treat it as a single block
    const text = node.textContent.trim();
    if (!text) return null;
  }

  // Standard block element — convert to Markdown
  const html = node.outerHTML || node.textContent || '';
  const content = turndown.turndown(html).trim();

  if (!content) return null;

  const blockId = generateBlockId(bookId, content);

  return {
    id: blockId,
    bookId,
    index,
    docPath,
    type,
    content,
    lang: '',
    model: null,
    sourceId: null,
    fileId: null,
    tagName,
    attributes,
  };
}

/**
 * Resolve an image src to a file ID using the image map.
 * Tries various path resolutions to find a match.
 */
function resolveImageSrc(src: string, imageMap: Map<string, string>): string | null {
  if (!src) return null;

  // Direct match
  if (imageMap.has(src)) return imageMap.get(src)!;

  // Try without leading # (FB2 xlink:href)
  if (src.startsWith('#')) {
    const withoutHash = src.slice(1);
    if (imageMap.has(withoutHash)) return imageMap.get(withoutHash)!;
    // Try with extension appended (for FB2 images with #id.ext format)
    for (const [key, id] of imageMap) {
      if (key.startsWith('#') && key.split('.').shift() === src) return id;
      if (key.startsWith('#' + withoutHash)) return id;
    }
  }

  // Try common path prefixes
  const prefixes = ['', 'OEBPS/', 'OEBPS/Images/', 'Images/', 'images/'];
  for (const prefix of prefixes) {
    const tryPath = prefix + src.replace(/^\.\.\//, '');
    if (imageMap.has(tryPath)) return imageMap.get(tryPath)!;
  }

  // Try matching just the filename
  const basename = src.split('/').pop() || '';
  for (const [key, id] of imageMap) {
    if (key.endsWith('/' + basename) || key === basename) return id;
  }

  return null;
}

/**
 * Build an image map (path → fileId) from extracted images.
 * Also returns the FileRecord array for database insertion.
 */
export function buildImageMap(images: ExtractedImage[], bookId: string): { imageMap: Map<string, string>; files: FileRecord[] } {
  const imageMap = new Map<string, string>();
  const files: FileRecord[] = [];
  const now = new Date().toISOString();

  for (const img of images) {
    const fileId = generateFileId(img.data);
    imageMap.set(img.originalPath, fileId);
    files.push({
      id: fileId,
      bookId,
      originalPath: img.originalPath,
      mimeType: img.mimeType,
      data: img.data,
      createdAt: now,
    });
  }

  return { imageMap, files };
}

/**
 * Extract all blocks from a ParsedEpub's content documents.
 * Returns both blocks and file records.
 */
export function extractAllBlocks(contentDocs: ContentDoc[], bookId: string, images: ExtractedImage[]): ExtractionResult {
  // Build image path → fileId map
  const { imageMap, files } = buildImageMap(images, bookId);

  const allBlocks: Block[] = [];
  let globalIndex = 0;

  for (const doc of contentDocs) {
    const docBlocks = extractBlocksFromDoc(doc, bookId, imageMap);
    // Re-index globally across all docs
    for (const block of docBlocks) {
      block.index = globalIndex++;
      // Re-generate ID with global index context for uniqueness
      block.id = generateBlockId(bookId, `${block.docPath}:${globalIndex}:${block.content}`);
      allBlocks.push(block);
    }
  }

  return { blocks: allBlocks, files };
}

/**
 * Check if a node has a page-break CSS property.
 * Detects: page-break-before: always, page-break-after: always,
 * break-before: page, break-after: page
 */
function hasPageBreak(node: any): boolean {
  const style = node.getAttribute?.('style') || '';
  if (/page-break-before\s*:\s*always/i.test(style)) return true;
  if (/page-break-after\s*:\s*always/i.test(style)) return true;
  if (/break-before\s*:\s*page/i.test(style)) return true;
  if (/break-after\s*:\s*page/i.test(style)) return true;
  return false;
}

/**
 * Extract HTML attributes from a node as a JSON string.
 * Preserves class, id, style, and other data-* attributes for reassembly.
 */
function extractAttributes(node: any): string {
  if (!node.attributes) return '{}';

  const attrs: Record<string, string> = {};

  // node.attributes can be a NamedNodeMap (DOM), a Map, or a plain object
  if (typeof node.attributes === 'object') {
    if (typeof node.attributes[Symbol.iterator] === 'function') {
      // Iterable (NamedNodeMap, Map, etc.)
      for (const attr of node.attributes) {
        if (['class', 'id', 'style', 'href', 'src', 'alt', 'title', 'lang', 'xml:lang', 'xmlns'].includes(attr.name) ||
            attr.name.startsWith('data-') || attr.name.startsWith('epub:')) {
          attrs[attr.name] = attr.value;
        }
      }
    } else if (node.attribs) {
      // cheerio-style: attribs is a plain object { name: value }
      for (const [name, value] of Object.entries(node.attribs)) {
        if (['class', 'id', 'style', 'href', 'src', 'alt', 'title', 'lang', 'xml:lang', 'xmlns'].includes(name) ||
            name.startsWith('data-') || name.startsWith('epub:')) {
          attrs[name] = value as string;
        }
      }
    } else {
      // Plain object: { name: value }
      for (const [name, value] of Object.entries(node.attributes)) {
        if (typeof value === 'string') {
          if (['class', 'id', 'style', 'href', 'src', 'alt', 'title', 'lang', 'xml:lang', 'xmlns'].includes(name) ||
              name.startsWith('data-') || name.startsWith('epub:')) {
            attrs[name] = value;
          }
        }
      }
    }
  }
  return JSON.stringify(attrs);
}
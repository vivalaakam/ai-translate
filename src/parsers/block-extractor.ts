import TurndownService from 'turndown';
import { generateBlockId } from '../db/database.js';
import type { Block, BlockType, ContentDoc } from '../types.js';

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
};

/**
 * Block-level tags that should be extracted as separate blocks.
 */
const BLOCK_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'blockquote', 'pre', 'ul', 'ol', 'li', 'table', 'tr', 'img', 'figure', 'dl', 'dt', 'dd', 'hr']);

/**
 * Extract blocks from a ContentDoc's DOM.
 * Each direct block-level child of <body> becomes one Block row.
 */
export function extractBlocksFromDoc(doc: ContentDoc, bookId: string): Block[] {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
  });
  // Don't escape Markdown special chars inside code
  turndown.keep(['code']);

  const blocks: Block[] = [];
  const body = doc.dom.querySelector('body') || doc.dom;
  const children = body.childNodes;

  let blockIndex = 0;

  for (const child of children) {
    // Skip text nodes that are just whitespace
    if (child.nodeType === 3 && !child.textContent.trim()) continue;
    // Skip comment nodes
    if (child.nodeType === 8) continue;

    const block = extractBlock(child, bookId, doc.path, blockIndex, turndown);
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
function extractBlock(node: any, bookId: string, docPath: string, index: number, turndown: TurndownService): Block | null {
  // Get tag name (lowercase), default to 'div' for non-element nodes
  const tagName = node.tagName ? node.tagName.toLowerCase() : 'div';

  // Skip non-content elements
  if (['script', 'style', 'link', 'meta', 'head'].includes(tagName)) return null;

  const type = TAG_TO_TYPE[tagName] || 'other';
  const attributes = extractAttributes(node);

  // Handle image blocks specially
  if (type === 'image' || tagName === 'img' || tagName === 'image') {
    const src = node.getAttribute('src') || node.getAttribute('xlink:href') || '';
    const alt = node.getAttribute('alt') || node.getAttribute('title') || '';
    let imageBase64: string | null = null;

    // If the src is a data URI, store it
    if (src.startsWith('data:')) {
      imageBase64 = src;
    }

    const originalMd = alt ? `![${alt}](${src})` : `![](${src})`;
    const blockId = generateBlockId(bookId, originalMd);

    return {
      id: blockId,
      bookId,
      index,
      docPath,
      type: 'image',
      originalMd,
      translatedMd: null,
      imageBase64,
      tagName,
      attributes,
    };
  }

  // For container elements (ul, ol, div) that contain block children, flatten them
  if (['ul', 'ol', 'table', 'figure', 'div'].includes(tagName)) {
    const childBlocks: Block[] = [];
    let childIndex = index;

    for (const child of node.childNodes) {
      if (child.nodeType === 3 && !child.textContent.trim()) continue;
      if (child.nodeType === 8) continue;

      const childTagName = child.tagName ? child.tagName.toLowerCase() : '';
      // Only extract block-level children, inline text goes to the parent
      if (BLOCK_TAGS.has(childTagName)) {
        const block = extractBlock(child, bookId, docPath, childIndex, turndown);
        if (block) {
          childBlocks.push(block);
          childIndex++;
        }
      } else if (childTagName === 'li') {
        const block = extractBlock(child, bookId, docPath, childIndex, turndown);
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
  const originalMd = turndown.turndown(html).trim();

  if (!originalMd) return null;

  const blockId = generateBlockId(bookId, originalMd);

  return {
    id: blockId,
    bookId,
    index,
    docPath,
    type,
    originalMd,
    translatedMd: null,
    imageBase64: null,
    tagName,
    attributes,
  };
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

/**
 * Extract all blocks from a ParsedEpub's content documents.
 */
export function extractAllBlocks(contentDocs: ContentDoc[], bookId: string): Block[] {
  const allBlocks: Block[] = [];
  let globalIndex = 0;

  for (const doc of contentDocs) {
    const docBlocks = extractBlocksFromDoc(doc, bookId);
    // Re-index globally across all docs
    for (const block of docBlocks) {
      block.index = globalIndex++;
      // Re-generate ID with global index context for uniqueness
      block.id = generateBlockId(bookId, `${block.docPath}:${globalIndex}:${block.originalMd}`);
      allBlocks.push(block);
    }
  }

  return allBlocks;
}
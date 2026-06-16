import MarkdownIt from 'markdown-it';
import type { Block } from '../types.js';
import type { TranslateDb } from '../db/database.js';

const md = new MarkdownIt({
  html: true,
  breaks: false,
  linkify: false,
  xhtmlOut: true,  // XHTML-compliant output: <img />, <br />, <hr />
});

// ── Custom rule: ++underline++ → <u>underline</u> ─────────────
// Match ++content++ — similar to **bold** but with plus signs
md.inline.ruler.push('underline', (state, silent) => {
  const start = state.pos;
  const marker = state.src.charCodeAt(start);

  // Must start with ++
  if (marker !== 0x2B /* + */) return false;
  if (state.src.charCodeAt(start + 1) !== 0x2B) return false;

  const max = state.posMax;

  // Find closing ++
  let pos = start + 2;
  while (pos < max - 1) {
    if (state.src.charCodeAt(pos) === 0x2B && state.src.charCodeAt(pos + 1) === 0x2B) {
      // Found closing ++
      if (!silent) {
        const token = state.push('underline_open', 'u', 1);
        token.markup = '++';
        const contentToken = state.push('text', '', 0);
        contentToken.content = state.src.slice(start + 2, pos);
        const closeToken = state.push('underline_close', 'u', -1);
        closeToken.markup = '++';
      }
      state.pos = pos + 2;
      return true;
    }
    pos++;
  }
  return false;
});

/**
 * BlockType → default HTML tag mapping.
 */
const TYPE_TO_TAG: Record<string, string> = {
  heading: 'h2',
  paragraph: 'p',
  image: 'p',
  list_item: 'li',
  quote: 'blockquote',
  code: 'pre',
  table_row: 'tr',
  page_break: 'div',
  other: 'p',
};

/**
 * Heading level detection from Markdown (e.g. "## Title" → h2).
 */
function headingLevel(mdText: string): string {
  const match = mdText.match(/^(#{1,6})\s/);
  if (match) {
    return `h${match[1].length}`;
  }
  return 'h2';
}

/**
 * Convert a single Block back to an HTML string.
 * Uses translatedMd if available, falls back to originalMd.
 *
 * @param block - Block to convert
 * @param db - Optional database for resolving file references
 * @param bookId - Optional book ID for file resolution
 * @param fileResolver - Optional function to resolve file:ID → URL/path.
 *                       If not provided, uses /files/ID web paths.
 */
export function blockToHtml(block: Block, db?: TranslateDb, bookId?: string, fileResolver?: (fileId: string) => string): string {
  const mdText = block.translatedMd ?? block.originalMd;
  let tagName = block.tagName || TYPE_TO_TAG[block.type] || 'p';

  // For headings, detect level from Markdown syntax
  if (block.type === 'heading') {
    tagName = headingLevel(mdText);
  }

  // Handle page breaks — emit a div with page-break-before style
  if (block.type === 'page_break') {
    return `<div style="page-break-before:always"/>`;
  }

  // For image blocks, resolve file:ID references
  if (block.type === 'image') {
    let resolvedMd = mdText;

    // Replace file:ID references with resolved URLs/paths
    resolvedMd = resolvedMd.replace(/!\[([^\]]*)\]\(file:([^)]+)\)/g, (_match, alt, fileId) => {
      if (fileResolver) {
        return `![${alt}](${fileResolver(fileId)})`;
      }
      // Default: serve files via the web API
      return `![${alt}](/files/${fileId})`;
    });

    // Parse Markdown → HTML for the image
    let htmlContent = md.render(resolvedMd).trim();

    // Ensure XHTML compliance: self-close <img />, <br />, <hr />
    htmlContent = xhtmlFix(htmlContent);

    // md.render wraps in <p> tags — always strip for image blocks
    // (we provide our own wrapper below)
    if (htmlContent.startsWith('<p>') && htmlContent.endsWith('</p>')) {
      htmlContent = htmlContent.slice(3, -4).trim();
    }

    const attrs = parseAttributes(block.attributes);
    if (attrs.class || attrs.style) {
      const attrStr = formatAttrs(attrs);
      return `<p${attrStr}>${htmlContent}</p>`;
    }
    return `<p>${htmlContent}</p>`;
  }

  // Resolve image references in markdown for ALL block types (not just 'image')
  // Handles both file:ID and original paths like ../images/x.jpg
  let resolvedMdText = mdText;
  if (fileResolver) {
    resolvedMdText = resolvedMdText.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, src) => {
      return `![${alt}](${fileResolver(src)})`;
    });
  }

  // Parse Markdown → HTML
  let htmlContent = md.render(resolvedMdText).trim();

  // Ensure XHTML compliance: self-close void elements
  htmlContent = xhtmlFix(htmlContent);

  // md.render wraps inline content in <p> tags — strip if our wrapper tag matches
  // to avoid double-wrapping like <p class="x"><p>text</p></p>
  const mdWrapperMatch = htmlContent.match(/^<(\w+)([^>]*)>/);
  const mdWrapperTag = mdWrapperMatch?.[1];
  const openTagLen = mdWrapperMatch?.[0]?.length ?? 0;
  if (mdWrapperTag === tagName && htmlContent.endsWith(`</${mdWrapperTag}>`)) {
    htmlContent = htmlContent.slice(openTagLen, htmlContent.length - `</${mdWrapperTag}>`.length).trim();
  }

  // For list items, Markdown renders as <li> already
  if (block.type === 'list_item') {
    const attrs = parseAttributes(block.attributes);
    const attrStr = formatAttrs(attrs);
    return `<li${attrStr}>${htmlContent}</li>`;
  }

  // For code blocks, Markdown renders as <pre><code>...</code></pre>
  if (block.type === 'code') {
    return htmlContent;
  }

  // Build the HTML element with preserved attributes
  const attrs = parseAttributes(block.attributes);
  // Don't duplicate class/id on the inner content — they belong on the wrapper
  const structuralAttrs: Record<string, string> = {};
  const skipAttrs = ['href', 'src', 'alt', 'title'];
  for (const [key, val] of Object.entries(attrs)) {
    if (!skipAttrs.includes(key)) {
      structuralAttrs[key] = val;
    }
  }
  const attrStr = formatAttrs(structuralAttrs);

  return `<${tagName}${attrStr}>${htmlContent}</${tagName}>`;
}

/**
 * Reassemble a content document's HTML from its blocks.
 * Produces a complete XHTML body content.
 *
 * @param blocks - Blocks to assemble
 * @param db - Optional database
 * @param bookId - Optional book ID
 * @param fileResolver - Optional function to resolve file:ID → path/URL
 */
export function assembleDocHtml(blocks: Block[], db?: TranslateDb, bookId?: string, fileResolver?: (fileId: string) => string): string {
  const parts = blocks.map(b => blockToHtml(b, db, bookId, fileResolver));
  return parts.join('\n');
}

/**
 * Reassemble a full XHTML document for a content doc.
 * Wraps the block HTML in a proper XHTML template.
 */
export function assembleXhtmlDoc(blocks: Block[], docPath: string, db?: TranslateDb, bookId?: string, fileResolver?: (fileId: string) => string): string {
  const bodyContent = assembleDocHtml(blocks, db, bookId, fileResolver);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>${docPath}</title>
</head>
<body>
${bodyContent}
</body>
</html>`;
}

/**
 * Parse attributes JSON string back to an object.
 */
function parseAttributes(attrsJson: string): Record<string, string> {
  try {
    return JSON.parse(attrsJson || '{}');
  } catch {
    return {};
  }
}

/**
 * Format an attributes object as an HTML attribute string.
 */
function formatAttrs(attrs: Record<string, string>): string {
  const parts = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}="${escapeAttr(v)}"`);
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

/**
 * Escape an HTML attribute value.
 */
function escapeAttr(val: string): string {
  return val
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Fix HTML for XHTML compliance: self-close void elements.
 * Converts `<img ...>` → `<img ... />`, `<br>` → `<br />`, `<hr>` → `<hr />`,
 * `<input ...>` → `<input ... />`, etc.
 */
function xhtmlFix(html: string): string {
  const voidElements = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'];
  for (const tag of voidElements) {
    // Match <tag ...> but NOT already <tag .../> or <tag ... />
    const re = new RegExp(`<${tag}(\\s[^>]*)?>(?!\\s*</${tag}>)`, 'gi');
    html = html.replace(re, (match, attrs) => {
      // Already self-closed?
      if (match.endsWith('/>')) return match;
      return `<${tag}${attrs || ''} />`;
    });
  }
  return html;
}
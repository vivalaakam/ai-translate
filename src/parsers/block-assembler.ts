import MarkdownIt from 'markdown-it';
import type { Block } from '../types.js';

const md = new MarkdownIt({
  html: true,
  breaks: false,
  linkify: false,
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
 */
export function blockToHtml(block: Block): string {
  const mdText = block.translatedMd ?? block.originalMd;
  let tagName = block.tagName || TYPE_TO_TAG[block.type] || 'p';

  // For headings, detect level from Markdown syntax
  if (block.type === 'heading') {
    tagName = headingLevel(mdText);
  }

  // Parse Markdown → HTML
  let htmlContent = md.render(mdText).trim();

  // md.render wraps in <p> tags — strip the outer <p> if our target tag isn't <p>
  if (tagName !== 'p' && htmlContent.startsWith('<p>') && htmlContent.endsWith('</p>')) {
    htmlContent = htmlContent.slice(3, -4).trim();
  }

  // For images, the Markdown renders as <img> already — wrap appropriately
  if (block.type === 'image') {
    const attrs = parseAttributes(block.attributes);
    if (attrs.class || attrs.style) {
      const attrStr = formatAttrs(attrs);
      return `<p${attrStr}>${htmlContent}</p>`;
    }
    return `<p>${htmlContent}</p>`;
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
 */
export function assembleDocHtml(blocks: Block[]): string {
  const parts = blocks.map(blockToHtml);
  return parts.join('\n');
}

/**
 * Reassemble a full XHTML document for a content doc.
 * Wraps the block HTML in a proper XHTML template.
 */
export function assembleXhtmlDoc(blocks: Block[], docPath: string): string {
  const bodyContent = assembleDocHtml(blocks);
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
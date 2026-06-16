import { XMLParser } from 'fast-xml-parser';
import { parse as parseHtml } from 'node-html-parser';
import fs from 'fs';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

/**
 * Parse an FB2 (FictionBook2) file and convert its sections
 * into a format compatible with EpubParser output.
 */
export class Fb2Parser {
  /**
   * @param {string} filePath - Path to the .fb2 file
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.metadata = null;
    this.contentDocs = [];
    this.rawXml = null;
    this.parsedXml = null;
  }

  /**
   * Parse the FB2 file and extract content.
   * @returns {Promise<{metadata: object, contentDocs: Array}>}
   */
  async parse() {
    this.rawXml = fs.readFileSync(this.filePath, 'utf8');
    this.parsedXml = xmlParser.parse(this.rawXml);

    this._extractMetadata();
    this.contentDocs = this._extractContentDocs();

    return {
      metadata: this.metadata,
      contentDocs: this.contentDocs,
    };
  }

  /**
   * Get metadata from the FB2.
   * @returns {Promise<{title: string, author: string, language: string}>}
   */
  async getMetadata() {
    if (!this.metadata) {
      await this.parse();
    }
    return this.metadata;
  }

  /**
   * Extract metadata from FB2 description.
   * @private
   */
  _extractMetadata() {
    const fb = this.parsedXml?.FictionBook;
    if (!fb) {
      this.metadata = { title: 'Unknown', author: 'Unknown', language: 'en' };
      return;
    }

    const desc = fb.description;
    const titleInfo = desc?.['title-info'];

    const title = titleInfo?.['book-title'] || 'Unknown';
    const firstName = titleInfo?.author?.['first-name'] || '';
    const lastName = titleInfo?.author?.['last-name'] || '';
    const author = [firstName, lastName].filter(Boolean).join(' ') || 'Unknown';
    const lang = titleInfo?.lang || 'en';

    this.metadata = {
      title: typeof title === 'string' ? title : 'Unknown',
      author,
      language: typeof lang === 'string' ? lang : 'en',
    };
  }

  /**
   * Extract content from FB2 body sections.
   * @private
   */
  _extractContentDocs() {
    const docs = [];
    const fb = this.parsedXml?.FictionBook;
    if (!fb) return docs;

    const bodies = this._asArray(fb.body || []);
    for (const body of bodies) {
      const isNotes = body?.['@_name'] === 'notes';
      const sections = this._asArray(body?.section || []);

      for (const section of sections) {
        const sectionTitle = this._extractSectionTitle(section);
        const htmlContent = this._sectionToHtml(section, sectionTitle);

        const dom = parseHtml(htmlContent, {
          comment: true,
          voidTag: { closingSlash: true },
        });

        docs.push({
          path: isNotes ? `notes_${docs.length}.xhtml` : `section_${docs.length}.xhtml`,
          dom,
          rawContent: htmlContent,
          sectionTitle,
          isNotes,
        });
      }
    }

    return docs;
  }

  /**
   * Convert FB2 section to XHTML.
   * @private
   */
  _sectionToHtml(section, title) {
    const titleHtml = title ? `<h1>${this._escapeHtml(title)}</h1>\n` : '';
    const bodyContent = this._convertSection(section);

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>${this._escapeHtml(title || 'Section')}</title>
</head>
<body>
${titleHtml}${bodyContent}
</body>
</html>`;
  }

  /**
   * Recursively convert an FB2 section to HTML body content.
   * @private
   */
  _convertSection(section) {
    if (!section || typeof section === 'string') {
      return typeof section === 'string' ? this._escapeHtml(section) : '';
    }

    let html = '';

    // Process each key in the section
    for (const [key, value] of Object.entries(section)) {
      if (key.startsWith('@_')) continue; // skip attributes

      if (key === 'title') {
        // Skip title — it's already extracted as <h1>
        continue;
      }

      const items = this._asArray(value);
      for (const item of items) {
        html += this._convertElement(key, item);
      }
    }

    return html;
  }

  /**
   * Convert a single FB2 element to HTML.
   * @private
   */
  _convertElement(tagName, value) {
    const tagMap = {
      'p': 'p',
      'section': 'div',
      'subtitle': 'h2',
      'strong': 'strong',
      'emphasis': 'em',
      'style': 'span',
      'a': 'a',
      'image': 'img',
      'poem': 'div',
      'stanza': 'div',
      'v': 'p',
      'text-author': 'p',
      'date': 'p',
      'epigraph': 'blockquote',
      'annotation': 'div',
      'cite': 'blockquote',
      'empty-line': 'br',
      'table': 'table',
      'tr': 'tr',
      'td': 'td',
      'th': 'th',
    };

    const htmlTag = tagMap[tagName] || 'div';

    // Handle empty-line as self-closing
    if (tagName === 'empty-line') {
      return '<br/>\n';
    }

    // Handle nested sections recursively
    if (tagName === 'section') {
      const inner = this._convertSection(value);
      return `<div class="section">\n${inner}</div>\n`;
    }

    // Get text content
    let content;
    if (typeof value === 'string') {
      content = this._escapeHtml(value);
    } else if (value === null || value === undefined) {
      content = '';
    } else {
      // Recursively convert child elements
      content = this._convertChildren(value);
    }

    // Handle attributes
    let attrs = '';
    if (typeof value === 'object' && value !== null) {
      if (value['@_xlink:href']) {
        attrs = ` href="${this._escapeHtml(value['@_xlink:href'])}"`;
      } else if (value['@_href']) {
        attrs = ` href="${this._escapeHtml(value['@_href'])}"`;
      }
    }

    return `<${htmlTag}${attrs}>${content}</${htmlTag}>\n`;
  }

  /**
   * Recursively convert children of an element.
   * @private
   */
  _convertChildren(obj) {
    if (typeof obj === 'string') {
      return this._escapeHtml(obj);
    }

    if (obj['#text']) {
      // Element with both text and child elements
      let text = this._escapeHtml(String(obj['#text']));
      for (const [key, value] of Object.entries(obj)) {
        if (key === '#text' || key.startsWith('@_')) continue;
        const items = this._asArray(value);
        for (const item of items) {
          text += this._convertElement(key, item);
        }
      }
      return text;
    }

    let html = '';
    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith('@_')) continue;
      const items = this._asArray(value);
      for (const item of items) {
        html += this._convertElement(key, item);
      }
    }
    return html;
  }

  /**
   * Extract section title from FB2 <title> element.
   * @private
   */
  _extractSectionTitle(section) {
    if (!section || typeof section === 'string') return null;

    const title = section.title;
    if (!title) return null;

    const paragraphs = this._asArray(title.p || []);
    return paragraphs
      .map(p => typeof p === 'string' ? p : this._extractTextValue(p))
      .filter(Boolean)
      .join(' ');
  }

  // --- Utility methods ---

  _asArray(val) {
    if (val === undefined || val === null) return [];
    return Array.isArray(val) ? val : [val];
  }

  _extractTextValue(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (node['#text']) return String(node['#text']);
    // Try nested values
    for (const val of Object.values(node)) {
      if (typeof val === 'string') return val;
      if (val?.['#text']) return String(val['#text']);
    }
    return '';
  }

  _escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
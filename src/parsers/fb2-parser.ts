import { XMLParser } from 'fast-xml-parser';
import { parse as parseHtml } from 'node-html-parser';
import fs from 'fs';
import type { BookMetadata, ContentDoc, ExtractedImage, ParsedEpub } from '../types.js';

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
  private filePath: string;
  private metadata: BookMetadata | null = null;
  private contentDocs: ContentDoc[] = [];
  private images: ExtractedImage[] = [];
  private rawXml: string | null = null;
  private parsedXml: Record<string, any> | null = null;

  /**
   * @param filePath - Path to the .fb2 file
   */
  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Parse the FB2 file and extract content.
   */
  async parse(): Promise<ParsedEpub> {
    this.rawXml = fs.readFileSync(this.filePath, 'utf8');
    this.parsedXml = xmlParser.parse(this.rawXml) as Record<string, any>;

    this._extractMetadata();
    this.contentDocs = this._extractContentDocs();
    this.images = this._extractImages();

    return {
      metadata: this.metadata!,
      contentDocs: this.contentDocs,
      images: this.images,
    };
  }

  /**
   * Get metadata from the FB2.
   */
  async getMetadata(): Promise<BookMetadata> {
    if (!this.metadata) {
      await this.parse();
    }
    return this.metadata!;
  }

  /**
   * Extract metadata from FB2 description.
   * @private
   */
  private _extractMetadata(): void {
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
  private _extractContentDocs(): ContentDoc[] {
    const docs: ContentDoc[] = [];
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
   * Extract binary images from FB2 <binary> elements.
   * FB2 stores images as base64-encoded data in <binary id="..." content-type="..."> elements.
   * @private
   */
  private _extractImages(): ExtractedImage[] {
    const images: ExtractedImage[] = [];
    const fb = this.parsedXml?.FictionBook;
    if (!fb) return images;

    // <binary> elements can be a single object or an array
    const binaries = this._asArray(fb.binary || []);

    for (const bin of binaries) {
      if (!bin) continue;

      const id = bin['@_id'] || '';
      const contentType = bin['@_content-type'] || 'image/jpeg';
      // The base64 data can be in #text or as a string directly
      const base64Data = typeof bin === 'string' ? bin : (bin['#text'] || bin['@_value'] || '');

      if (!id || !base64Data) continue;

      try {
        const data = Buffer.from(base64Data.trim(), 'base64');
        // Determine file extension from content type
        const extMap: Record<string, string> = {
          'image/jpeg': '.jpg',
          'image/png': '.png',
          'image/gif': '.gif',
          'image/svg+xml': '.svg',
          'image/webp': '.webp',
        };
        const ext = extMap[contentType] || '.jpg';
        // Use #id as the path (FB2 references images via xlink:href="#id")
        const originalPath = `#${id}${ext}`;

        images.push({
          originalPath,
          data,
          mimeType: contentType,
        });
      } catch {
        // Skip invalid base64 data
      }
    }

    return images;
  }

  /**
   * Convert FB2 section to XHTML.
   * @private
   */
  private _sectionToHtml(section: any, title: string | null): string {
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
  private _convertSection(section: any): string {
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
  private _convertElement(tagName: string, value: any): string {
    const tagMap: Record<string, string> = {
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

    // Handle <image> elements in FB2 — convert to <img> with xlink:href
    if (tagName === 'image') {
      const href = value?.['@_xlink:href'] || value?.['@_href'] || '';
      const src = href.startsWith('#') ? href : `#${href}`;
      const alt = value?.['@_alt'] || value?.['@_title'] || '';
      return `<img src="${this._escapeHtml(src)}" alt="${this._escapeHtml(alt)}"/>\n`;
    }

    // Get text content
    let content: string;
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
  private _convertChildren(obj: any): string {
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
  private _extractSectionTitle(section: any): string | null {
    if (!section || typeof section === 'string') return null;

    const title = section.title;
    if (!title) return null;

    const paragraphs = this._asArray(title.p || []);
    return paragraphs
      .map((p: any) => typeof p === 'string' ? p : this._extractTextValue(p))
      .filter(Boolean)
      .join(' ');
  }

  // --- Utility methods ---

  private _asArray(val: any): any[] {
    if (val === undefined || val === null) return [];
    return Array.isArray(val) ? val : [val];
  }

  private _extractTextValue(node: any): string {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (node['#text']) return String(node['#text']);
    // Try nested values
    for (const val of Object.values(node)) {
      if (typeof val === 'string') return val;
      if ((val as any)?.['#text']) return String((val as any)['#text']);
    }
    return '';
  }

  private _escapeHtml(str: string | null | undefined): string {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
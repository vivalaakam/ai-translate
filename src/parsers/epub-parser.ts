import AdmZip from 'adm-zip';
import { parse as parseHtml } from 'node-html-parser';
import { XMLParser } from 'fast-xml-parser';
import path from 'path';
import type { BookMetadata, ContentDoc, ManifestItem, ParsedEpub } from '../types.js';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

/**
 * Parse an EPUB file into its constituent XHTML content documents.
 * EPUB is a ZIP archive containing XHTML files referenced by a spine in content.opf.
 */
export class EpubParser {
  private filePath: string;
  private zip: AdmZip | null = null;
  private metadata: BookMetadata | null = null;
  private contentDocs: ContentDoc[] = [];
  private contentOpfPath: string | null = null;
  private manifest: Record<string, ManifestItem> = {};
  private spine: string[] = [];

  /**
   * @param filePath - Path to the .epub file
   */
  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Parse the EPUB and extract all content documents.
   */
  async parse(): Promise<ParsedEpub> {
    this.zip = new AdmZip(this.filePath);

    // 1. Find content.opf path from container.xml
    this.contentOpfPath = this._findContentOpfPath();

    // 2. Parse content.opf for metadata, manifest, and spine
    this._parseContentOpf();

    // 3. Extract content documents in spine order
    this.contentDocs = this._extractContentDocs();

    return {
      metadata: this.metadata!,
      contentDocs: this.contentDocs,
      _zip: this.zip,
    };
  }

  /**
   * Get ordered list of XHTML file paths from the spine.
   */
  async getContentDocPaths(): Promise<string[]> {
    if (!this.contentOpfPath) {
      await this.parse();
    }
    return this.spine.map(id => this.manifest[id]?.href).filter(Boolean) as string[];
  }

  /**
   * Get metadata from the EPUB.
   */
  async getMetadata(): Promise<BookMetadata> {
    if (!this.metadata) {
      await this.parse();
    }
    return this.metadata!;
  }

  /**
   * Get the raw zip for writing back.
   */
  getZip(): AdmZip | null {
    return this.zip;
  }

  /**
   * Find the path to content.opf from META-INF/container.xml
   * @private
   */
  private _findContentOpfPath(): string {
    const containerEntry = this.zip!.getEntry('META-INF/container.xml');
    if (!containerEntry) {
      throw new Error('Invalid EPUB: missing META-INF/container.xml');
    }

    const containerXml = containerEntry.getData().toString('utf8');
    const parsed = xmlParser.parse(containerXml) as Record<string, any>;

    // Navigate to rootfile full-path
    let opfPath: string | null = null;
    try {
      const container = parsed.container;
      const rootfiles = container.rootfiles?.rootfile || container.rootfiles?.[0]?.rootfile;
      if (Array.isArray(rootfiles)) {
        opfPath = rootfiles[0]?.['@_full-path'];
      } else if (rootfiles) {
        opfPath = rootfiles['@_full-path'] || rootfiles[0]?.['@_full-path'];
      }
    } catch {
      // Fallback: try regex
      const match = containerXml.match(/full-path="([^"]+)"/);
      if (match) {
        opfPath = match[1];
      }
    }

    if (!opfPath) {
      // Last resort: try common path
      opfPath = 'OEBPS/content.opf';
    }

    return opfPath;
  }

  /**
   * Parse content.opf for metadata, manifest, and spine.
   * @private
   */
  private _parseContentOpf(): void {
    const opfEntry = this.zip!.getEntry(this.contentOpfPath!);
    if (!opfEntry) {
      throw new Error(`Invalid EPUB: missing ${this.contentOpfPath}`);
    }

    const opfXml = opfEntry.getData().toString('utf8');
    const parsed = xmlParser.parse(opfXml) as Record<string, any>;

    const pkg = parsed.package;

    // Extract metadata
    const metadataEl = pkg?.metadata;
    this.metadata = {
      title: this._extractText(metadataEl?.['dc:title'] || metadataEl?.title) || 'Unknown',
      author: this._extractText(metadataEl?.['dc:creator'] || metadataEl?.creator) || 'Unknown',
      language: this._extractText(metadataEl?.['dc:language'] || metadataEl?.language) || 'en',
    };

    // Handle array or single value for title/creator/language
    if (Array.isArray(this.metadata.title)) {
      this.metadata.title = this.metadata.title[0];
    }
    if (Array.isArray(this.metadata.author)) {
      this.metadata.author = this.metadata.author[0];
    }
    if (Array.isArray(this.metadata.language)) {
      this.metadata.language = this.metadata.language[0];
    }

    // Extract manifest
    const manifestItems = pkg?.manifest?.item || [];
    const items = Array.isArray(manifestItems) ? manifestItems : [manifestItems];
    this.manifest = {};
    for (const item of items) {
      if (item?.['@_id'] && item?.['@_href']) {
        this.manifest[item['@_id']] = {
          href: item['@_href'],
          mediaType: item['@_media-type'] || '',
          properties: item['@_properties'] || '',
        };
      }
    }

    // Extract spine
    const spineItems = pkg?.spine?.itemref || [];
    const refs = Array.isArray(spineItems) ? spineItems : [spineItems];
    this.spine = refs.map((item: any) => item?.['@_idref']).filter(Boolean);

    // If spine is empty, use all XHTML items from manifest
    if (this.spine.length === 0) {
      this.spine = Object.entries(this.manifest)
        .filter(([, val]) => val.mediaType === 'application/xhtml+xml')
        .map(([id]) => id);
    }
  }

  /**
   * Extract text from metadata elements that can be string or array.
   * @private
   */
  private _extractText(value: any): string {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value[0];
    if (typeof value === 'object' && value['#text']) return value['#text'];
    return String(value);
  }

  /**
   * Extract content documents in spine order.
   * @private
   */
  private _extractContentDocs(): ContentDoc[] {
    const opfDir = path.dirname(this.contentOpfPath!);
    const docs: ContentDoc[] = [];

    for (const id of this.spine) {
      const item = this.manifest[id];
      if (!item) continue;

      const fullPath = path.posix.join(opfDir, item.href);
      const entry = this.zip!.getEntry(fullPath);

      if (!entry) {
        // Try the href directly
        const altEntry = this.zip!.getEntry(item.href);
        if (altEntry) {
          const rawContent = altEntry.getData().toString('utf8');
          const dom = parseHtml(rawContent, {
            comment: true,
            voidTag: { closingSlash: true },
          });
          docs.push({ path: item.href, dom, rawContent });
        }
        continue;
      }

      const rawContent = entry.getData().toString('utf8');
      const dom = parseHtml(rawContent, {
        comment: true,
        voidTag: { closingSlash: true },
      });
      docs.push({ path: fullPath, dom, rawContent });
    }

    return docs;
  }
}
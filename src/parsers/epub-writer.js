import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';

/**
 * Write a parsed EPUB structure back to a valid EPUB file.
 * Only modifies content documents that were explicitly updated;
 * all other entries (CSS, images, fonts) are preserved byte-for-byte.
 */
export class EpubWriter {
  /**
   * @param {object} parsedEpub - Output from EpubParser.parse()
   */
  constructor(parsedEpub) {
    this.metadata = parsedEpub.metadata;
    this.contentDocs = parsedEpub.contentDocs;
    this.zip = parsedEpub._zip;
    this.updatedEntries = [];
  }

  /**
   * Update a content document's HTML.
   * @param {string} contentPath - Path within the EPUB (e.g., "OEBPS/chapter1.xhtml")
   * @param {string} newHtml - New HTML content
   */
  updateContentDoc(contentPath, newHtml) {
    this.updatedEntries.push({
      path: contentPath,
      content: newHtml,
    });
  }

  /**
   * Write the EPUB to a file.
   * @param {string} outputPath - Path to write the EPUB file
   */
  async write(outputPath) {
    // Ensure output directory exists
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Create a new ZIP
    const newZip = new AdmZip();

    // Track which paths we've updated
    const updatedPaths = new Map();
    for (const entry of this.updatedEntries) {
      updatedPaths.set(entry.path, entry.content);
    }

    // First entry MUST be mimetype (uncompressed, no compression)
    const MIMETYPE = 'application/epub+zip';
    newZip.addFile('mimetype', Buffer.from(MIMETYPE, 'utf8'), '', 0); // stored, not compressed

    // Process all entries from the original ZIP except mimetype
    const originalEntries = this.zip.getEntries();
    for (const entry of originalEntries) {
      if (entry.entryName === 'mimetype') continue; // already added

      const normalizedPath = entry.entryName.replace(/\\/g, '/');
      const updatedContent = updatedPaths.get(normalizedPath) ||
                             updatedPaths.get(entry.entryName);

      if (updatedContent) {
        // Use the updated content
        newZip.addFile(
          entry.entryName,
          Buffer.from(updatedContent, 'utf8'),
          '', // comment
          8  // deflate compression
        );
      } else {
        // Preserve original content byte-for-byte
        newZip.addFile(
          entry.entryName,
          entry.getData(),
          '', // comment
          entry.header.method || 8  // preserve compression method, default to deflate
        );
      }
    }

    // Write to disk
    newZip.writeZip(outputPath);
  }
}
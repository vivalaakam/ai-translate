import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EpubParser } from '../../src/parsers/epub-parser.js';
import { EpubWriter } from '../../src/parsers/epub-writer.js';
import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const SAMPLE_EPUB = path.join(FIXTURES_DIR, 'sample.epub');
const OUTPUT_DIR = path.join(FIXTURES_DIR, 'output');

describe('EpubWriter', () => {
  let parsedEpub;

  beforeAll(async () => {
    const parser = new EpubParser(SAMPLE_EPUB);
    parsedEpub = await parser.parse();
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  });

  afterAll(() => {
    // Clean up output directory
    if (fs.existsSync(OUTPUT_DIR)) {
      fs.rmSync(OUTPUT_DIR, { recursive: true });
    }
  });

  describe('updateContentDoc', () => {
    it('should update a content document by path', () => {
      const writer = new EpubWriter(parsedEpub);

      const firstDoc = parsedEpub.contentDocs[0];
      const pElements = firstDoc.dom.querySelectorAll('p');
      pElements[0].textContent = 'Translated Hello world';

      writer.updateContentDoc(firstDoc.path, firstDoc.dom.outerHTML);

      expect(writer.updatedEntries.length).toBeGreaterThan(0);
    });

    it('should track which paths have been modified', () => {
      const writer = new EpubWriter(parsedEpub);
      const firstDoc = parsedEpub.contentDocs[0];

      writer.updateContentDoc(firstDoc.path, '<html>updated</html>');

      const updatedPaths = writer.updatedEntries.map(e => e.path);
      expect(updatedPaths).toContain(firstDoc.path);
    });
  });

  describe('write', () => {
    it('should produce a valid EPUB file', async () => {
      const writer = new EpubWriter(parsedEpub);

      const firstDoc = parsedEpub.contentDocs[0];
      const pElements = firstDoc.dom.querySelectorAll('p');
      if (pElements.length > 0) {
        pElements[0].textContent = 'Hola mundo';
      }
      writer.updateContentDoc(firstDoc.path, firstDoc.dom.outerHTML);

      const outputPath = path.join(OUTPUT_DIR, 'test_written.epub');
      await writer.write(outputPath);

      expect(fs.existsSync(outputPath)).toBe(true);

      // Verify it's a valid ZIP
      const zip = new AdmZip(outputPath);
      const entries = zip.getEntries();
      expect(entries.length).toBeGreaterThan(0);

      // Verify mimetype entry exists and is correct
      const mimetypeEntry = entries.find(e => e.entryName === 'mimetype');
      expect(mimetypeEntry).not.toBeNull();
      expect(mimetypeEntry.getData().toString('utf8')).toBe('application/epub+zip');
    });

    it('should round-trip: parse → modify → write → re-parse with changes preserved', async () => {
      // Parse original
      const parser1 = new EpubParser(SAMPLE_EPUB);
      const original = await parser1.parse();

      // Modify text
      const firstDoc = original.contentDocs[0];
      const pElements = firstDoc.dom.querySelectorAll('p');
      const originalText = pElements[0].textContent;
      pElements[0].textContent = 'Translated text';

      // Write
      const writer = new EpubWriter(original);
      writer.updateContentDoc(firstDoc.path, firstDoc.dom.outerHTML);

      const outputPath = path.join(OUTPUT_DIR, 'roundtrip.epub');
      await writer.write(outputPath);

      // Re-parse
      const parser2 = new EpubParser(outputPath);
      const reparsed = await parser2.parse();

      // Verify text was changed
      const reparsedFirstDoc = reparsed.contentDocs[0];
      const reparsedP = reparsedFirstDoc.dom.querySelectorAll('p');
      expect(reparsedP[0].textContent).toBe('Translated text');
      expect(reparsedP[0].textContent).not.toBe(originalText);

      // Verify structure preserved (same number of chapters)
      expect(reparsed.contentDocs.length).toBe(original.contentDocs.length);

      // Verify metadata preserved
      expect(reparsed.metadata.title).toBe(original.metadata.title);
    });

    it('should preserve non-content files (CSS, images)', async () => {
      const writer = new EpubWriter(parsedEpub);

      const outputPath = path.join(OUTPUT_DIR, 'preserve_css.epub');
      await writer.write(outputPath);

      // Re-parse and check CSS is present
      const zip = new AdmZip(outputPath);
      const cssEntry = zip.getEntry('OEBPS/style.css');
      expect(cssEntry).not.toBeNull();
      expect(cssEntry.getData().toString('utf8')).toContain('font-family');
    });
  });
});
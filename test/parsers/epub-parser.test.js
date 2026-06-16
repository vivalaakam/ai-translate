import { describe, it, expect, beforeAll } from 'vitest';
import { EpubParser } from '../../src/parsers/epub-parser.js';
import AdmZip from 'adm-zip';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const SAMPLE_EPUB = path.join(FIXTURES_DIR, 'sample.epub');

describe('EpubParser', () => {
  let parser;

  beforeAll(() => {
    parser = new EpubParser(SAMPLE_EPUB);
  });

  describe('parse', () => {
    let result;

    beforeAll(async () => {
      result = await parser.parse();
    });

    it('should extract metadata', () => {
      expect(result.metadata.title).toBe('Test Book');
      expect(result.metadata.author).toBe('Test Author');
      expect(result.metadata.language).toBe('en');
    });

    it('should return content documents from the spine', () => {
      expect(result.contentDocs.length).toBeGreaterThan(0);
    });

    it('should include the path for each content document', () => {
      for (const doc of result.contentDocs) {
        expect(doc.path).toBeTruthy();
        expect(doc.path).toMatch(/\.xhtml$/);
      }
    });

    it('should include parsed HTML for each content document', () => {
      for (const doc of result.contentDocs) {
        expect(doc.dom).toBeTruthy();
      }
    });

    it('should preserve the raw document content', () => {
      for (const doc of result.contentDocs) {
        expect(doc.rawContent).toBeTruthy();
      }
    });
  });

  describe('getContentDocPaths', () => {
    it('should return ordered list of XHTML paths from the spine', async () => {
      const paths = await parser.getContentDocPaths();
      expect(paths.length).toBeGreaterThan(0);
      expect(paths[0]).toMatch(/chapter1\.xhtml$/);
    });
  });

  describe('getMetadata', () => {
    it('should return title, author, language', async () => {
      const metadata = await parser.getMetadata();
      expect(metadata.title).toBe('Test Book');
      expect(metadata.author).toBe('Test Author');
      expect(metadata.language).toBe('en');
    });
  });

  describe('text extraction', () => {
    it('should find text nodes within paragraphs', async () => {
      const result = await parser.parse();
      const allText = result.contentDocs
        .map(doc => doc.dom.textContent)
        .join(' ');
      expect(allText).toContain('Hello world');
      expect(allText).toContain('This is a test paragraph.');
    });
  });

  describe('error handling', () => {
    it('should throw on non-existent file', async () => {
      const badParser = new EpubParser('/nonexistent/file.epub');
      await expect(badParser.parse()).rejects.toThrow();
    });
  });
});
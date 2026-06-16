import { describe, it, expect, beforeAll } from 'vitest';
import { Fb2Parser } from '../../src/parsers/fb2-parser.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const SAMPLE_FB2 = path.join(FIXTURES_DIR, 'sample.fb2');

describe('Fb2Parser', () => {
  let parser;

  beforeAll(() => {
    parser = new Fb2Parser(SAMPLE_FB2);
  });

  describe('parse', () => {
    let result;

    beforeAll(async () => {
      result = await parser.parse();
    });

    it('should extract metadata', () => {
      expect(result.metadata.title).toBe('Test Book FB2');
      expect(result.metadata.author).toBe('Test Author');
      expect(result.metadata.language).toBe('en');
    });

    it('should return content sections from the body', () => {
      expect(result.contentDocs.length).toBeGreaterThan(0);
    });

    it('should include parsed DOM for each section', () => {
      for (const doc of result.contentDocs) {
        expect(doc.dom).toBeTruthy();
      }
    });

    it('should preserve raw content', () => {
      for (const doc of result.contentDocs) {
        expect(doc.rawContent).toBeTruthy();
      }
    });

    it('should identify section titles', () => {
      const titles = result.contentDocs
        .filter(doc => doc.sectionTitle)
        .map(doc => doc.sectionTitle);
      expect(titles).toContain('Chapter 1');
      expect(titles).toContain('Chapter 2');
    });
  });

  describe('getMetadata', () => {
    it('should return title, author, language', async () => {
      const metadata = await parser.getMetadata();
      expect(metadata.title).toBe('Test Book FB2');
      expect(metadata.author).toBe('Test Author');
      expect(metadata.language).toBe('en');
    });
  });

  describe('text extraction', () => {
    it('should find text content within paragraphs', async () => {
      const result = await parser.parse();
      const allText = result.contentDocs
        .map(doc => doc.dom.textContent)
        .join(' ');
      expect(allText).toContain('Hello world from FB2');
      expect(allText).toContain('test paragraph');
    });

    it('should preserve inline formatting tags', async () => {
      const result = await parser.parse();
      const mainSections = result.contentDocs.filter(doc => !doc.isNotes);
      const html = mainSections.map(doc => doc.dom.innerHTML).join(' ');
      expect(html).toContain('strong');
      expect(html).toContain('<em>'); // FB2 <emphasis> converts to <em>
    });
  });

  describe('error handling', () => {
    it('should throw on non-existent file', async () => {
      const badParser = new Fb2Parser('/nonexistent/file.fb2');
      await expect(badParser.parse()).rejects.toThrow();
    });
  });
});
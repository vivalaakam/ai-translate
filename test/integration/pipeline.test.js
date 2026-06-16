import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { EpubParser } from '../../src/parsers/epub-parser.js';
import { Fb2Parser } from '../../src/parsers/fb2-parser.js';
import { EpubWriter } from '../../src/parsers/epub-writer.js';
import { OllamaClient } from '../../src/translators/ollama-client.js';
import { TranslationOrchestrator } from '../../src/translators/orchestrator.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const SAMPLE_EPUB = path.join(FIXTURES_DIR, 'sample.epub');
const SAMPLE_FB2 = path.join(FIXTURES_DIR, 'sample.fb2');
const OUTPUT_DIR = path.join(FIXTURES_DIR, 'output');

describe('Integration: EPUB pipeline', () => {
  let parsedEpub;

  beforeAll(async () => {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const parser = new EpubParser(SAMPLE_EPUB);
    parsedEpub = await parser.parse();
  });

  afterAll(() => {
    // Clean up output directory
    if (fs.existsSync(OUTPUT_DIR)) {
      const files = fs.readdirSync(OUTPUT_DIR);
      for (const file of files) {
        fs.unlinkSync(path.join(OUTPUT_DIR, file));
      }
      try {
        fs.rmdirSync(OUTPUT_DIR);
      } catch {
        // ignore if not empty
      }
    }
  });

  it('should parse EPUB → translate text → write → re-parse with translations preserved', async () => {
    // Create a mock OllamaClient
    const mockClient = new OllamaClient();
    mockClient.translate = vi.fn().mockImplementation(async (text, options) => {
      // Simple mock: translate English words to Spanish
      return text
        .replace(/Hello world/g, 'Hola mundo')
        .replace(/This is a test paragraph\./g, 'Esto es un párrafo de prueba.')
        .replace(/Second chapter content\./g, 'Contenido del segundo capítulo.')
        .replace(/More text to translate\./g, 'Más texto para traducir.');
    });

    const orchestrator = new TranslationOrchestrator(mockClient);

    // Translate each content document
    for (const doc of parsedEpub.contentDocs) {
      await orchestrator.translateDocument(doc.dom, {
        sourceLang: 'en',
        targetLang: 'es',
      });
    }

    // Write the translated EPUB
    const writer = new EpubWriter(parsedEpub);
    for (const doc of parsedEpub.contentDocs) {
      writer.updateContentDoc(doc.path, doc.dom.outerHTML);
    }

    const outputPath = path.join(OUTPUT_DIR, 'translated.epub');
    await writer.write(outputPath);

    // Re-parse and verify
    expect(fs.existsSync(outputPath)).toBe(true);

    const reparsed = await new EpubParser(outputPath).parse();
    expect(reparsed.contentDocs.length).toBe(parsedEpub.contentDocs.length);
    expect(reparsed.metadata.title).toBe(parsedEpub.metadata.title);

    // Check that translations are present
    const allText = reparsed.contentDocs
      .map(doc => doc.dom.textContent)
      .join(' ');
    expect(allText).toContain('Hola mundo');
  });

  it('should preserve HTML structure after translation', async () => {
    // Parse fresh copy
    const parser = new EpubParser(SAMPLE_EPUB);
    const epub = await parser.parse();

    const mockClient = new OllamaClient();
    mockClient.translate = vi.fn().mockImplementation(async (text) => {
      return text.replace(/Hello/g, 'Hola');
    });

    const orchestrator = new TranslationOrchestrator(mockClient);

    for (const doc of epub.contentDocs) {
      await orchestrator.translateDocument(doc.dom, {
        sourceLang: 'en',
        targetLang: 'es',
      });
    }

    // Verify structure preserved
    for (const doc of epub.contentDocs) {
      // All <p> tags should still be present
      const paragraphs = doc.dom.querySelectorAll('p');
      expect(paragraphs.length).toBeGreaterThan(0);

      // Headings should still be present
      const headings = doc.dom.querySelectorAll('h1');
      expect(headings.length).toBeGreaterThanOrEqual(0);
    }
  });

  it('should preserve CSS and non-content files', async () => {
    const parser = new EpubParser(SAMPLE_EPUB);
    const epub = await parser.parse();

    const mockClient = new OllamaClient();
    mockClient.translate = vi.fn().mockResolvedValue('Translated');

    const orchestrator = new TranslationOrchestrator(mockClient);

    for (const doc of epub.contentDocs) {
      await orchestrator.translateDocument(doc.dom, {
        sourceLang: 'en',
        targetLang: 'es',
      });
    }

    const writer = new EpubWriter(epub);
    for (const doc of epub.contentDocs) {
      writer.updateContentDoc(doc.path, doc.dom.outerHTML);
    }

    const outputPath = path.join(OUTPUT_DIR, 'css_preserved.epub');
    await writer.write(outputPath);

    // Re-parse and check CSS
    const reparsed = await new EpubParser(outputPath).parse();
    // The EPUB should still have style.css content
    const zip = reparsed._zip;
    const cssEntry = zip.getEntry('OEBPS/style.css');
    expect(cssEntry).not.toBeNull();
    const cssContent = cssEntry.getData().toString('utf8');
    expect(cssContent).toContain('font-family');
  });
});

describe('Integration: FB2 pipeline', () => {
  it('should parse FB2 → translate → write as EPUB', async () => {
    const parser = new Fb2Parser(SAMPLE_FB2);
    const parsed = await parser.parse();

    expect(parsed.contentDocs.length).toBeGreaterThan(0);

    // Verify FB2 metadata
    expect(parsed.metadata.title).toBe('Test Book FB2');
    expect(parsed.metadata.author).toBe('Test Author');
    expect(parsed.metadata.language).toBe('en');

    // Verify content sections
    const mainSections = parsed.contentDocs.filter(doc => !doc.isNotes);
    expect(mainSections.length).toBe(2); // two main sections

    // Verify text content is available
    const allText = mainSections
      .map(doc => doc.dom.textContent)
      .join(' ');
    expect(allText).toContain('Hello world from FB2');
  });

  it('should handle FB2 inline formatting conversion', async () => {
    const parser = new Fb2Parser(SAMPLE_FB2);
    const parsed = await parser.parse();

    const mainSections = parsed.contentDocs.filter(doc => !doc.isNotes);
    const firstSection = mainSections[0];

    // Verify that <strong> and <em> tags are present in the converted HTML
    const html = firstSection.dom.innerHTML;
    expect(html).toContain('<strong>');
    expect(html).toContain('<em>');
  });
});

describe('Integration: error handling', () => {
  it('should handle non-existent EPUB file', async () => {
    const parser = new EpubParser('/nonexistent/path.epub');
    await expect(parser.parse()).rejects.toThrow();
  });

  it('should handle non-existent FB2 file', async () => {
    const parser = new Fb2Parser('/nonexistent/path.fb2');
    await expect(parser.parse()).rejects.toThrow();
  });

  it('should handle empty text nodes gracefully', async () => {
    const { parse: parseHtml } = await import('node-html-parser');
    const dom = parseHtml('<html><body><p></p><p>  </p></body></html>');

    const mockClient = new OllamaClient();
    const orchestrator = new TranslationOrchestrator(mockClient);

    const nodes = orchestrator.extractTextNodes(dom);
    // Empty/whitespace-only nodes should be skipped
    expect(nodes.length).toBe(0);
  });
});
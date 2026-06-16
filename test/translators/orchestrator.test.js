import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TranslationOrchestrator } from '../../src/translators/orchestrator.js';
import { OllamaClient } from '../../src/translators/ollama-client.js';
import { parse as parseHtml } from 'node-html-parser';

describe('TranslationOrchestrator', () => {
  let orchestrator;
  let mockClient;

  beforeEach(() => {
    mockClient = new OllamaClient();
    mockClient.translate = vi.fn();
    mockClient.splitIntoChunks = vi.fn();
    orchestrator = new TranslationOrchestrator(mockClient);
  });

  describe('extractTextNodes', () => {
    it('should extract text from paragraph elements', () => {
      const html = '<html><body><p>Hello world</p><p>Second paragraph</p></body></html>';
      const dom = parseHtml(html);
      const nodes = orchestrator.extractTextNodes(dom);
      expect(nodes.length).toBe(2);
      expect(nodes[0].text).toBe('Hello world');
      expect(nodes[1].text).toBe('Second paragraph');
    });

    it('should extract text from heading elements', () => {
      const html = '<html><body><h1>Title</h1><h2>Subtitle</h2></body></html>';
      const dom = parseHtml(html);
      const nodes = orchestrator.extractTextNodes(dom);
      expect(nodes.length).toBe(2);
      expect(nodes[0].text).toBe('Title');
      expect(nodes[1].text).toBe('Subtitle');
    });

    it('should skip whitespace-only text nodes', () => {
      const html = '<html><body><p>Hello</p>   <p>World</p></body></html>';
      const dom = parseHtml(html);
      const nodes = orchestrator.extractTextNodes(dom);
      const texts = nodes.map(n => n.text);
      expect(texts).not.toContain('');
      expect(texts).not.toContain('   ');
    });

    it('should skip non-translatable elements like script and style', () => {
      const html = '<html><head><style>.cls{color:red}</style></head><body><p>Hello</p></body></html>';
      const dom = parseHtml(html);
      const nodes = orchestrator.extractTextNodes(dom);
      expect(nodes.length).toBe(1);
      expect(nodes[0].text).toBe('Hello');
    });

    it('should assign unique IDs to text nodes', () => {
      const html = '<html><body><p>First</p><p>Second</p></body></html>';
      const dom = parseHtml(html);
      const nodes = orchestrator.extractTextNodes(dom);
      const ids = nodes.map(n => n.id);
      expect(new Set(ids).size).toBe(ids.length); // all unique
    });
  });

  describe('groupIntoChunks', () => {
    it('should group text nodes into chunks within size limit', () => {
      const nodes = [
        { id: 't0', text: 'Short text.' },
        { id: 't1', text: 'Another short text.' },
        { id: 't2', text: 'Yet another.' },
      ];
      const chunks = orchestrator.groupIntoChunks(nodes, 100);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.length).toBeLessThanOrEqual(3);
    });

    it('should split into multiple chunks when exceeding limit', () => {
      const nodes = [
        { id: 't0', text: 'A'.repeat(50) },
        { id: 't1', text: 'B'.repeat(50) },
        { id: 't2', text: 'C'.repeat(50) },
      ];
      const chunks = orchestrator.groupIntoChunks(nodes, 80);
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('should handle empty nodes array', () => {
      const chunks = orchestrator.groupIntoChunks([], 100);
      expect(chunks).toEqual([]);
    });
  });

  describe('replaceText', () => {
    it('should replace text in nodes from translations map', () => {
      const html = '<html><body><p>Hello</p><p>World</p></body></html>';
      const dom = parseHtml(html);
      const nodes = orchestrator.extractTextNodes(dom);

      const translations = {};
      translations[nodes[0].id] = 'Hola';
      translations[nodes[1].id] = 'Mundo';

      orchestrator.replaceText(dom, nodes, translations);

      // Verify the DOM was modified
      const pElements = dom.querySelectorAll('p');
      expect(pElements[0].textContent).toBe('Hola');
      expect(pElements[1].textContent).toBe('Mundo');
    });

    it('should leave nodes untouched if no translation provided', () => {
      const html = '<html><body><p>Hello</p><p>World</p></body></html>';
      const dom = parseHtml(html);
      const nodes = orchestrator.extractTextNodes(dom);

      const translations = {};
      translations[nodes[0].id] = 'Hola';

      orchestrator.replaceText(dom, nodes, translations);

      const pElements = dom.querySelectorAll('p');
      expect(pElements[0].textContent).toBe('Hola');
      expect(pElements[1].textContent).toBe('World'); // unchanged
    });
  });

  describe('translateDocument', () => {
    it('should translate all text in a document', async () => {
      mockClient.translate.mockImplementation(async (text) => {
        // Simple mock: reverse the text as "translation"
        return text.replace(/Hello/g, 'Hola').replace(/World/g, 'Mundo');
      });

      const html = '<html><body><p>Hello</p><p>World</p></body></html>';
      const dom = parseHtml(html);

      await orchestrator.translateDocument(dom, {
        sourceLang: 'en',
        targetLang: 'es',
      });

      const pElements = dom.querySelectorAll('p');
      expect(pElements[0].textContent).toBe('Hola');
      expect(pElements[1].textContent).toBe('Mundo');
    });

    it('should call onProgress callback for each chunk', async () => {
      mockClient.translate.mockResolvedValue('Translated');

      const html = '<html><body><p>Hello</p></body></html>';
      const dom = parseHtml(html);
      const onProgress = vi.fn();

      await orchestrator.translateDocument(dom, {
        sourceLang: 'en',
        targetLang: 'es',
        onProgress,
      });

      expect(onProgress).toHaveBeenCalled();
    });
  });

  describe('preserveHTMLStructure', () => {
    it('should preserve inline tags when translating', async () => {
      mockClient.translate.mockImplementation(async (text) => {
        return text.replace(/Hello/g, 'Hola');
      });

      const html = '<html><body><p>Hello <strong>world</strong></p></body></html>';
      const dom = parseHtml(html);

      await orchestrator.translateDocument(dom, {
        sourceLang: 'en',
        targetLang: 'es',
      });

      const p = dom.querySelector('p');
      expect(p.innerHTML).toContain('strong'); // tag preserved
      expect(p.textContent).toContain('Hola');
    });

    it('should preserve links with href attributes', async () => {
      mockClient.translate.mockImplementation(async (text) => {
        return text.replace(/Click here/g, 'Нажмите сюда');
      });

      const html = '<html><body><p><a href="https://example.com">Click here</a></p></body></html>';
      const dom = parseHtml(html);

      await orchestrator.translateDocument(dom, {
        sourceLang: 'en',
        targetLang: 'ru',
      });

      const a = dom.querySelector('a');
      expect(a.getAttribute('href')).toBe('https://example.com');
      expect(a.textContent).toContain('Нажмите сюда');
    });
  });
});
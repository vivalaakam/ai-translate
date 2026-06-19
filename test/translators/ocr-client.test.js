import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OcrClient } from '../../src/translators/ocr-client.js';
import { OLLAMA_DEFAULT_URL, DEFAULT_OCR_MODEL } from '../../src/utils/constants.js';

describe('OcrClient', () => {
  let client;

  beforeEach(() => {
    client = new OcrClient();
  });

  describe('constructor', () => {
    it('should use default options', () => {
      expect(client.baseUrl).toBe(OLLAMA_DEFAULT_URL);
      expect(client.model).toBe(DEFAULT_OCR_MODEL);
      expect(client.apiKey).toBe('');
    });

    it('should accept custom options', () => {
      const custom = new OcrClient({
        baseUrl: 'http://custom:1234',
        model: 'gpt-4o',
        apiKey: 'sk-test-key',
      });
      expect(custom.baseUrl).toBe('http://custom:1234');
      expect(custom.model).toBe('gpt-4o');
      expect(custom.apiKey).toBe('sk-test-key');
    });

    it('should strip trailing slashes from baseUrl', () => {
      const custom = new OcrClient({ baseUrl: 'http://custom:1234//' });
      expect(custom.baseUrl).toBe('http://custom:1234');
    });
  });

  describe('extractPage', () => {
    it('should call the API with correct payload structure', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '# Heading\n\nParagraph text' } }],
        }),
      });
      globalThis.fetch = mockFetch;

      const result = await client.extractPage(Buffer.from('fake-image'), 'image/png', 1);

      expect(result).toBe('# Heading\n\nParagraph text');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const call = mockFetch.mock.calls[0];
      const url = call[0];
      const options = call[1];

      expect(url).toBe(`${OLLAMA_DEFAULT_URL}/v1/chat/completions`);
      expect(options.method).toBe('POST');
      expect(options.headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(options.body);
      expect(body.model).toBe(DEFAULT_OCR_MODEL);
      expect(body.stream).toBe(false);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe('system');
      expect(body.messages[1].role).toBe('user');
      // The user message should have content with text and image_url parts
      const userContent = body.messages[1].content;
      expect(Array.isArray(userContent)).toBe(true);
      expect(userContent).toHaveLength(2);
      expect(userContent[0].type).toBe('text');
      expect(userContent[1].type).toBe('image_url');
      expect(userContent[1].image_url.url).toMatch(/^data:image\/png;base64,/);
    });

    it('should throw on API error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });
      globalThis.fetch = mockFetch;

      await expect(client.extractPage(Buffer.from('fake'), 'image/png', 1)).rejects.toThrow(
        /OCR API error \(500\)/,
      );
    });

    it('should return empty string when no content in response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '' } }] }),
      });
      globalThis.fetch = mockFetch;

      const result = await client.extractPage(Buffer.from('fake'), 'image/png', 1);
      expect(result).toBe('');
    });
  });

  describe('extractPages', () => {
    it('should process multiple pages sequentially', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: `Page ${callCount} text` } }],
          }),
        });
      });
      globalThis.fetch = mockFetch;

      const pages = [
        { buffer: Buffer.from('p1'), mimeType: 'image/png', pageNumber: 1 },
        { buffer: Buffer.from('p2'), mimeType: 'image/png', pageNumber: 2 },
        { buffer: Buffer.from('p3'), mimeType: 'image/png', pageNumber: 3 },
      ];

      const progressCalls = [];
      const results = await client.extractPages(pages, (current, total, text) => {
        progressCalls.push({ current, total, text });
      });

      expect(results).toEqual(['Page 1 text', 'Page 2 text', 'Page 3 text']);
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(progressCalls).toHaveLength(3);
      expect(progressCalls[0]).toEqual({ current: 1, total: 3, text: 'Page 1 text' });
      expect(progressCalls[2]).toEqual({ current: 3, total: 3, text: 'Page 3 text' });
    });
  });

  describe('checkAvailable', () => {
    it('should return true when API responds ok', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
      expect(await client.checkAvailable()).toBe(true);
    });

    it('should return false when API is unreachable', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));
      expect(await client.checkAvailable()).toBe(false);
    });
  });

  describe('listModels', () => {
    it('should return sorted model list', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'model-c' },
            { id: 'model-a' },
            { id: 'model-b' },
          ],
        }),
      });
      const models = await client.listModels();
      expect(models).toEqual(['model-a', 'model-b', 'model-c']);
    });

    it('should return empty array on error', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('fail'));
      expect(await client.listModels()).toEqual([]);
    });
  });
});
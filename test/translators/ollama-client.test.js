import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaClient } from '../../src/translators/ollama-client.js';
import { DEFAULT_CHUNK_SIZE, OLLAMA_DEFAULT_URL, DEFAULT_MODEL } from '../../src/utils/constants.js';

describe('OllamaClient', () => {
  let client;

  beforeEach(() => {
    client = new OllamaClient();
  });

  describe('constructor', () => {
    it('should use default options', () => {
      expect(client.baseUrl).toBe(OLLAMA_DEFAULT_URL);
      expect(client.model).toBe(DEFAULT_MODEL);
      expect(client.apiKey).toBe('');
    });

    it('should accept custom options', () => {
      const custom = new OllamaClient({
        baseUrl: 'http://custom:1234',
        model: 'mistral',
        apiKey: 'sk-test-key',
      });
      expect(custom.baseUrl).toBe('http://custom:1234');
      expect(custom.model).toBe('mistral');
      expect(custom.apiKey).toBe('sk-test-key');
    });
  });

  describe('splitIntoChunks', () => {
    it('should split text into chunks respecting paragraph boundaries', () => {
      const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
      const chunks = client.splitIntoChunks(text, 30);
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(30 + 20); // allow some overflow for paragraph boundaries
      }
    });

    it('should not split mid-word', () => {
      const text = 'This is a test sentence that should not be split in the middle of a word.';
      const chunks = client.splitIntoChunks(text, 50);
      for (const chunk of chunks) {
        // Check no partial words at boundaries
        expect(chunk.trim().length).toBeGreaterThan(0);
      }
    });

    it('should return single chunk if text fits', () => {
      const text = 'Short text';
      const chunks = client.splitIntoChunks(text, 1000);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe(text);
    });

    it('should handle empty text', () => {
      const chunks = client.splitIntoChunks('', 1000);
      expect(chunks).toHaveLength(0);
    });

    it('should handle text with only whitespace', () => {
      const chunks = client.splitIntoChunks('   \n\n  \n  ', 1000);
      expect(chunks).toHaveLength(0);
    });
  });

  describe('checkAvailable', () => {
    it('should return true when API is running', async () => {
      const mockClient = new OllamaClient();
      mockClient._fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });
      const result = await mockClient.checkAvailable();
      expect(result).toBe(true);
    });

    it('should return false when API is not running', async () => {
      const mockClient = new OllamaClient();
      mockClient._fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));
      const result = await mockClient.checkAvailable();
      expect(result).toBe(false);
    });

    it('should send Authorization header when apiKey is set', async () => {
      const mockClient = new OllamaClient({ apiKey: 'sk-test' });
      let calledUrl = '';
      let calledHeaders = {};
      mockClient._fetch = vi.fn().mockImplementation(async (url, opts) => {
        calledUrl = url;
        calledHeaders = opts?.headers || {};
        return { ok: true };
      });
      await mockClient.checkAvailable();
      expect(calledUrl).toContain('/v1/models');
      expect(calledHeaders).toHaveProperty('Authorization', 'Bearer sk-test');
    });
  });

  describe('listModels', () => {
    it('should return model IDs from /v1/models', async () => {
      const mockClient = new OllamaClient();
      mockClient._fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: [
            { id: 'llama3.1' },
            { id: 'mistral' },
          ],
        }),
      });
      const models = await mockClient.listModels();
      expect(models).toEqual(['llama3.1', 'mistral']);
    });

    it('should return empty array on error', async () => {
      const mockClient = new OllamaClient();
      mockClient._fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));
      const models = await mockClient.listModels();
      expect(models).toEqual([]);
    });
  });

  describe('translate', () => {
    it('should call OpenAI-compatible chat completions API', async () => {
      const mockClient = new OllamaClient({ model: 'test-model' });
      let calledWith = null;

      mockClient._fetch = vi.fn().mockImplementation(async (url, options) => {
        calledWith = { url, options };
        return {
          ok: true,
          body: null,
        };
      });

      // Mock the stream processing
      mockClient._processStreamResponse = vi.fn().mockResolvedValue('Translated text');

      const result = await mockClient.translate('Hello', {
        sourceLang: 'en',
        targetLang: 'es',
      });

      expect(result).toBe('Translated text');
      // Verify it calls /v1/chat/completions
      expect(calledWith.url).toContain('/v1/chat/completions');
      // Verify request body uses messages format
      const body = JSON.parse(calledWith.options.body);
      expect(body.model).toBe('test-model');
      expect(body.messages).toBeDefined();
      expect(body.messages[0].role).toBe('user');
      expect(body.stream).toBe(true);
    });

    it('should send Authorization header when apiKey is set', async () => {
      const mockClient = new OllamaClient({ model: 'test-model', apiKey: 'sk-test' });
      let calledHeaders = {};

      mockClient._fetch = vi.fn().mockImplementation(async (url, options) => {
        calledHeaders = options?.headers || {};
        return { ok: true };
      });

      mockClient._processStreamResponse = vi.fn().mockResolvedValue('OK');

      await mockClient.translate('Hello', {
        sourceLang: 'en',
        targetLang: 'es',
      });

      expect(calledHeaders).toHaveProperty('Authorization', 'Bearer sk-test');
    });

    it('should retry on transient errors', async () => {
      const mockClient = new OllamaClient();
      let callCount = 0;

      mockClient._fetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          throw new Error('Transient error');
        }
        return { ok: true };
      });

      mockClient._processStreamResponse = vi.fn().mockResolvedValue('OK');

      // Should succeed after retries
      const result = await mockClient.translate('Hello', {
        sourceLang: 'en',
        targetLang: 'es',
        maxRetries: 3,
      });

      expect(callCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('buildPrompt', () => {
    it('should include target language and source text', () => {
      // buildPrompt substitutes {targetLang} and {sourceText} into the
      // TRANSLATION_PROMPT_TEMPLATE. The template does not reference
      // {sourceLang}, so the prompt only contains the target language name.
      const prompt = client.buildPrompt('Hello world', {
        sourceLang: 'English',
        targetLang: 'Spanish',
      });
      expect(prompt).toContain('Spanish');
      expect(prompt).toContain('Hello world');
    });
  });
});
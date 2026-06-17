import { DEFAULT_CHUNK_SIZE, OLLAMA_DEFAULT_URL, DEFAULT_MODEL, TRANSLATION_PROMPT_TEMPLATE } from '../utils/constants.js';
import type { OllamaClientOptions, TranslateOptions } from '../types.js';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 300000; // 5 minutes per chunk

/**
 * Client for communicating with Ollama's OpenAI-compatible API for translation.
 * Uses the /v1/chat/completions endpoint with streaming.
 */
export class OllamaClient {
  private baseUrl: string;
  private model: string;
  private apiKey: string;
  private _fetch: typeof globalThis.fetch;

  /**
   * @param options - Configuration options
   */
  constructor({ baseUrl = OLLAMA_DEFAULT_URL, model = DEFAULT_MODEL, apiKey = '' }: OllamaClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, ''); // remove trailing slash
    this.model = model;
    this.apiKey = apiKey;
    this._fetch = globalThis.fetch;
  }

  /**
   * Check if the OpenAI-compatible API is available.
   * Tries /v1/models endpoint.
   */
  async checkAvailable(): Promise<boolean> {
    try {
      const response = await this._fetch(`${this.baseUrl}/v1/models`, {
        headers: this._authHeaders(),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * List available models via the OpenAI-compatible /v1/models endpoint.
   */
  async listModels(): Promise<string[]> {
    try {
      const response = await this._fetch(`${this.baseUrl}/v1/models`, {
        headers: this._authHeaders(),
      });
      if (!response.ok) return [];
      const data = await response.json() as { data: Array<{ id: string }> };
      return data.data.map((m) => m.id).sort();
    } catch {
      return [];
    }
  }

  /**
   * Build the translation prompt.
   * @param text - Text to translate
   * @param options - Language options
   * @returns The formatted prompt string
   */
  buildPrompt(text: string, { sourceLang, targetLang }: { sourceLang: string; targetLang: string }): string {
    return TRANSLATION_PROMPT_TEMPLATE
      .replace('{sourceLang}', sourceLang)
      .replace('{targetLang}', targetLang)
      .replace('{sourceText}', text);
  }

  /**
   * Translate text using the OpenAI-compatible chat completions API.
   * @param text - Text to translate
   * @param options - Translation options
   * @returns Translated text
   */
  async translate(text: string, { sourceLang, targetLang, onProgress, maxRetries = MAX_RETRIES }: TranslateOptions): Promise<string> {
    const prompt = this.buildPrompt(text, { sourceLang, targetLang });

    console.log('OllamaClient.translate called with prompt:', prompt);

    let lastError: Error = new Error('Unknown error');
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this._callApi(prompt, onProgress as ((text: string) => void) | undefined);
        return result;
      } catch (error) {
        lastError = error as Error;
        if (attempt < maxRetries) {
          await this._delay(RETRY_DELAY_MS * attempt);
        }
      }
    }
    throw new Error(`Translation failed after ${maxRetries} attempts: ${lastError.message}`);
  }

  /**
   * Split text into chunks respecting paragraph boundaries.
   * @param text - Text to split
   * @param maxChars - Maximum characters per chunk
   * @returns Array of text chunks
   */
  splitIntoChunks(text: string, maxChars: number = DEFAULT_CHUNK_SIZE): string[] {
    if (!text || !text.trim()) return [];

    // Split by double newlines (paragraph boundaries)
    const paragraphs = text.split(/\n\n+/);
    const chunks: string[] = [];
    let currentChunk = '';

    for (const paragraph of paragraphs) {
      const trimmed = paragraph.trim();
      if (!trimmed) continue;

      // If adding this paragraph would exceed the limit and we already have content
      if (currentChunk && (currentChunk.length + trimmed.length + 2) > maxChars) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }

      // If a single paragraph exceeds maxChars, split by sentences
      if (trimmed.length > maxChars) {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }
        const sentences = trimmed.split(/(?<=[.!?])\s+/);
        for (const sentence of sentences) {
          if (!sentence.trim()) continue;
          if (currentChunk && (currentChunk.length + sentence.length + 1) > maxChars) {
            chunks.push(currentChunk.trim());
            currentChunk = '';
          }
          currentChunk += (currentChunk ? ' ' : '') + sentence;
        }
      } else {
        currentChunk += (currentChunk ? '\n\n' : '') + trimmed;
      }
    }

    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

  /**
   * Call the OpenAI-compatible /v1/chat/completions API with streaming.
   * @private
   */
  private async _callApi(prompt: string, onProgress?: (text: string) => void): Promise<string> {
    console.log('OllamaClient._callApi called with prompt:', `${this.baseUrl}/v1/chat/completions`)
    const response = await this._fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this._authHeaders(),
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        stream: true,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`API error (${response.status}): ${errorBody}`);
    }

    return this._processStreamResponse(response, onProgress);
  }

  /**
   * Process a streaming SSE response from the OpenAI-compatible API.
   * @private
   */
  private async _processStreamResponse(response: Response, onProgress?: (text: string) => void): Promise<string> {
    let fullText = '';

    if (!response.body) {
      throw new Error('No response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = ''; // Handle partial lines across chunks

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed === 'data: [DONE]') {
            continue;
          }

          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6);
            try {
              const json = JSON.parse(jsonStr) as {
                choices?: Array<{
                  delta?: { content?: string };
                }>;
              };
              const content = json.choices?.[0]?.delta?.content;
              if (content) {
                fullText += content;
                if (onProgress) {
                  onProgress(fullText);
                }
              }
            } catch {
              // Skip malformed JSON lines
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return fullText.trim();
  }

  /**
   * Build auth headers (Authorization: Bearer <key> if apiKey is set).
   * @private
   */
  private _authHeaders(): Record<string, string> {
    if (!this.apiKey) return {};
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  /**
   * Delay helper for retries.
   * @private
   */
  private _delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
import { DEFAULT_CHUNK_SIZE, OLLAMA_DEFAULT_URL, DEFAULT_MODEL, TRANSLATION_PROMPT_TEMPLATE } from '../utils/constants.js';
import type { OllamaClientOptions, TranslateOptions } from '../types.js';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 300000; // 5 minutes per chunk

/**
 * Client for communicating with Ollama's REST API for translation.
 */
export class OllamaClient {
  private baseUrl: string;
  private model: string;
  private _fetch: typeof globalThis.fetch;

  /**
   * @param options - Configuration options
   */
  constructor({ baseUrl = OLLAMA_DEFAULT_URL, model = DEFAULT_MODEL }: OllamaClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, ''); // remove trailing slash
    this.model = model;
    this._fetch = globalThis.fetch;
  }

  /**
   * Check if Ollama is available.
   */
  async checkAvailable(): Promise<boolean> {
    try {
      const response = await this._fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
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
      .replace('{text}', text);
  }

  /**
   * Translate text using Ollama.
   * @param text - Text to translate
   * @param options - Translation options
   * @returns Translated text
   */
  async translate(text: string, { sourceLang, targetLang, onProgress, maxRetries = MAX_RETRIES }: TranslateOptions): Promise<string> {
    const prompt = this.buildPrompt(text, { sourceLang, targetLang });

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
   * Call the Ollama API.
   * @private
   */
  private async _callApi(prompt: string, onProgress?: (text: string) => void): Promise<string> {
    const response = await this._fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: true,
        options: {
          temperature: 0.3, // Low temperature for more consistent translation
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Ollama API error (${response.status}): ${errorBody}`);
    }

    return this._processStreamResponse(response, onProgress);
  }

  /**
   * Process a streaming response from Ollama.
   * @private
   */
  private async _processStreamResponse(response: Response, onProgress?: (text: string) => void): Promise<string> {
    let fullText = '';

    if (!response.body) {
      throw new Error('No response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        // Each line is a JSON object
        for (const line of chunk.split('\n')) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line) as { response?: string };
            if (json.response) {
              fullText += json.response;
              if (onProgress) {
                onProgress(fullText);
              }
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return fullText.trim();
  }

  /**
   * Delay helper for retries.
   * @private
   */
  private _delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
import { DEFAULT_CHUNK_SIZE, OLLAMA_DEFAULT_URL, DEFAULT_MODEL, TRANSLATION_PROMPT_TEMPLATE } from '../utils/constants.js';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 300000; // 5 minutes per chunk

/**
 * Client for communicating with Ollama's REST API for translation.
 */
export class OllamaClient {
  /**
   * @param {object} options
   * @param {string} [options.baseUrl] - Ollama API base URL
   * @param {string} [options.model] - Model name to use
   */
  constructor({ baseUrl = OLLAMA_DEFAULT_URL, model = DEFAULT_MODEL } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, ''); // remove trailing slash
    this.model = model;
    this._fetch = globalThis.fetch;
  }

  /**
   * Check if Ollama is available.
   * @returns {Promise<boolean>}
   */
  async checkAvailable() {
    try {
      const response = await this._fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Build the translation prompt.
   * @param {string} text - Text to translate
   * @param {object} options
   * @param {string} options.sourceLang - Source language
   * @param {string} options.targetLang - Target language
   * @returns {string}
   */
  buildPrompt(text, { sourceLang, targetLang }) {
    return TRANSLATION_PROMPT_TEMPLATE
      .replace('{sourceLang}', sourceLang)
      .replace('{targetLang}', targetLang)
      .replace('{text}', text);
  }

  /**
   * Translate text using Ollama.
   * @param {string} text - Text to translate
   * @param {object} options
   * @param {string} options.sourceLang - Source language
   * @param {string} options.targetLang - Target language
   * @param {Function} [options.onProgress] - Progress callback
   * @param {number} [options.maxRetries] - Max retry attempts
   * @returns {Promise<string>} - Translated text
   */
  async translate(text, { sourceLang, targetLang, onProgress, maxRetries = MAX_RETRIES } = {}) {
    const prompt = this.buildPrompt(text, { sourceLang, targetLang });

    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this._callApi(prompt, onProgress);
        return result;
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) {
          await this._delay(RETRY_DELAY_MS * attempt);
        }
      }
    }
    throw new Error(`Translation failed after ${maxRetries} attempts: ${lastError.message}`);
  }

  /**
   * Split text into chunks respecting paragraph boundaries.
   * @param {string} text - Text to split
   * @param {number} [maxChars] - Maximum characters per chunk
   * @returns {string[]}
   */
  splitIntoChunks(text, maxChars = DEFAULT_CHUNK_SIZE) {
    if (!text || !text.trim()) return [];

    // Split by double newlines (paragraph boundaries)
    const paragraphs = text.split(/\n\n+/);
    const chunks = [];
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
  async _callApi(prompt, onProgress) {
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
  async _processStreamResponse(response, onProgress) {
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
            const json = JSON.parse(line);
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
  async _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
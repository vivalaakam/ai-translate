/**
 * OCR Client — sends page images to a vision-capable LLM via OpenAI-compatible API.
 *
 * Uses /v1/chat/completions with base64-encoded images in the message content.
 * Works with any OpenAI-compatible endpoint that supports vision (e.g. deepseek-ocr,
 * GPT-4o, Qwen-VL, etc.). The model is configured via OCR_MODEL env var.
 */

import { OLLAMA_DEFAULT_URL, DEFAULT_OCR_MODEL, DEFAULT_API_KEY } from '../utils/constants.js';

const OCR_REQUEST_TIMEOUT_MS = 300000; // 5 minutes per page

export interface OcrClientOptions {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export interface OcrPageResult {
  /** Markdown text extracted from the page image */
  text: string;
  /** Page number (1-based) */
  page: number;
}

/**
 * System prompt for OCR extraction.
 * Instructs the model to extract text as Markdown, preserving structure.
 */
const OCR_SYSTEM_PROMPT = `You are an OCR assistant. Extract all text from the provided page image.
Output the text in Markdown format, preserving the document structure:
- Use # for headings (matching the heading level)
- Use **bold** and *italic* for emphasized text
- Use - or 1. for list items
- Use > for blockquotes
- Use \`\`\` for code blocks
- Use | table | format for tables
- Preserve paragraph breaks
- Do NOT add any explanations or commentary — output ONLY the extracted text
- If the page contains figures/diagrams, describe them briefly as ![description](figure)
- If the page is blank or contains no text, output nothing`;

export class OcrClient {
  private baseUrl: string;
  private model: string;
  private apiKey: string;

  constructor({ baseUrl = OLLAMA_DEFAULT_URL, model = DEFAULT_OCR_MODEL, apiKey = DEFAULT_API_KEY }: OcrClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.apiKey = apiKey;
  }

  /**
   * Check if the OCR API is available.
   */
  async checkAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this._authHeaders(),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * List available models from the API.
   */
  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
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
   * Extract text from a single page image using the vision LLM.
   *
   * @param imageBuffer - PNG/JPEG buffer of the page image
   * @param mimeType - MIME type of the image (e.g. "image/png")
   * @param pageNumber - Page number (1-based) for logging
   * @returns Extracted text in Markdown format
   */
  async extractPage(imageBuffer: Buffer, mimeType: string, pageNumber: number): Promise<string> {
    const base64 = imageBuffer.toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64}`;

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this._authHeaders(),
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: OCR_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: `Extract all text from this page (page ${pageNumber}). Output only the Markdown text.` },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        temperature: 0.1,
        max_tokens: 4096,
        stream: false,
      }),
      signal: AbortSignal.timeout(OCR_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OCR API error (${response.status}): ${errorBody}`);
    }

    const data = await response.json() as {
      choices?: Array<{
        message?: { content?: string };
      }>;
    };

    const text = data.choices?.[0]?.message?.content?.trim() || '';
    return text;
  }

  /**
   * Extract text from multiple page images.
   * Processes pages sequentially to avoid overwhelming the API.
   *
   * @param pages - Array of { buffer, mimeType, pageNumber }
   * @param onProgress - Optional callback called after each page
   * @returns Array of extracted text per page
   */
  async extractPages(
    pages: Array<{ buffer: Buffer; mimeType: string; pageNumber: number }>,
    onProgress?: (current: number, total: number, text: string) => void,
  ): Promise<string[]> {
    const results: string[] = [];
    for (let i = 0; i < pages.length; i++) {
      const { buffer, mimeType, pageNumber } = pages[i];
      const text = await this.extractPage(buffer, mimeType, pageNumber);
      results.push(text);
      if (onProgress) {
        onProgress(i + 1, pages.length, text);
      }
    }
    return results;
  }

  private _authHeaders(): Record<string, string> {
    if (!this.apiKey) return {};
    return { Authorization: `Bearer ${this.apiKey}` };
  }
}
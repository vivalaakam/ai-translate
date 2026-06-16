import { DEFAULT_CHUNK_SIZE, TEMP_MARKER_PREFIX } from '../utils/constants.js';
import type { HTMLElement } from 'node-html-parser';
import type { OllamaClient } from './ollama-client.js';
import type { TextNode, OrchestratorOptions, TranslateDocumentOptions, TranslationProgress } from '../types.js';

// Tags whose content should NOT be translated
const SKIP_TAGS: Set<string> = new Set(['script', 'style', 'head', 'meta', 'link', 'title']);

// Tags that typically contain translatable text
const TRANSLATABLE_TAGS: Set<string> = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'td', 'th', 'caption', 'span', 'div',
  'blockquote', 'pre', 'em', 'strong', 'a',
  'figcaption', 'dt', 'dd', 'label', 'button',
]);

let nodeIdCounter = 0;

/**
 * Orchestrates the translation pipeline:
 * 1. Extract translatable text nodes from DOM
 * 2. Group into chunks for translation
 * 3. Send to Ollama for translation
 * 4. Replace text in original DOM
 */
export class TranslationOrchestrator {
  private client: OllamaClient;
  private chunkSize: number;

  /**
   * @param ollamaClient - An OllamaClient instance
   * @param options - Configuration options
   */
  constructor(ollamaClient: OllamaClient, options: OrchestratorOptions = {}) {
    this.client = ollamaClient;
    this.chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
  }

  /**
   * Extract all translatable text nodes from a DOM.
   * Assigns a unique data-ai-tr-id attribute to each element containing text.
   * @param dom - node-html-parser DOM root
   * @returns Array of text node info objects
   */
  extractTextNodes(dom: HTMLElement): TextNode[] {
    nodeIdCounter = 0;
    const nodes: TextNode[] = [];

    const walk = (element: unknown): void => {
      if (!element || typeof element === 'string') return;

      const el = element as HTMLElement;
      const tagName = el.tagName?.toLowerCase();
      if (tagName && SKIP_TAGS.has(tagName)) return;

      // Check if this element has direct text content worth translating
      const directText = this._getDirectText(el);
      if (directText && directText.trim()) {
        const id = `${TEMP_MARKER_PREFIX}${nodeIdCounter++}`;
        el.setAttribute('data-ai-tr-id', id);
        nodes.push({
          id,
          text: directText.trim(),
          element: el,
        });
      }

      // Recurse into children
      if (el.childNodes) {
        for (const child of el.childNodes) {
          walk(child);
        }
      }
    };

    walk(dom);
    return nodes;
  }

  /**
   * Get direct text content of an element (not including child elements' text).
   * @private
   */
  private _getDirectText(element: HTMLElement): string {
    let text = '';
    for (const child of (element.childNodes || [])) {
      if (child.nodeType === 3) { // Text node
        text += (child as any).rawText;
      }
    }
    return text;
  }

  /**
   * Group text nodes into chunks for translation, respecting size limits.
   * @param nodes - Output from extractTextNodes
   * @param maxChars - Maximum characters per chunk
   * @returns Groups of text nodes
   */
  groupIntoChunks(nodes: TextNode[], maxChars: number = this.chunkSize): TextNode[][] {
    if (!nodes.length) return [];

    const chunks: TextNode[][] = [];
    let currentChunk: TextNode[] = [];
    let currentSize = 0;

    for (const node of nodes) {
      const nodeSize = node.text.length;

      if (currentSize + nodeSize > maxChars && currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentSize = 0;
      }

      currentChunk.push(node);
      currentSize += nodeSize;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  /**
   * Replace text in DOM nodes based on translations map.
   * @param dom - node-html-parser DOM root
   * @param nodes - Text nodes from extractTextNodes
   * @param translations - Map of id → translated text
   */
  replaceText(dom: HTMLElement, nodes: TextNode[], translations: Record<string, string>): void {
    for (const node of nodes) {
      const translated = translations[node.id];
      if (translated === undefined) continue;

      // Find the element by its data-ai-tr-id
      const element = dom.querySelector(`[data-ai-tr-id="${node.id}"]`);
      if (!element) continue;

      // Replace only the direct text content, preserving child elements
      this._replaceDirectText(element, node.text, translated);
    }
  }

  /**
   * Replace direct text content of an element while preserving child elements.
   * @private
   */
  private _replaceDirectText(element: HTMLElement, originalText: string, translatedText: string): void {
    // Find and replace text nodes directly
    for (const child of (element.childNodes || [])) {
      if (child.nodeType === 3) { // Text node
        const trimmedOriginal = originalText.trim();
        const trimmedChild = (child as any).rawText.trim();

        if (trimmedChild && trimmedOriginal.includes(trimmedChild)) {
          // Calculate the replacement for this text node
          const translated = translatedText;
          (child as any).rawText = (child as any).rawText.replace(trimmedChild, translated);
          return;
        }
      }
    }

    // Fallback: if we couldn't find a matching text node, try setting innerText-like
    // This handles the case where the entire element is just text
    const children = element.childNodes || [];
    const textNodes = children.filter(c => c.nodeType === 3);
    if (textNodes.length === 1 && children.filter(c => c.nodeType !== 3).length === 0) {
      // Simple case: element has only one text node
      (textNodes[0] as any).rawText = translatedText;
    }
  }

  /**
   * Clean up temporary attributes from the DOM.
   * @param dom - node-html-parser DOM root
   */
  cleanupMarkers(dom: HTMLElement): void {
    const marked = dom.querySelectorAll(`[data-ai-tr-id]`);
    for (const el of marked) {
      el.removeAttribute('data-ai-tr-id');
    }
  }

  /**
   * Translate all text in a content document.
   * @param dom - node-html-parser DOM root
   * @param options - Translation options
   */
  async translateDocument(dom: HTMLElement, { sourceLang, targetLang, onProgress }: TranslateDocumentOptions): Promise<void> {
    // 1. Extract text nodes
    const nodes = this.extractTextNodes(dom);
    if (nodes.length === 0) return;

    // 2. Group into chunks
    const chunks = this.groupIntoChunks(nodes);
    if (chunks.length === 0) return;

    // 3. Translate each chunk
    const translations: Record<string, string> = {};
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const text = chunk.map(n => `[${n.id}] ${n.text}`).join('\n\n');

      const translated = await this.client.translate(text, {
        sourceLang,
        targetLang,
      });

      // 4. Parse translation response back into individual texts
      this._parseTranslations(translated, translations);

      if (onProgress) {
        onProgress({
          chunk: i + 1,
          total: chunks.length,
          translated: Object.keys(translations).length,
          totalNodes: nodes.length,
        });
      }
    }

    // 5. Replace text in DOM
    this.replaceText(dom, nodes, translations);

    // 6. Clean up temporary attributes
    this.cleanupMarkers(dom);
  }

  /**
   * Parse translation response to extract individual translated segments.
   * Expected format: [tN] Translated text
   * @private
   */
  private _parseTranslations(translatedText: string, translations: Record<string, string>): void {
    // Try to match [ai-trN] markers
    const markerRegex = new RegExp(`\\[${TEMP_MARKER_PREFIX}\\d+\\]`, 'g');
    const markers = [...translatedText.matchAll(markerRegex)];

    if (markers.length === 0) {
      // No markers found — try to use the whole text as a single translation
      return;
    }

    for (let i = 0; i < markers.length; i++) {
      const marker = markers[i];
      const idMatch = marker[0].match(new RegExp(`\\[(${TEMP_MARKER_PREFIX}\\d+)\\]`));
      if (!idMatch) continue;

      const id = idMatch[1];
      const start = (marker.index ?? 0) + marker[0].length;
      const end = i + 1 < markers.length ? (markers[i + 1].index ?? translatedText.length) : translatedText.length;
      const text = translatedText.slice(start, end).trim();

      if (text) {
        translations[id] = text;
      }
    }
  }
}
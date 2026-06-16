import { DEFAULT_CHUNK_SIZE, TEMP_MARKER_PREFIX } from '../utils/constants.js';

// Tags whose content should NOT be translated
const SKIP_TAGS = new Set(['script', 'style', 'head', 'meta', 'link', 'title']);

// Tags that typically contain translatable text
const TRANSLATABLE_TAGS = new Set([
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
  /**
   * @param {OllamaClient} ollamaClient
   * @param {object} [options]
   * @param {number} [options.chunkSize] - Max chars per translation chunk
   */
  constructor(ollamaClient, options = {}) {
    this.client = ollamaClient;
    this.chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
  }

  /**
   * Extract all translatable text nodes from a DOM.
   * Assigns a unique data-ai-tr-id attribute to each element containing text.
   * @param {object} dom - node-html-parser DOM
   * @returns {Array<{id: string, text: string, element: object}>}
   */
  extractTextNodes(dom) {
    nodeIdCounter = 0;
    const nodes = [];

    const walk = (element) => {
      if (!element || typeof element === 'string') return;

      const tagName = element.tagName?.toLowerCase();
      if (tagName && SKIP_TAGS.has(tagName)) return;

      // Check if this element has direct text content worth translating
      const directText = this._getDirectText(element);
      if (directText && directText.trim()) {
        const id = `${TEMP_MARKER_PREFIX}${nodeIdCounter++}`;
        element.setAttribute('data-ai-tr-id', id);
        nodes.push({
          id,
          text: directText.trim(),
          element,
        });
      }

      // Recurse into children
      if (element.childNodes) {
        for (const child of element.childNodes) {
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
  _getDirectText(element) {
    let text = '';
    for (const child of (element.childNodes || [])) {
      if (child.nodeType === 3) { // Text node
        text += child.rawText;
      }
    }
    return text;
  }

  /**
   * Group text nodes into chunks for translation, respecting size limits.
   * @param {Array} nodes - Output from extractTextNodes
   * @param {number} [maxChars] - Maximum characters per chunk
   * @returns {Array<Array>} - Groups of text nodes
   */
  groupIntoChunks(nodes, maxChars = this.chunkSize) {
    if (!nodes.length) return [];

    const chunks = [];
    let currentChunk = [];
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
   * @param {object} dom - node-html-parser DOM
   * @param {Array} nodes - Text nodes from extractTextNodes
   * @param {object} translations - Map of id → translated text
   */
  replaceText(dom, nodes, translations) {
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
  _replaceDirectText(element, originalText, translatedText) {
    // Find and replace text nodes directly
    for (const child of (element.childNodes || [])) {
      if (child.nodeType === 3) { // Text node
        const trimmedOriginal = originalText.trim();
        const trimmedChild = child.rawText.trim();

        if (trimmedChild && trimmedOriginal.includes(trimmedChild)) {
          // Calculate the replacement for this text node
          const translated = translatedText;
          child.rawText = child.rawText.replace(trimmedChild, translated);
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
      textNodes[0].rawText = translatedText;
    }
  }

  /**
   * Clean up temporary attributes from the DOM.
   * @param {object} dom - node-html-parser DOM
   */
  cleanupMarkers(dom) {
    const marked = dom.querySelectorAll(`[data-ai-tr-id]`);
    for (const el of marked) {
      el.removeAttribute('data-ai-tr-id');
    }
  }

  /**
   * Translate all text in a content document.
   * @param {object} dom - node-html-parser DOM
   * @param {object} options
   * @param {string} options.sourceLang - Source language
   * @param {string} options.targetLang - Target language
   * @param {Function} [options.onProgress] - Progress callback
   * @returns {Promise<void>}
   */
  async translateDocument(dom, { sourceLang, targetLang, onProgress } = {}) {
    // 1. Extract text nodes
    const nodes = this.extractTextNodes(dom);
    if (nodes.length === 0) return;

    // 2. Group into chunks
    const chunks = this.groupIntoChunks(nodes);
    if (chunks.length === 0) return;

    // 3. Translate each chunk
    const translations = {};
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
   * Expected format: [t0] Translated text
   * @private
   */
  _parseTranslations(translatedText, translations) {
    // Try to match [tN] markers
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
      const start = marker.index + marker[0].length;
      const end = i + 1 < markers.length ? markers[i + 1].index : translatedText.length;
      const text = translatedText.slice(start, end).trim();

      if (text) {
        translations[id] = text;
      }
    }
  }
}
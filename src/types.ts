/**
 * Shared TypeScript interfaces for ai-translate.
 * These types model the data shapes used across all modules.
 */

/**
 * A parsed XHTML content document from an EPUB or FB2 file.
 * Each document represents a single chapter/section within the book.
 */
export interface ContentDoc {
  /** Path within the EPUB archive (e.g. "OEBPS/chapter1.xhtml") or synthetic path for FB2 */
  path: string;
  /** Parsed DOM tree from node-html-parser */
  dom: any; // HTMLElement from node-html-parser — typed as `any` to avoid importing the library type
  /** Raw HTML/XHTML string content */
  rawContent: string;
  /** Section title (only set for FB2-derived content docs) */
  sectionTitle?: string | null;
  /** Whether this section is footnotes/notes (only set for FB2) */
  isNotes?: boolean;
}

/**
 * Result of parsing an EPUB or FB2 file.
 * Returned by EpubParser.parse() and Fb2Parser.parse().
 */
export interface ParsedEpub {
  /** Book metadata (title, author, language) */
  metadata: BookMetadata;
  /** Ordered content documents (chapters/sections) */
  contentDocs: ContentDoc[];
  /** Reference to the underlying AdmZip instance (EPUB only; FB2 does not have a zip) */
  _zip?: any; // AdmZip instance — typed as `any` to avoid importing adm-zip
}

/**
 * Metadata extracted from an EPUB or FB2 file.
 */
export interface BookMetadata {
  /** Book title */
  title: string;
  /** Author name(s) */
  author: string;
  /** Source language code (e.g. "en", "ru") */
  language: string;
}

/**
 * An item from the EPUB manifest (content.opf <manifest><item>).
 * Maps an ID to its href, media-type, and optional properties.
 */
export interface ManifestItem {
  /** Relative path/href to the resource within the EPUB */
  href: string;
  /** MIME type of the resource (e.g. "application/xhtml+xml") */
  mediaType: string;
  /** Space-separated EPUB3 properties (e.g. "nav", "scripted") */
  properties: string;
}

/**
 * A translatable text node extracted from the DOM by TranslationOrchestrator.
 * Each node is assigned a unique marker ID so translations can be mapped back.
 */
export interface TextNode {
  /** Unique marker ID (format: "ai-tr0", "ai-tr1", …) */
  id: string;
  /** The extracted text content to translate */
  text: string;
  /** Reference to the node-html-parser element in the DOM */
  element: any; // HTMLElement from node-html-parser
}

/**
 * Progress information emitted during translation.
 * Passed to the onProgress callback in TranslationOrchestrator.translateDocument().
 */
export interface TranslationProgress {
  /** 1-based index of the current translation chunk */
  chunk: number;
  /** Total number of chunks for this document */
  total: number;
  /** Cumulative count of text nodes translated so far */
  translated: number;
  /** Total number of translatable text nodes in the document */
  totalNodes: number;
}

/**
 * Options for constructing an OllamaClient.
 */
export interface OllamaClientOptions {
  /** Ollama API base URL (default: "http://localhost:11434") */
  baseUrl?: string;
  /** Model name to use for translation (default: "llama3.1") */
  model?: string;
}

/**
 * Options for the translate() method on OllamaClient
 * and translateDocument() on TranslationOrchestrator.
 */
export interface TranslateOptions {
  /** Source language name or code (e.g. "English", "en") — "auto" to detect */
  sourceLang: string;
  /** Target language name or code (e.g. "Spanish", "es") */
  targetLang: string;
  /** Callback invoked with progressive translated text (OllamaClient) or TranslationProgress (Orchestrator) */
  onProgress?: (progress: string | TranslationProgress) => void;
  /** Maximum number of retry attempts per chunk (default: 3) */
  maxRetries?: number;
}

/**
 * Entry tracking an updated content document in EpubWriter.
 */
export interface UpdatedEntry {
  /** Path within the EPUB archive */
  path: string;
  /** New HTML content */
  content: string;
}

/**
 * Options for constructing a TranslationOrchestrator.
 */
export interface OrchestratorOptions {
  /** Maximum characters per translation chunk (default: 8000) */
  chunkSize?: number;
}

/**
 * Options for TranslationOrchestrator.translateDocument().
 */
export interface TranslateDocumentOptions {
  /** Source language name or code */
  sourceLang: string;
  /** Target language name or code */
  targetLang: string;
  /** Progress callback receiving TranslationProgress info */
  onProgress?: (progress: TranslationProgress) => void;
}

// ─── Web server types ────────────────────────────────────────────────

/**
 * Status of a translation job in the job queue.
 */
export type JobStatus = 'queued' | 'parsing' | 'translating' | 'assembling' | 'completed' | 'failed';

/**
 * A translation job tracked by the job queue manager.
 */
export interface TranslationJob {
  /** Unique job ID (UUID v4) */
  id: string;
  /** Original filename uploaded by the user */
  originalFilename: string;
  /** Absolute path to the uploaded file on disk */
  inputPath: string;
  /** Absolute path to the translated output file (set when completed) */
  outputPath: string | null;
  /** Target language code (e.g. "es", "ru") */
  targetLang: string;
  /** Source language code (e.g. "en") or "auto" */
  sourceLang: string;
  /** Ollama model name */
  model: string;
  /** Current status */
  status: JobStatus;
  /** Progress percentage (0–100) */
  progress: number;
  /** Human-readable status message */
  message: string;
  /** Error message (set when status is "failed") */
  error: string | null;
  /** Timestamp when job was created */
  createdAt: Date;
  /** Timestamp when job completed or failed */
  finishedAt: Date | null;
  /** Book metadata (set after parsing) */
  metadata: BookMetadata | null;
}
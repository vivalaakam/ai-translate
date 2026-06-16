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
 * A binary image extracted from an EPUB or FB2 file.
 * Used to populate the files table in the database.
 */
export interface ExtractedImage {
  /** Original path within the archive (e.g. "OEBPS/images/photo.jpg" or "#cover.png") */
  originalPath: string;
  /** Binary content of the image */
  data: Buffer;
  /** MIME type (e.g. "image/jpeg", "image/png") */
  mimeType: string;
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
  /** Binary images extracted from the archive (path → image data) */
  images: ExtractedImage[];
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
  /** File format (e.g. "epub", "fb2") */
  format?: string;
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
  /** API base URL (default: "http://localhost:11434") */
  baseUrl?: string;
  /** Model name to use for translation (default: "llama3.1") */
  model?: string;
  /** API key for authentication (optional, for remote providers) */
  apiKey?: string;
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

// ─── Database types ──────────────────────────────────────────────────

/**
 * Block types extracted from a book's content documents.
 * Each block is one semantic unit — a paragraph, heading, image, etc.
 */
export type BlockType = 'heading' | 'paragraph' | 'image' | 'list_item' | 'quote' | 'code' | 'table_row' | 'page_break' | 'other';

/**
 * A single block extracted from a book, stored as one row in the blocks table.
 */
export interface Block {
  /** UUID v5 derived from original text (deterministic ID for dedup) */
  id: string;
  /** Foreign key to books.id */
  bookId: string;
  /** Position index within the chapter (0-based, preserves document order) */
  index: number;
  /** Which content document this block belongs to (e.g. "OEBPS/chapter1.xhtml") */
  docPath: string;
  /** Semantic block type */
  type: BlockType;
  /** Original text content in Markdown */
  originalMd: string;
  /** Translated text content in Markdown (null until translated) */
  translatedMd: string | null;
  /** Foreign key to files.id (only set for type="image", null otherwise) */
  fileId: string | null;
  /** Original HTML tag name (e.g. "p", "h1", "img") for reassembly */
  tagName: string;
  /** Additional HTML attributes to preserve during reassembly (JSON string) */
  attributes: string;
}

/**
 * A book record stored in the books table.
 */
export interface BookRecord {
  /** UUID v5 derived from keccak256 of the file contents */
  id: string;
  /** Book title from metadata */
  title: string;
  /** Author name(s) */
  author: string;
  /** Source language code */
  language: string;
  /** Original filename */
  filename: string;
  /** Total number of blocks in this book */
  totalBlocks: number;
  /** Number of translated blocks */
  translatedBlocks: number;
  /** Target language for translation (null if not yet set) */
  targetLang: string | null;
  /** Source language for translation (null if not yet set) */
  sourceLang: string | null;
  /** Model used for translation */
  model: string | null;
  /** Timestamp when book was imported */
  createdAt: string;
  /** Timestamp when translation was completed */
  completedAt: string | null;
}

/**
 * A file record stored in the files table.
 * Stores binary image data with a deterministic ID derived from the content hash.
 */
export interface FileRecord {
  /** UUID v5 derived from keccak256(binary_data) */
  id: string;
  /** Foreign key to books.id */
  bookId: string;
  /** Original path in EPUB/FB2 (e.g. "OEBPS/images/photo.jpg" or "#fb2_image_1") */
  originalPath: string;
  /** MIME type (e.g. "image/jpeg", "image/png") */
  mimeType: string;
  /** Binary image data */
  data: Buffer;
  /** ISO timestamp when file was imported */
  createdAt: string;
}
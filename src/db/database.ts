import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { v5 as uuidv5 } from 'uuid';
import jsSha3 from 'js-sha3';
const keccak256: (data: string | ArrayBuffer | Buffer) => string = (jsSha3 as any).keccak256;
import type { Block, BookRecord, BlockType, FileRecord } from '../types.js';

// UUID v5 namespaces for deterministic IDs
const BOOK_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const BLOCK_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const FILE_NAMESPACE = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';

const DEFAULT_DB_DIR = path.join(process.cwd(), '.data');

/**
 * Generate a deterministic book ID from file contents using keccak256 → UUID v5.
 */
export function generateBookId(fileBuffer: Buffer): string {
  const hash = keccak256(fileBuffer);
  const hashBytes = Buffer.from(hash.slice(0, 32), 'hex');
  const name = hashBytes.toString('hex');
  return uuidv5(name, BOOK_NAMESPACE);
}

/**
 * Generate a deterministic block ID from book ID + original text using UUID v5.
 */
export function generateBlockId(bookId: string, originalText: string): string {
  return uuidv5(`${bookId}:${originalText}`, BLOCK_NAMESPACE);
}

/**
 * Generate a deterministic file ID from binary content using keccak256 → UUID v5.
 */
export function generateFileId(data: Buffer): string {
  const hash = keccak256(data);
  const hashBytes = Buffer.from(hash.slice(0, 32), 'hex');
  const name = hashBytes.toString('hex');
  return uuidv5(name, FILE_NAMESPACE);
}

/**
 * Guess MIME type from file extension.
 */
function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

/**
 * SQLite database manager for books, blocks, and files.
 */
export class TranslateDb {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const dir = dbPath ? path.dirname(dbPath) : DEFAULT_DB_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const resolvedPath = dbPath || path.join(DEFAULT_DB_DIR, 'translate.db');
    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  /**
   * Run database migrations.
   */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS books (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        language TEXT NOT NULL DEFAULT '',
        filename TEXT NOT NULL DEFAULT '',
        total_blocks INTEGER NOT NULL DEFAULT 0,
        translated_blocks INTEGER NOT NULL DEFAULT 0,
        target_lang TEXT,
        source_lang TEXT,
        model TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS blocks (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        block_index INTEGER NOT NULL,
        doc_path TEXT NOT NULL,
        type TEXT NOT NULL,
        original_md TEXT NOT NULL DEFAULT '',
        translated_md TEXT,
        file_id TEXT,
        tag_name TEXT NOT NULL DEFAULT 'p',
        attributes TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        original_path TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        data BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_blocks_book_id ON blocks(book_id);
      CREATE INDEX IF NOT EXISTS idx_blocks_book_doc ON blocks(book_id, doc_path);
      CREATE INDEX IF NOT EXISTS idx_blocks_book_index ON blocks(book_id, block_index);
      CREATE INDEX IF NOT EXISTS idx_blocks_file_id ON blocks(file_id);
      CREATE INDEX IF NOT EXISTS idx_files_book_id ON files(book_id);
      CREATE INDEX IF NOT EXISTS idx_files_original_path ON files(book_id, original_path);
    `);

    // Migration: add file_id column if it doesn't exist (drop old image_base64)
    const cols = this.db.prepare("PRAGMA table_info(blocks)").all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    if (colNames.includes('image_base64') && !colNames.includes('file_id')) {
      this.db.exec(`
        ALTER TABLE blocks ADD COLUMN file_id TEXT REFERENCES files(id) ON DELETE SET NULL;
      `);
    }
  }

  // ─── Book CRUD ─────────────────────────────────────────────

  insertBook(book: Partial<Omit<BookRecord, 'createdAt' | 'completedAt' | 'translatedBlocks'>> & { id: string; title: string; author: string; language: string; filename: string; totalBlocks: number; translatedBlocks?: number }): void {
    this.db.prepare(`
      INSERT INTO books (id, title, author, language, filename, total_blocks, translated_blocks, target_lang, source_lang, model)
      VALUES (@id, @title, @author, @language, @filename, @totalBlocks, @translatedBlocks, @targetLang, @sourceLang, @model)
    `).run({
      id: book.id,
      title: book.title,
      author: book.author,
      language: book.language,
      filename: book.filename,
      totalBlocks: book.totalBlocks,
      translatedBlocks: book.translatedBlocks ?? 0,
      targetLang: book.targetLang ?? null,
      sourceLang: book.sourceLang ?? null,
      model: book.model ?? null,
    });
  }

  getBook(id: string): BookRecord | undefined {
    const row = this.db.prepare('SELECT * FROM books WHERE id = ?').get(id) as Record<string, any> | undefined;
    if (!row) return undefined;
    return this.mapBookRow(row);
  }

  updateBookProgress(bookId: string, translatedBlocks: number): void {
    this.db.prepare(`
      UPDATE books SET translated_blocks = ? WHERE id = ?
    `).run(translatedBlocks, bookId);
  }

  completeBook(bookId: string): void {
    this.db.prepare(`
      UPDATE books SET completed_at = datetime('now'), translated_blocks = total_blocks WHERE id = ?
    `).run(bookId);
  }

  setBookTranslationConfig(bookId: string, targetLang: string, sourceLang: string, model: string): void {
    this.db.prepare(`
      UPDATE books SET target_lang = ?, source_lang = ?, model = ? WHERE id = ?
    `).run(targetLang, sourceLang, model, bookId);
  }

  listBooks(): BookRecord[] {
    const rows = this.db.prepare('SELECT * FROM books ORDER BY created_at DESC').all() as Record<string, any>[];
    return rows.map(this.mapBookRow);
  }

  deleteBook(bookId: string): void {
    this.db.prepare('DELETE FROM blocks WHERE book_id = ?').run(bookId);
    this.db.prepare('DELETE FROM files WHERE book_id = ?').run(bookId);
    this.db.prepare('DELETE FROM books WHERE id = ?').run(bookId);
  }

  // ─── Block CRUD ────────────────────────────────────────────

  insertBlocks(blocks: Block[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO blocks (id, book_id, block_index, doc_path, type, original_md, translated_md, file_id, tag_name, attributes)
      VALUES (@id, @bookId, @blockIndex, @docPath, @type, @originalMd, @translatedMd, @fileId, @tagName, @attributes)
    `);

    const insertMany = this.db.transaction((items: Block[]) => {
      for (const b of items) {
        stmt.run({
          id: b.id,
          bookId: b.bookId,
          blockIndex: b.index,
          docPath: b.docPath,
          type: b.type,
          originalMd: b.originalMd,
          translatedMd: b.translatedMd,
          fileId: b.fileId,
          tagName: b.tagName,
          attributes: b.attributes,
        });
      }
    });

    insertMany(blocks);
  }

  getBlocksByBook(bookId: string): Block[] {
    const rows = this.db.prepare(
      'SELECT * FROM blocks WHERE book_id = ? ORDER BY block_index'
    ).all(bookId) as Record<string, any>[];
    return rows.map(this.mapBlockRow);
  }

  getBlocksByDoc(bookId: string, docPath: string): Block[] {
    const rows = this.db.prepare(
      'SELECT * FROM blocks WHERE book_id = ? AND doc_path = ? ORDER BY block_index'
    ).all(bookId, docPath) as Record<string, any>[];
    return rows.map(this.mapBlockRow);
  }

  getUntranslatedBlocks(bookId: string): Block[] {
    const rows = this.db.prepare(
      "SELECT * FROM blocks WHERE book_id = ? AND translated_md IS NULL AND type != 'image' ORDER BY block_index"
    ).all(bookId) as Record<string, any>[];
    return rows.map(this.mapBlockRow);
  }

  getTranslatedBlocks(bookId: string): Block[] {
    const rows = this.db.prepare(
      'SELECT * FROM blocks WHERE book_id = ? AND translated_md IS NOT NULL ORDER BY block_index'
    ).all(bookId) as Record<string, any>[];
    return rows.map(this.mapBlockRow);
  }

  updateBlockTranslation(blockId: string, translatedMd: string): void {
    this.db.prepare(`
      UPDATE blocks SET translated_md = ? WHERE id = ?
    `).run(translatedMd, blockId);
  }

  countBlocks(bookId: string): { total: number; translated: number } {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN translated_md IS NOT NULL THEN 1 ELSE 0 END) as translated
      FROM blocks WHERE book_id = ?
    `).get(bookId) as Record<string, number>;
    return { total: row.total, translated: row.translated ?? 0 };
  }

  getDocPaths(bookId: string): string[] {
    const rows = this.db.prepare(
      'SELECT DISTINCT doc_path FROM blocks WHERE book_id = ? ORDER BY doc_path'
    ).all(bookId) as Record<string, string>[];
    return rows.map(r => r.doc_path);
  }

  // ─── File CRUD ─────────────────────────────────────────────

  /**
   * Insert a file record. If a file with the same id already exists, it is replaced.
   * The id is derived from keccak256 of the binary data — deduplication by content.
   */
  insertFile(file: FileRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO files (id, book_id, original_path, mime_type, data, created_at)
      VALUES (@id, @bookId, @originalPath, @mimeType, @data, @createdAt)
    `).run({
      id: file.id,
      bookId: file.bookId,
      originalPath: file.originalPath,
      mimeType: file.mimeType,
      data: file.data,
      createdAt: file.createdAt,
    });
  }

  /**
   * Insert multiple file records in a transaction.
   */
  insertFiles(files: FileRecord[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO files (id, book_id, original_path, mime_type, data, created_at)
      VALUES (@id, @bookId, @originalPath, @mimeType, @data, @createdAt)
    `);

    const insertMany = this.db.transaction((items: FileRecord[]) => {
      for (const f of items) {
        stmt.run({
          id: f.id,
          bookId: f.bookId,
          originalPath: f.originalPath,
          mimeType: f.mimeType,
          data: f.data,
          createdAt: f.createdAt,
        });
      }
    });

    insertMany(files);
  }

  /**
   * Get a file record by ID (without binary data for metadata queries).
   */
  getFile(id: string): FileRecord | undefined {
    const row = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as Record<string, any> | undefined;
    if (!row) return undefined;
    return this.mapFileRow(row);
  }

  /**
   * Get a file record by book ID and original path.
   */
  getFileByPath(bookId: string, originalPath: string): FileRecord | undefined {
    const row = this.db.prepare(
      'SELECT * FROM files WHERE book_id = ? AND original_path = ?'
    ).get(bookId, originalPath) as Record<string, any> | undefined;
    if (!row) return undefined;
    return this.mapFileRow(row);
  }

  /**
   * Get all files for a book.
   */
  getFilesByBook(bookId: string): FileRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM files WHERE book_id = ?'
    ).all(bookId) as Record<string, any>[];
    return rows.map(this.mapFileRow);
  }

  /**
   * Delete all files for a book.
   */
  deleteFilesByBook(bookId: string): void {
    this.db.prepare('DELETE FROM files WHERE book_id = ?').run(bookId);
  }

  // ─── General ───────────────────────────────────────────────

  close(): void {
    this.db.close();
  }

  get raw(): Database.Database {
    return this.db;
  }

  // ─── Private helpers ──────────────────────────────────────

  private mapBookRow(row: Record<string, any>): BookRecord {
    return {
      id: row.id,
      title: row.title,
      author: row.author,
      language: row.language,
      filename: row.filename,
      totalBlocks: row.total_blocks,
      translatedBlocks: row.translated_blocks,
      targetLang: row.target_lang,
      sourceLang: row.source_lang,
      model: row.model,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }

  private mapBlockRow(row: Record<string, any>): Block {
    return {
      id: row.id,
      bookId: row.book_id,
      index: row.block_index,
      docPath: row.doc_path,
      type: row.type as BlockType,
      originalMd: row.original_md,
      translatedMd: row.translated_md,
      fileId: row.file_id,
      tagName: row.tag_name,
      attributes: row.attributes,
    };
  }

  private mapFileRow(row: Record<string, any>): FileRecord {
    return {
      id: row.id,
      bookId: row.book_id,
      originalPath: row.original_path,
      mimeType: row.mime_type,
      data: row.data, // Buffer from BLOB
      createdAt: row.created_at,
    };
  }
}
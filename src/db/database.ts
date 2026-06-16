import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { v5 as uuidv5 } from 'uuid';
import { keccak256 } from 'js-sha3';
import type { Block, BookRecord, BlockType } from '../types.js';

// UUID v5 namespace for book IDs (keccak256-based)
const BOOK_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // DNS namespace as base
// UUID v5 namespace for block IDs (text-based)
const BLOCK_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'; // URL namespace as base

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
 * SQLite database manager for books and translation blocks.
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
        image_base64 TEXT,
        tag_name TEXT NOT NULL DEFAULT 'p',
        attributes TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_blocks_book_id ON blocks(book_id);
      CREATE INDEX IF NOT EXISTS idx_blocks_book_doc ON blocks(book_id, doc_path);
      CREATE INDEX IF NOT EXISTS idx_blocks_book_index ON blocks(book_id, block_index);
    `);
  }

  /**
   * Insert a new book record.
   */
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

  /**
   * Get a book record by ID.
   */
  getBook(id: string): BookRecord | undefined {
    const row = this.db.prepare('SELECT * FROM books WHERE id = ?').get(id) as Record<string, any> | undefined;
    if (!row) return undefined;
    return this.mapBookRow(row);
  }

  /**
   * Update a book's translation progress.
   */
  updateBookProgress(bookId: string, translatedBlocks: number): void {
    this.db.prepare(`
      UPDATE books SET translated_blocks = ? WHERE id = ?
    `).run(translatedBlocks, bookId);
  }

  /**
   * Mark a book's translation as completed.
   */
  completeBook(bookId: string): void {
    this.db.prepare(`
      UPDATE books SET completed_at = datetime('now'), translated_blocks = total_blocks WHERE id = ?
    `).run(bookId);
  }

  /**
   * Set target/source language and model on a book.
   */
  setBookTranslationConfig(bookId: string, targetLang: string, sourceLang: string, model: string): void {
    this.db.prepare(`
      UPDATE books SET target_lang = ?, source_lang = ?, model = ? WHERE id = ?
    `).run(targetLang, sourceLang, model, bookId);
  }

  /**
   * Insert blocks in bulk (within a transaction).
   */
  insertBlocks(blocks: Block[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO blocks (id, book_id, block_index, doc_path, type, original_md, translated_md, image_base64, tag_name, attributes)
      VALUES (@id, @bookId, @blockIndex, @docPath, @type, @originalMd, @translatedMd, @imageBase64, @tagName, @attributes)
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
          imageBase64: b.imageBase64,
          tagName: b.tagName,
          attributes: b.attributes,
        });
      }
    });

    insertMany(blocks);
  }

  /**
   * Get all blocks for a book, ordered by index.
   */
  getBlocksByBook(bookId: string): Block[] {
    const rows = this.db.prepare(
      'SELECT * FROM blocks WHERE book_id = ? ORDER BY block_index'
    ).all(bookId) as Record<string, any>[];
    return rows.map(this.mapBlockRow);
  }

  /**
   * Get blocks for a specific content document.
   */
  getBlocksByDoc(bookId: string, docPath: string): Block[] {
    const rows = this.db.prepare(
      'SELECT * FROM blocks WHERE book_id = ? AND doc_path = ? ORDER BY block_index'
    ).all(bookId, docPath) as Record<string, any>[];
    return rows.map(this.mapBlockRow);
  }

  /**
   * Get blocks that haven't been translated yet.
   */
  getUntranslatedBlocks(bookId: string): Block[] {
    const rows = this.db.prepare(
      "SELECT * FROM blocks WHERE book_id = ? AND translated_md IS NULL AND type != 'image' ORDER BY block_index"
    ).all(bookId) as Record<string, any>[];
    return rows.map(this.mapBlockRow);
  }

  /**
   * Get translated blocks for a book.
   */
  getTranslatedBlocks(bookId: string): Block[] {
    const rows = this.db.prepare(
      'SELECT * FROM blocks WHERE book_id = ? AND translated_md IS NOT NULL ORDER BY block_index'
    ).all(bookId) as Record<string, any>[];
    return rows.map(this.mapBlockRow);
  }

  /**
   * Update a single block's translation.
   */
  updateBlockTranslation(blockId: string, translatedMd: string): void {
    this.db.prepare(`
      UPDATE blocks SET translated_md = ? WHERE id = ?
    `).run(translatedMd, blockId);
  }

  /**
   * Count blocks for a book.
   */
  countBlocks(bookId: string): { total: number; translated: number } {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN translated_md IS NOT NULL THEN 1 ELSE 0 END) as translated
      FROM blocks WHERE book_id = ?
    `).get(bookId) as Record<string, number>;
    return { total: row.total, translated: row.translated ?? 0 };
  }

  /**
   * Get all distinct doc paths for a book.
   */
  getDocPaths(bookId: string): string[] {
    const rows = this.db.prepare(
      'SELECT DISTINCT doc_path FROM blocks WHERE book_id = ? ORDER BY doc_path'
    ).all(bookId) as Record<string, string>[];
    return rows.map(r => r.doc_path);
  }

  /**
   * Delete a book and all its blocks.
   */
  deleteBook(bookId: string): void {
    this.db.prepare('DELETE FROM blocks WHERE book_id = ?').run(bookId);
    this.db.prepare('DELETE FROM books WHERE id = ?').run(bookId);
  }

  /**
   * List all books.
   */
  listBooks(): BookRecord[] {
    const rows = this.db.prepare('SELECT * FROM books ORDER BY created_at DESC').all() as Record<string, any>[];
    return rows.map(this.mapBookRow);
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  /**
   * Get the raw better-sqlite3 instance (for advanced use).
   */
  get raw(): Database.Database {
    return this.db;
  }

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
      imageBase64: row.image_base64,
      tagName: row.tag_name,
      attributes: row.attributes,
    };
  }
}
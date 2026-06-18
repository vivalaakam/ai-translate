import path from 'path';
import { Pool, PoolClient, types } from 'pg';
import { v5 as uuidv5 } from 'uuid';
import jsSha3 from 'js-sha3';
const keccak256: (data: string | ArrayBuffer | Buffer) => string = (jsSha3 as any).keccak256;
import type { Block, BookRecord, BlockType, FileRecord, TranslationRecord } from '../types.js';

// UUID v5 namespaces for deterministic IDs
const BOOK_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const BLOCK_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const FILE_NAMESPACE = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';
const TRANSLATION_NAMESPACE = '6ba7b813-9dad-11d1-80b4-00c04fd430c8';

// Make pg return BYTEA as Buffer (OID 17)
types.setTypeParser(17, (val: string) => Buffer.from(val, 'hex'));

// Parse timestamp as ISO string (OID 1184)
types.setTypeParser(1184, (val: string) => val);

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
 * Generate a deterministic translation ID from blockId + lang + model.
 */
export function generateTranslationId(blockId: string, lang: string, model: string): string {
  return uuidv5(`${blockId}:${lang}:${model}`, TRANSLATION_NAMESPACE);
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

let _pool: Pool | null = null;

function getPool(connectionString?: string): Pool {
  if (!_pool || _pool.ended) {
    _pool = new Pool({
      connectionString: connectionString || process.env.DATABASE_URL,
      max: 10,
    });
  }
  return _pool;
}

/**
 * PostgreSQL database manager for books, blocks, translations, and files.
 */
export class TranslateDb {
  private pool: Pool;

  constructor(connectionString?: string) {
    this.pool = getPool(connectionString);
  }

  /**
   * Run database migrations (idempotent — safe to call on every startup).
   */
  async migrate(): Promise<void> {
    await this.pool.query(`
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
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        original_path TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS blocks (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        block_index INTEGER NOT NULL,
        doc_path TEXT NOT NULL,
        type TEXT NOT NULL,
        original_md TEXT NOT NULL DEFAULT '',
        file_id TEXT,
        tag_name TEXT NOT NULL DEFAULT 'p',
        attributes TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS translations (
        id TEXT PRIMARY KEY,
        block_id TEXT NOT NULL,
        translated_md TEXT NOT NULL,
        lang TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_blocks_book_id ON blocks(book_id);
      CREATE INDEX IF NOT EXISTS idx_blocks_book_doc ON blocks(book_id, doc_path);
      CREATE INDEX IF NOT EXISTS idx_blocks_book_index ON blocks(book_id, block_index);
      CREATE INDEX IF NOT EXISTS idx_blocks_file_id ON blocks(file_id);
      CREATE INDEX IF NOT EXISTS idx_files_book_id ON files(book_id);
      CREATE INDEX IF NOT EXISTS idx_files_original_path ON files(book_id, original_path);
      CREATE INDEX IF NOT EXISTS idx_translations_block_id ON translations(block_id);
      CREATE INDEX IF NOT EXISTS idx_translations_block_lang ON translations(block_id, lang);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_translations_unique ON translations(block_id, lang, model);
    `);
  }

  // ─── Book CRUD ─────────────────────────────────────────────

  async insertBook(book: Partial<Omit<BookRecord, 'createdAt' | 'completedAt' | 'translatedBlocks'>> & { id: string; title: string; author: string; language: string; filename: string; totalBlocks: number; translatedBlocks?: number }): Promise<void> {
    await this.pool.query(`
      INSERT INTO books (id, title, author, language, filename, total_blocks, translated_blocks, target_lang, source_lang, model)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (id) DO NOTHING
    `, [
      book.id,
      book.title,
      book.author,
      book.language,
      book.filename,
      book.totalBlocks,
      book.translatedBlocks ?? 0,
      book.targetLang ?? null,
      book.sourceLang ?? null,
      book.model ?? null,
    ]);
  }

  async getBook(id: string): Promise<BookRecord | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM books WHERE id = $1', [id]);
    if (rows.length === 0) return undefined;
    return this.mapBookRow(rows[0]);
  }

  async updateBookProgress(bookId: string, translatedBlocks: number): Promise<void> {
    await this.pool.query('UPDATE books SET translated_blocks = $1 WHERE id = $2', [translatedBlocks, bookId]);
  }

  async completeBook(bookId: string): Promise<void> {
    await this.pool.query(`
      UPDATE books SET completed_at = now(), translated_blocks = total_blocks WHERE id = $1
    `, [bookId]);
  }

  async setBookTranslationConfig(bookId: string, targetLang: string, sourceLang: string, model: string): Promise<void> {
    await this.pool.query(`
      UPDATE books SET target_lang = $1, source_lang = $2, model = $3 WHERE id = $4
    `, [targetLang, sourceLang, model, bookId]);
  }

  async listBooks(): Promise<BookRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM books ORDER BY created_at DESC');
    return rows.map((r: Record<string, any>) => this.mapBookRow(r));
  }

  async deleteBook(bookId: string): Promise<void> {
    await this.pool.query('DELETE FROM blocks WHERE book_id = $1', [bookId]);
    await this.pool.query('DELETE FROM files WHERE book_id = $1', [bookId]);
    await this.pool.query('DELETE FROM books WHERE id = $1', [bookId]);
  }

  // ─── Block CRUD ────────────────────────────────────────────

  async insertBlocks(blocks: Block[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const b of blocks) {
        await client.query(`
          INSERT INTO blocks (id, book_id, block_index, doc_path, type, original_md, file_id, tag_name, attributes)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (id) DO NOTHING
        `, [
          b.id, b.bookId, b.index, b.docPath, b.type,
          b.originalMd, b.fileId, b.tagName, b.attributes,
        ]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async getBlocksByBook(bookId: string): Promise<Block[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM blocks WHERE book_id = $1 ORDER BY block_index', [bookId]
    );
    return rows.map((r: Record<string, any>) => this.mapBlockRow(r));
  }

  async getBlocksByDoc(bookId: string, docPath: string): Promise<Block[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM blocks WHERE book_id = $1 AND doc_path = $2 ORDER BY block_index',
      [bookId, docPath]
    );
    return rows.map((r: Record<string, any>) => this.mapBlockRow(r));
  }

  /**
   * Get blocks that have no translation in the given target language.
   * Skips image blocks (they don't need translation).
   */
  async getUntranslatedBlocks(bookId: string, targetLang: string): Promise<Block[]> {
    const { rows } = await this.pool.query(`
      SELECT b.* FROM blocks b
      WHERE b.book_id = $1
        AND b.type != 'image'
        AND NOT EXISTS (
          SELECT 1 FROM translations t WHERE t.block_id = b.id AND t.lang = $2
        )
      ORDER BY b.block_index
    `, [bookId, targetLang]);
    return rows.map((r: Record<string, any>) => this.mapBlockRow(r));
  }

  /**
   * Get all blocks with their translations for a specific language joined in.
   * Returns blocks with `translatedMd` set from the translations table.
   * If model is specified, filters to that model only; otherwise picks the latest translation per block.
   */
  async getBlocksByBookWithTranslations(bookId: string, targetLang: string, model?: string): Promise<Block[]> {
    const { rows } = await this.pool.query(`
      SELECT b.*, t.translated_md AS translated_md
      FROM blocks b
      LEFT JOIN LATERAL (
        SELECT translated_md
        FROM translations t
        WHERE t.block_id = b.id AND t.lang = $2
          ${model ? 'AND t.model = $3' : ''}
        ORDER BY t.created_at DESC
        LIMIT 1
      ) t ON true
      WHERE b.book_id = $1
      ORDER BY b.block_index
    `, model ? [bookId, targetLang, model] : [bookId, targetLang]);

    return rows.map((r: Record<string, any>) => ({
      ...this.mapBlockRow(r),
      translatedMd: r.translated_md ?? null,
    }));
  }

  /**
   * Get blocks for a specific document with translations joined in.
   */
  async getBlocksByDocWithTranslations(bookId: string, docPath: string, targetLang: string, model?: string): Promise<Block[]> {
    const params: any[] = [bookId, targetLang, docPath];
    let modelFilter = '';
    if (model) {
      modelFilter = 'AND t.model = $4';
      params.push(model);
    }
    const { rows } = await this.pool.query(`
      SELECT b.*, t.translated_md AS translated_md
      FROM blocks b
      LEFT JOIN LATERAL (
        SELECT translated_md
        FROM translations t
        WHERE t.block_id = b.id AND t.lang = $2
          ${modelFilter}
        ORDER BY t.created_at DESC
        LIMIT 1
      ) t ON true
      WHERE b.book_id = $1 AND b.doc_path = $3
      ORDER BY b.block_index
    `, params);

    return rows.map((r: Record<string, any>) => ({
      ...this.mapBlockRow(r),
      translatedMd: r.translated_md ?? null,
    }));
  }

  async countBlocks(bookId: string, targetLang?: string): Promise<{ total: number; translated: number }> {
    if (targetLang) {
      const { rows } = await this.pool.query(`
        SELECT
          COUNT(*) as total,
          COALESCE(SUM(CASE WHEN t.block_id IS NOT NULL THEN 1 ELSE 0 END), 0) as translated
        FROM blocks b
        LEFT JOIN (
          SELECT DISTINCT block_id FROM translations WHERE lang = $2
        ) t ON t.block_id = b.id
        WHERE b.book_id = $1
      `, [bookId, targetLang]);
      return { total: parseInt(rows[0].total), translated: parseInt(rows[0].translated) };
    }
    const { rows } = await this.pool.query(`
      SELECT COUNT(*) as total, 0 as translated FROM blocks WHERE book_id = $1
    `, [bookId]);
    return { total: parseInt(rows[0].total), translated: 0 };
  }

  async getDocPaths(bookId: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      'SELECT doc_path, MIN(block_index) AS min_idx FROM blocks WHERE book_id = $1 GROUP BY doc_path ORDER BY min_idx',
      [bookId]
    );
    return rows.map((r: Record<string, any>) => r.doc_path);
  }

  // ─── Translation CRUD ──────────────────────────────────────

  /**
   * Insert or update a translation for a block.
   * Uses ON CONFLICT to upsert by (block_id, lang, model).
   */
  async upsertTranslation(blockId: string, translatedMd: string, lang: string, model: string): Promise<void> {
    const id = generateTranslationId(blockId, lang, model);
    await this.pool.query(`
      INSERT INTO translations (id, block_id, translated_md, lang, model)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO UPDATE SET translated_md = EXCLUDED.translated_md, created_at = now()
    `, [id, blockId, translatedMd, lang, model]);
  }

  /**
   * Get all translations for a block.
   */
  async getTranslationsByBlock(blockId: string): Promise<TranslationRecord[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM translations WHERE block_id = $1 ORDER BY created_at DESC',
      [blockId]
    );
    return rows.map((r: Record<string, any>) => this.mapTranslationRow(r));
  }

  /**
   * Get the latest translation for a block in a specific language.
   */
  async getTranslation(blockId: string, lang: string, model?: string): Promise<TranslationRecord | undefined> {
    let query = 'SELECT * FROM translations WHERE block_id = $1 AND lang = $2';
    const params: any[] = [blockId, lang];
    if (model) {
      query += ' AND model = $3';
      params.push(model);
    }
    query += ' ORDER BY created_at DESC LIMIT 1';
    const { rows } = await this.pool.query(query, params);
    if (rows.length === 0) return undefined;
    return this.mapTranslationRow(rows[0]);
  }

  // ─── File CRUD ─────────────────────────────────────────────

  /**
   * Insert a file record. If a file with the same id already exists, it is replaced.
   * The id is derived from keccak256 of the binary data — deduplication by content.
   */
  async insertFile(file: FileRecord): Promise<void> {
    await this.pool.query(`
      INSERT INTO files (id, book_id, original_path, mime_type, data, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO NOTHING
    `, [file.id, file.bookId, file.originalPath, file.mimeType, file.data, file.createdAt]);
  }

  /**
   * Insert multiple file records in a transaction.
   */
  async insertFiles(files: FileRecord[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const f of files) {
        await client.query(`
          INSERT INTO files (id, book_id, original_path, mime_type, data, created_at)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (id) DO NOTHING
        `, [f.id, f.bookId, f.originalPath, f.mimeType, f.data, f.createdAt]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Get a file record by ID.
   */
  async getFile(id: string): Promise<FileRecord | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM files WHERE id = $1', [id]);
    if (rows.length === 0) return undefined;
    return this.mapFileRow(rows[0]);
  }

  /**
   * Get a file record by book ID and original path.
   */
  async getFileByPath(bookId: string, originalPath: string): Promise<FileRecord | undefined> {
    const { rows } = await this.pool.query(
      'SELECT * FROM files WHERE book_id = $1 AND original_path = $2',
      [bookId, originalPath]
    );
    if (rows.length === 0) return undefined;
    return this.mapFileRow(rows[0]);
  }

  /**
   * Get all files for a book.
   */
  async getFilesByBook(bookId: string): Promise<FileRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM files WHERE book_id = $1', [bookId]);
    return rows.map((r: Record<string, any>) => this.mapFileRow(r));
  }

  /**
   * Delete all files for a book.
   */
  async deleteFilesByBook(bookId: string): Promise<void> {
    await this.pool.query('DELETE FROM files WHERE book_id = $1', [bookId]);
  }

  // ─── General ───────────────────────────────────────────────

  async close(): Promise<void> {
    // Don't close the pool — it's shared. Just release any client references.
    // The pool is closed on process exit.
  }

  /**
   * Close the underlying pool (for tests / explicit shutdown).
   */
  static async closePool(): Promise<void> {
    if (_pool && !_pool.ended) {
      await _pool.end();
      _pool = null;
    }
  }

  get raw(): Pool {
    return this.pool;
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
      translatedMd: row.translated_md ?? null,
      fileId: row.file_id,
      tagName: row.tag_name,
      attributes: row.attributes,
    };
  }

  private mapTranslationRow(row: Record<string, any>): TranslationRecord {
    return {
      id: row.id,
      blockId: row.block_id,
      translatedMd: row.translated_md,
      lang: row.lang,
      model: row.model,
      createdAt: row.created_at,
    };
  }

  private mapFileRow(row: Record<string, any>): FileRecord {
    return {
      id: row.id,
      bookId: row.book_id,
      originalPath: row.original_path,
      mimeType: row.mime_type,
      data: row.data, // Buffer from BYTEA
      createdAt: row.created_at,
    };
  }
}
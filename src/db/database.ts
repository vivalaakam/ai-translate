import path from 'path';
import { Pool, types } from 'pg';
import { v5 as uuidv5 } from 'uuid';
import jsSha3 from 'js-sha3';
const keccak256: (data: string | ArrayBuffer | Buffer) => string = (jsSha3 as any).keccak256;
import { DATABASE_URL } from '../utils/constants.js';
import type { Block, BookRecord, BlockType, FileRecord, TaskRecord } from '../types.js';

// UUID v5 namespaces for deterministic IDs
const BOOK_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const BLOCK_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const FILE_NAMESPACE = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';
const TRANSLATION_NAMESPACE = '6ba7b813-9dad-11d1-80b4-00c04fd430c8';

// Make pg return BYTEA as Buffer (OID 17).
// pg natively returns BYTEA as Buffer in binary mode; in text mode it returns
// a "\\x<hex>" string. We normalize both to Buffer.
types.setTypeParser(17, (val: string | Buffer) => {
  if (Buffer.isBuffer(val)) return val;
  if (typeof val !== 'string') return Buffer.from(val);
  // pg text format: \x<hex>
  if (val.startsWith('\\x')) {
    return Buffer.from(val.slice(2), 'hex');
  }
  return Buffer.from(val, 'hex');
});

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
 * Generate a deterministic translation block ID from sourceBlockId + lang + model.
 */
export function generateTranslationId(sourceBlockId: string, lang: string, model: string): string {
  return uuidv5(`${sourceBlockId}:${lang}:${model}`, TRANSLATION_NAMESPACE);
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
      connectionString: connectionString || process.env.DATABASE_URL || DATABASE_URL,
      max: 10,
    });
  }
  return _pool;
}

/**
 * PostgreSQL database manager for docs, blocks, and files.
 *
 * The blocks table stores both originals and translations:
 *   - Original: lang = source lang, model = NULL, source_id = NULL
 *   - Translation: lang = target lang, model = model name, source_id = original block ID
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
    // Migrate: rename books → docs (for existing databases)
    await this.pool.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'books') THEN
          ALTER TABLE books RENAME TO docs;
        END IF;
      END $$;
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS docs (
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
        FOREIGN KEY (book_id) REFERENCES docs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS blocks (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        block_index INTEGER NOT NULL,
        doc_path TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        lang TEXT NOT NULL,
        model TEXT,
        source_id TEXT,
        file_id TEXT,
        tag_name TEXT NOT NULL DEFAULT 'p',
        attributes TEXT NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        FOREIGN KEY (book_id) REFERENCES docs(id) ON DELETE CASCADE,
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'ocr_page',
        page_num INTEGER,
        total_pages INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        content TEXT,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at TIMESTAMPTZ,
        FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_blocks_book_id ON blocks(book_id);
      CREATE INDEX IF NOT EXISTS idx_blocks_book_doc ON blocks(book_id, doc_path);
      CREATE INDEX IF NOT EXISTS idx_blocks_book_index ON blocks(book_id, block_index);
      CREATE INDEX IF NOT EXISTS idx_blocks_file_id ON blocks(file_id);
      CREATE INDEX IF NOT EXISTS idx_blocks_source_id ON blocks(source_id);
      CREATE INDEX IF NOT EXISTS idx_blocks_lang ON blocks(book_id, lang);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_translation_unique ON blocks(source_id, lang, model) WHERE source_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_files_book_id ON files(book_id);
      CREATE INDEX IF NOT EXISTS idx_files_original_path ON files(book_id, original_path);
      CREATE INDEX IF NOT EXISTS idx_tasks_doc_id ON tasks(doc_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_doc_status ON tasks(doc_id, status);
    `);

    // Add new columns to docs table (idempotent — ADD COLUMN IF NOT EXISTS)
    await this.pool.query(`
      ALTER TABLE docs ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'uploaded';
      ALTER TABLE docs ADD COLUMN IF NOT EXISTS total_pages INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE docs ADD COLUMN IF NOT EXISTS parsed_pages INTEGER NOT NULL DEFAULT 0;
    `);
  }

  // ─── Doc CRUD ─────────────────────────────────────────────

  async insertBook(book: Partial<Omit<BookRecord, 'createdAt' | 'completedAt' | 'translatedBlocks'>> & { id: string; title: string; author: string; language: string; filename: string; totalBlocks: number; translatedBlocks?: number }): Promise<void> {
    await this.pool.query(`
      INSERT INTO docs (id, title, author, language, filename, total_blocks, translated_blocks, target_lang, source_lang, model, status, total_pages, parsed_pages)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
      book.status ?? 'uploaded',
      book.totalPages ?? 0,
      book.parsedPages ?? 0,
    ]);
  }

  async getBook(id: string): Promise<BookRecord | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM docs WHERE id = $1', [id]);
    if (rows.length === 0) return undefined;
    return this.mapBookRow(rows[0]);
  }

  async updateBookProgress(bookId: string, translatedBlocks: number): Promise<void> {
    await this.pool.query('UPDATE docs SET translated_blocks = $1 WHERE id = $2', [translatedBlocks, bookId]);
  }

  async completeBook(bookId: string): Promise<void> {
    await this.pool.query(`
      UPDATE docs SET completed_at = now(), translated_blocks = total_blocks WHERE id = $1
    `, [bookId]);
  }

  async setBookTranslationConfig(bookId: string, targetLang: string, sourceLang: string, model: string): Promise<void> {
    await this.pool.query(`
      UPDATE docs SET target_lang = $1, source_lang = $2, model = $3 WHERE id = $4
    `, [targetLang, sourceLang, model, bookId]);
  }

  async listBooks(): Promise<BookRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM docs ORDER BY created_at DESC');
    return rows.map((r: Record<string, any>) => this.mapBookRow(r));
  }

  async deleteBook(bookId: string): Promise<void> {
    await this.pool.query('DELETE FROM blocks WHERE book_id = $1', [bookId]);
    await this.pool.query('DELETE FROM files WHERE book_id = $1', [bookId]);
    await this.pool.query('DELETE FROM docs WHERE id = $1', [bookId]);
  }

  // ─── Block CRUD ────────────────────────────────────────────

  /**
   * Insert original blocks (lang set on each block, model = NULL, sourceId = NULL).
   * Uses ON CONFLICT (id) DO NOTHING for dedup.
   */
  async insertBlocks(blocks: Block[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const b of blocks) {
        await client.query(`
          INSERT INTO blocks (id, book_id, block_index, doc_path, type, content, lang, model, source_id, file_id, tag_name, attributes)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (id) DO NOTHING
        `, [
          b.id, b.bookId, b.index, b.docPath, b.type,
          b.content, b.lang, b.model ?? null, b.sourceId ?? null,
          b.fileId, b.tagName, b.attributes,
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

  /**
   * Get all original blocks for a book (where source_id IS NULL).
   */
  async getBlocksByBook(bookId: string): Promise<Block[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM blocks WHERE book_id = $1 AND source_id IS NULL ORDER BY block_index',
      [bookId]
    );
    return rows.map((r: Record<string, any>) => this.mapBlockRow(r));
  }

  /**
   * Get original blocks for a specific document.
   */
  async getBlocksByDoc(bookId: string, docPath: string): Promise<Block[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM blocks WHERE book_id = $1 AND doc_path = $2 AND source_id IS NULL ORDER BY block_index',
      [bookId, docPath]
    );
    return rows.map((r: Record<string, any>) => this.mapBlockRow(r));
  }

  /**
   * Get original blocks that have no translation in the given target language.
   * If model is specified, only checks for translations by that exact model.
   * Skips image blocks (they don't need translation).
   */
  async getUntranslatedBlocks(bookId: string, targetLang: string, model?: string): Promise<Block[]> {
    if (model) {
      const { rows } = await this.pool.query(`
        SELECT b.* FROM blocks b
        WHERE b.book_id = $1
          AND b.source_id IS NULL
          AND b.type != 'image'
          AND NOT EXISTS (
            SELECT 1 FROM blocks t WHERE t.source_id = b.id AND t.lang = $2 AND t.model = $3
          )
        ORDER BY b.block_index
      `, [bookId, targetLang, model]);
      return rows.map((r: Record<string, any>) => this.mapBlockRow(r));
    }
    const { rows } = await this.pool.query(`
      SELECT b.* FROM blocks b
      WHERE b.book_id = $1
        AND b.source_id IS NULL
        AND b.type != 'image'
        AND NOT EXISTS (
          SELECT 1 FROM blocks t WHERE t.source_id = b.id AND t.lang = $2
        )
      ORDER BY b.block_index
    `, [bookId, targetLang]);
    return rows.map((r: Record<string, any>) => this.mapBlockRow(r));
  }

  /**
   * Get all blocks with translations joined in for a specific language.
   * Returns original blocks with a `translatedContent` field set from translation rows.
   */
  async getBlocksByBookWithTranslations(bookId: string, targetLang: string, model?: string): Promise<Block[]> {
    const { rows } = await this.pool.query(`
      SELECT b.*, t.content AS translated_content
      FROM blocks b
      LEFT JOIN LATERAL (
        SELECT content
        FROM blocks t
        WHERE t.source_id = b.id AND t.lang = $2
          ${model ? 'AND t.model = $3' : ''}
        ORDER BY t.created_at DESC
        LIMIT 1
      ) t ON true
      WHERE b.book_id = $1 AND b.source_id IS NULL
      ORDER BY b.block_index
    `, model ? [bookId, targetLang, model] : [bookId, targetLang]);

    return rows.map((r: Record<string, any>) => ({
      ...this.mapBlockRow(r),
      translatedContent: r.translated_content ?? null,
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
      SELECT b.*, t.content AS translated_content
      FROM blocks b
      LEFT JOIN LATERAL (
        SELECT content
        FROM blocks t
        WHERE t.source_id = b.id AND t.lang = $2
          ${modelFilter}
        ORDER BY t.created_at DESC
        LIMIT 1
      ) t ON true
      WHERE b.book_id = $1 AND b.source_id IS NULL AND b.doc_path = $3
      ORDER BY b.block_index
    `, params);

    return rows.map((r: Record<string, any>) => ({
      ...this.mapBlockRow(r),
      translatedContent: r.translated_content ?? null,
    }));
  }

  async countBlocks(bookId: string, targetLang?: string, model?: string): Promise<{ total: number; translated: number }> {
    if (targetLang) {
      const params: any[] = [bookId, targetLang];
      let modelFilter = '';
      if (model) {
        modelFilter = 'AND model = $3';
        params.push(model);
      }
      const { rows } = await this.pool.query(`
        SELECT
          COUNT(*) as total,
          COALESCE(SUM(CASE WHEN t.source_id IS NOT NULL THEN 1 ELSE 0 END), 0) as translated
        FROM blocks b
        LEFT JOIN (
          SELECT DISTINCT source_id FROM blocks WHERE lang = $2 AND source_id IS NOT NULL ${modelFilter}
        ) t ON t.source_id = b.id
        WHERE b.book_id = $1 AND b.source_id IS NULL
      `, params);
      return { total: parseInt(rows[0].total), translated: parseInt(rows[0].translated) };
    }
    const { rows } = await this.pool.query(`
      SELECT COUNT(*) as total, 0 as translated FROM blocks WHERE book_id = $1 AND source_id IS NULL
    `, [bookId]);
    return { total: parseInt(rows[0].total), translated: 0 };
  }

  async getDocPaths(bookId: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      'SELECT doc_path, MIN(block_index) AS min_idx FROM blocks WHERE book_id = $1 AND source_id IS NULL GROUP BY doc_path ORDER BY min_idx',
      [bookId]
    );
    return rows.map((r: Record<string, any>) => r.doc_path);
  }

  // ─── Translation CRUD (uses blocks table with source_id) ───

  /**
   * Insert or update a translation block.
   * Creates a new block row with source_id pointing to the original block.
   * Uses ON CONFLICT (id) DO UPDATE — id is deterministic from sourceBlockId+lang+model.
   */
  async upsertTranslation(sourceBlock: Block, translatedContent: string, lang: string, model: string): Promise<void> {
    const id = generateTranslationId(sourceBlock.id, lang, model);
    await this.pool.query(`
      INSERT INTO blocks (id, book_id, block_index, doc_path, type, content, lang, model, source_id, file_id, tag_name, attributes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, created_at = now()
    `, [
      id, sourceBlock.bookId, sourceBlock.index, sourceBlock.docPath, sourceBlock.type,
      translatedContent, lang, model, sourceBlock.id,
      sourceBlock.fileId, sourceBlock.tagName, sourceBlock.attributes,
    ]);
  }

  /**
   * Get the latest translation block for a source block in a specific language.
   */
  async getTranslation(sourceBlockId: string, lang: string, model?: string): Promise<Block | undefined> {
    let query = 'SELECT * FROM blocks WHERE source_id = $1 AND lang = $2';
    const params: any[] = [sourceBlockId, lang];
    if (model) {
      query += ' AND model = $3';
      params.push(model);
    }
    query += ' ORDER BY created_at DESC LIMIT 1';
    const { rows } = await this.pool.query(query, params);
    if (rows.length === 0) return undefined;
    return this.mapBlockRow(rows[0]);
  }

  /**
   * Get all translation blocks for a source block.
   */
  async getTranslationsByBlock(sourceBlockId: string): Promise<Block[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM blocks WHERE source_id = $1 ORDER BY created_at DESC',
      [sourceBlockId]
    );
    return rows.map((r: Record<string, any>) => this.mapBlockRow(r));
  }

  // ─── File CRUD ─────────────────────────────────────────────

  async insertFile(file: FileRecord): Promise<void> {
    await this.pool.query(`
      INSERT INTO files (id, book_id, original_path, mime_type, data, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO NOTHING
    `, [file.id, file.bookId, file.originalPath, file.mimeType, file.data, file.createdAt]);
  }

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

  async getFile(id: string): Promise<FileRecord | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM files WHERE id = $1', [id]);
    if (rows.length === 0) return undefined;
    return this.mapFileRow(rows[0]);
  }

  async getFileByPath(bookId: string, originalPath: string): Promise<FileRecord | undefined> {
    const { rows } = await this.pool.query(
      'SELECT * FROM files WHERE book_id = $1 AND original_path = $2',
      [bookId, originalPath]
    );
    if (rows.length === 0) return undefined;
    return this.mapFileRow(rows[0]);
  }

  async getFilesByBook(bookId: string): Promise<FileRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM files WHERE book_id = $1', [bookId]);
    return rows.map((r: Record<string, any>) => this.mapFileRow(r));
  }

  async deleteFilesByBook(bookId: string): Promise<void> {
    await this.pool.query('DELETE FROM files WHERE book_id = $1', [bookId]);
  }

  // ─── Doc status ────────────────────────────────────────────

  async updateDocStatus(docId: string, status: string, extra?: { totalPages?: number; parsedPages?: number }): Promise<void> {
    if (extra?.totalPages !== undefined && extra?.parsedPages !== undefined) {
      await this.pool.query('UPDATE docs SET status = $1, total_pages = $2, parsed_pages = $3 WHERE id = $4', [status, extra.totalPages, extra.parsedPages, docId]);
    } else if (extra?.totalPages !== undefined) {
      await this.pool.query('UPDATE docs SET status = $1, total_pages = $2 WHERE id = $3', [status, extra.totalPages, docId]);
    } else if (extra?.parsedPages !== undefined) {
      await this.pool.query('UPDATE docs SET status = $1, parsed_pages = $2 WHERE id = $3', [status, extra.parsedPages, docId]);
    } else {
      await this.pool.query('UPDATE docs SET status = $1 WHERE id = $2', [status, docId]);
    }
  }

  async updateTotalBlocks(docId: string, totalBlocks: number): Promise<void> {
    await this.pool.query('UPDATE docs SET total_blocks = $1 WHERE id = $2', [totalBlocks, docId]);
  }

  // ─── Task CRUD ─────────────────────────────────────────────

  async createTasks(tasks: Array<{ id: string; docId: string; type: string; pageNum: number; totalPages: number }>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const t of tasks) {
        await client.query(`
          INSERT INTO tasks (id, doc_id, type, page_num, total_pages, status)
          VALUES ($1, $2, $3, $4, $5, 'pending')
          ON CONFLICT (id) DO NOTHING
        `, [t.id, t.docId, t.type, t.pageNum, t.totalPages]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async getNextTask(): Promise<TaskRecord | undefined> {
    const { rows } = await this.pool.query(`
      UPDATE tasks SET status = 'processing', updated_at = now()
      WHERE id = (
        SELECT id FROM tasks WHERE status = 'pending'
        ORDER BY created_at ASC LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `);
    if (rows.length === 0) return undefined;
    return this.mapTaskRow(rows[0]);
  }

  async completeTask(taskId: string, content: string): Promise<void> {
    await this.pool.query(`
      UPDATE tasks SET status = 'completed', content = $1, completed_at = now(), updated_at = now()
      WHERE id = $2
    `, [content, taskId]);
  }

  async failTask(taskId: string, error: string): Promise<void> {
    await this.pool.query(`
      UPDATE tasks SET status = 'failed', error = $1, completed_at = now(), updated_at = now()
      WHERE id = $2
    `, [error, taskId]);
  }

  async getTasksByDoc(docId: string): Promise<TaskRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM tasks WHERE doc_id = $1 ORDER BY page_num', [docId]);
    return rows.map((r: Record<string, any>) => this.mapTaskRow(r));
  }

  async getTaskCounts(docId: string): Promise<{ total: number; completed: number; failed: number; pending: number; processing: number }> {
    const { rows } = await this.pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'failed') as failed,
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'processing') as processing
      FROM tasks WHERE doc_id = $1
    `, [docId]);
    return {
      total: parseInt(rows[0].total),
      completed: parseInt(rows[0].completed),
      failed: parseInt(rows[0].failed),
      pending: parseInt(rows[0].pending),
      processing: parseInt(rows[0].processing),
    };
  }

  async countProcessingTasks(): Promise<number> {
    const { rows } = await this.pool.query(`SELECT COUNT(*) as cnt FROM tasks WHERE status = 'processing'`);
    return parseInt(rows[0].cnt);
  }

  // ─── General ───────────────────────────────────────────────

  async close(): Promise<void> {
    // Don't close the pool — it's shared. Just release any client references.
  }

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
      status: row.status ?? 'uploaded',
      totalPages: row.total_pages ?? 0,
      parsedPages: row.parsed_pages ?? 0,
    };
  }

  private mapBlockRow(row: Record<string, any>): Block {
    return {
      id: row.id,
      bookId: row.book_id,
      index: row.block_index,
      docPath: row.doc_path,
      type: row.type as BlockType,
      content: row.content,
      lang: row.lang,
      model: row.model,
      sourceId: row.source_id,
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
      data: row.data,
      createdAt: row.created_at,
    };
  }

  private mapTaskRow(row: Record<string, any>): TaskRecord {
    return {
      id: row.id,
      docId: row.doc_id,
      type: row.type,
      pageNum: row.page_num,
      totalPages: row.total_pages,
      status: row.status,
      content: row.content,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }
}
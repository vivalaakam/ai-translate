import { v5 as uuidv5 } from 'uuid';
import jsSha3 from 'js-sha3';
import { QueryTypes, sql } from '@sequelize/core';
import type { Block, BookRecord, BlockType, FileRecord, TaskRecord } from '../types.js';
import {
  Doc,
  Block as BlockModel,
  FileModel,
  Task as TaskModel,
  getSequelize,
  closeSequelize,
} from '../models/index.js';
import { runMigrations } from './migrate.js';

const keccak256: (data: string | ArrayBuffer | Buffer) => string = (jsSha3 as any).keccak256;

// UUID v5 namespaces for deterministic IDs
const BOOK_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const BLOCK_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const FILE_NAMESPACE = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';
const TRANSLATION_NAMESPACE = '6ba7b813-9dad-11d1-80b4-00c04fd430c8';

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

/** Normalize a non-null Date/string timestamp into an ISO string. */
function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** Normalize a nullable Date/string timestamp into an ISO string or null. */
function isoOpt(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * PostgreSQL database manager for docs, blocks, and files.
 *
 * Backed by Sequelize 7 models (src/models) and an Umzug migration runner
 * (src/migrations). Simple CRUD goes through the models; relational queries
 * that the ORM cannot express faithfully (LATERAL joins, SKIP LOCKED task
 * claiming, COUNT FILTER, ON CONFLICT DO UPDATE for translations) use
 * `sequelize.query` with raw SQL — the same SQL the previous raw-pg layer used.
 *
 * The blocks table stores both originals and translations:
 *   - Original: lang = source lang, model = NULL, source_id = NULL
 *   - Translation: lang = target lang, model = model name, source_id = original block ID
 */
export class TranslateDb {
  private _sequelize;

  constructor(connectionString?: string) {
    this._sequelize = getSequelize(connectionString);
  }

  /**
   * Run database migrations (idempotent — safe to call on every startup).
   */
  async migrate(): Promise<void> {
    await runMigrations();
  }

  // ─── Doc CRUD ─────────────────────────────────────────────

  async insertBook(book: Partial<Omit<BookRecord, 'createdAt' | 'completedAt' | 'translatedBlocks'>> & { id: string; title: string; author: string; language: string; filename: string; totalBlocks: number; translatedBlocks?: number }): Promise<void> {
    await Doc.bulkCreate([
      {
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
        status: book.status ?? 'uploaded',
        totalPages: book.totalPages ?? 0,
        parsedPages: book.parsedPages ?? 0,
        sourcePath: book.sourcePath ?? null,
      },
    ], { ignoreDuplicates: true, validate: false });
  }

  async getBook(id: string): Promise<BookRecord | undefined> {
    const row = await Doc.findByPk(id, { raw: true });
    return row ? this.toBookRecord(row) : undefined;
  }

  async updateBookProgress(bookId: string, translatedBlocks: number): Promise<void> {
    await Doc.update({ translatedBlocks }, { where: { id: bookId } });
  }

  async completeBook(bookId: string): Promise<void> {
    // References the total_blocks column in the SET — kept as raw SQL.
    await this.sequelize.query(
      'UPDATE docs SET completed_at = now(), translated_blocks = total_blocks WHERE id = $1',
      { bind: [bookId] },
    );
  }

  async setBookTranslationConfig(bookId: string, targetLang: string, sourceLang: string, model: string): Promise<void> {
    await Doc.update({ targetLang, sourceLang, model }, { where: { id: bookId } });
  }

  async listBooks(): Promise<BookRecord[]> {
    const rows = await Doc.findAll({ order: [['createdAt', 'DESC']], raw: true });
    return rows.map((r: Record<string, any>) => this.toBookRecord(r));
  }

  async deleteBook(bookId: string): Promise<void> {
    // FK ON DELETE CASCADE removes blocks, files, and tasks for this doc.
    await Doc.destroy({ where: { id: bookId } });
  }

  // ─── Block CRUD ────────────────────────────────────────────

  /**
   * Insert original blocks (lang set on each block, model = NULL, sourceId = NULL).
   * Uses ON CONFLICT (id) DO NOTHING (via ignoreDuplicates) for dedup.
   */
  async insertBlocks(blocks: Block[]): Promise<void> {
    await this.sequelize.transaction(async (t) => {
      await BlockModel.bulkCreate(
        blocks.map((b) => ({
          id: b.id,
          bookId: b.bookId,
          index: b.index,
          docPath: b.docPath,
          type: b.type,
          content: b.content,
          lang: b.lang,
          model: b.model ?? null,
          sourceId: b.sourceId ?? null,
          fileId: b.fileId,
          tagName: b.tagName,
          attributes: b.attributes,
        })),
        { ignoreDuplicates: true, validate: false, transaction: t },
      );
    });
  }

  /**
   * Get all original blocks for a book (where source_id IS NULL).
   */
  async getBlocksByBook(bookId: string): Promise<Block[]> {
    const rows = await BlockModel.findAll({
      where: { bookId, sourceId: null },
      order: [['index', 'ASC']],
      raw: true,
    });
    return rows.map((r: Record<string, any>) => this.toBlockRecord(r));
  }

  /**
   * Get original blocks for a specific document.
   */
  async getBlocksByDoc(bookId: string, docPath: string): Promise<Block[]> {
    const rows = await BlockModel.findAll({
      where: { bookId, docPath, sourceId: null },
      order: [['index', 'ASC']],
      raw: true,
    });
    return rows.map((r: Record<string, any>) => this.toBlockRecord(r));
  }

  /**
   * Get original blocks that have no translation in the given target language.
   * If model is specified, only checks for translations by that exact model.
   * Skips image blocks (they don't need translation).
   */
  async getUntranslatedBlocks(bookId: string, targetLang: string, model?: string): Promise<Block[]> {
    if (model) {
      const rows = await this.sequelize.query(`
        SELECT b.* FROM blocks b
        WHERE b.book_id = $1
          AND b.source_id IS NULL
          AND b.type != 'image'
          AND NOT EXISTS (
            SELECT 1 FROM blocks t WHERE t.source_id = b.id AND t.lang = $2 AND t.model = $3
          )
        ORDER BY b.block_index
      `, { bind: [bookId, targetLang, model], type: QueryTypes.SELECT });
      return (rows as Record<string, any>[]).map((r) => this.mapBlockRow(r));
    }
    const rows = await this.sequelize.query(`
      SELECT b.* FROM blocks b
      WHERE b.book_id = $1
        AND b.source_id IS NULL
        AND b.type != 'image'
        AND NOT EXISTS (
          SELECT 1 FROM blocks t WHERE t.source_id = b.id AND t.lang = $2
        )
      ORDER BY b.block_index
    `, { bind: [bookId, targetLang], type: QueryTypes.SELECT });
    return (rows as Record<string, any>[]).map((r) => this.mapBlockRow(r));
  }

  /**
   * Get all blocks with translations joined in for a specific language.
   * Returns original blocks with a `translatedContent` field set from translation rows.
   */
  async getBlocksByBookWithTranslations(bookId: string, targetLang: string, model?: string): Promise<Block[]> {
    const rows = await this.sequelize.query(`
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
    `, { bind: model ? [bookId, targetLang, model] : [bookId, targetLang], type: QueryTypes.SELECT });

    return (rows as Record<string, any>[]).map((r) => ({
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
    const rows = await this.sequelize.query(`
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
    `, { bind: params, type: QueryTypes.SELECT });

    return (rows as Record<string, any>[]).map((r) => ({
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
      const rows = await this.sequelize.query(`
        SELECT
          COUNT(*) as total,
          COALESCE(SUM(CASE WHEN t.source_id IS NOT NULL THEN 1 ELSE 0 END), 0) as translated
        FROM blocks b
        LEFT JOIN (
          SELECT DISTINCT source_id FROM blocks WHERE lang = $2 AND source_id IS NOT NULL ${modelFilter}
        ) t ON t.source_id = b.id
        WHERE b.book_id = $1 AND b.source_id IS NULL
      `, { bind: params, type: QueryTypes.SELECT });
      const row = (rows as Record<string, any>[])[0];
      return { total: parseInt(row.total), translated: parseInt(row.translated) };
    }
    const rows = await this.sequelize.query(
      'SELECT COUNT(*) as total, 0 as translated FROM blocks WHERE book_id = $1 AND source_id IS NULL',
      { bind: [bookId], type: QueryTypes.SELECT },
    );
    const row = (rows as Record<string, any>[])[0];
    return { total: parseInt(row.total), translated: 0 };
  }

  async getDocPaths(bookId: string): Promise<string[]> {
    const rows = await this.sequelize.query(
      'SELECT doc_path, MIN(block_index) AS min_idx FROM blocks WHERE book_id = $1 AND source_id IS NULL GROUP BY doc_path ORDER BY min_idx',
      { bind: [bookId], type: QueryTypes.SELECT },
    );
    return (rows as Record<string, any>[]).map((r) => r.doc_path);
  }

  // ─── Translation CRUD (uses blocks table with source_id) ───

  /**
   * Insert or update a translation block.
   * Creates a new block row with source_id pointing to the original block.
   * Uses ON CONFLICT (id) DO UPDATE — id is deterministic from sourceBlockId+lang+model.
   */
  async upsertTranslation(sourceBlock: Block, translatedContent: string, lang: string, model: string): Promise<void> {
    const id = generateTranslationId(sourceBlock.id, lang, model);
    await this.sequelize.query(`
      INSERT INTO blocks (id, book_id, block_index, doc_path, type, content, lang, model, source_id, file_id, tag_name, attributes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, created_at = now()
    `, {
      bind: [
        id, sourceBlock.bookId, sourceBlock.index, sourceBlock.docPath, sourceBlock.type,
        translatedContent, lang, model, sourceBlock.id,
        sourceBlock.fileId, sourceBlock.tagName, sourceBlock.attributes,
      ],
    });
  }

  /**
   * Get the latest translation block for a source block in a specific language.
   */
  async getTranslation(sourceBlockId: string, lang: string, model?: string): Promise<Block | undefined> {
    const where: Record<string, any> = { sourceId: sourceBlockId, lang };
    if (model) where.model = model;
    const rows = await BlockModel.findAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: 1,
      raw: true,
    });
    if (rows.length === 0) return undefined;
    return this.toBlockRecord(rows[0] as Record<string, any>);
  }

  /**
   * Get all translation blocks for a source block.
   */
  async getTranslationsByBlock(sourceBlockId: string): Promise<Block[]> {
    const rows = await BlockModel.findAll({
      where: { sourceId: sourceBlockId },
      order: [['createdAt', 'DESC']],
      raw: true,
    });
    return rows.map((r: Record<string, any>) => this.toBlockRecord(r));
  }

  // ─── File CRUD ─────────────────────────────────────────────

  async insertFile(file: FileRecord): Promise<void> {
    await FileModel.bulkCreate([
      {
        id: file.id,
        bookId: file.bookId,
        originalPath: file.originalPath,
        mimeType: file.mimeType,
        data: file.data,
      },
    ], { ignoreDuplicates: true, validate: false });
  }

  async insertFiles(files: FileRecord[]): Promise<void> {
    await this.sequelize.transaction(async (t) => {
      await FileModel.bulkCreate(
        files.map((f) => ({
          id: f.id,
          bookId: f.bookId,
          originalPath: f.originalPath,
          mimeType: f.mimeType,
          data: f.data,
        })),
        { ignoreDuplicates: true, validate: false, transaction: t },
      );
    });
  }

  async getFile(id: string): Promise<FileRecord | undefined> {
    const row = await FileModel.findByPk(id, { raw: true });
    return row ? this.toFileRecord(row as Record<string, any>) : undefined;
  }

  async getFileByPath(bookId: string, originalPath: string): Promise<FileRecord | undefined> {
    const row = await FileModel.findOne({ where: { bookId, originalPath }, raw: true });
    return row ? this.toFileRecord(row as Record<string, any>) : undefined;
  }

  async getFilesByBook(bookId: string): Promise<FileRecord[]> {
    const rows = await FileModel.findAll({ where: { bookId }, raw: true });
    return rows.map((r: Record<string, any>) => this.toFileRecord(r));
  }

  async deleteFilesByBook(bookId: string): Promise<void> {
    await FileModel.destroy({ where: { bookId } });
  }

  // ─── Doc status ────────────────────────────────────────────

  async updateDocStatus(docId: string, status: string, extra?: { totalPages?: number; parsedPages?: number }): Promise<void> {
    if (extra?.totalPages !== undefined && extra?.parsedPages !== undefined) {
      await Doc.update({ status, totalPages: extra.totalPages, parsedPages: extra.parsedPages }, { where: { id: docId } });
    } else if (extra?.totalPages !== undefined) {
      await Doc.update({ status, totalPages: extra.totalPages }, { where: { id: docId } });
    } else if (extra?.parsedPages !== undefined) {
      await Doc.update({ status, parsedPages: extra.parsedPages }, { where: { id: docId } });
    } else {
      await Doc.update({ status }, { where: { id: docId } });
    }
  }

  async updateTotalBlocks(docId: string, totalBlocks: number): Promise<void> {
    await Doc.update({ totalBlocks }, { where: { id: docId } });
  }

  // ─── Task CRUD ─────────────────────────────────────────────

  async createTasks(tasks: Array<{ id: string; docId: string; type: string; pageNum: number; totalPages: number }>): Promise<void> {
    await this.sequelize.transaction(async (t) => {
      await TaskModel.bulkCreate(
        tasks.map((tk) => ({
          id: tk.id,
          docId: tk.docId,
          type: tk.type,
          pageNum: tk.pageNum,
          totalPages: tk.totalPages,
        })),
        { ignoreDuplicates: true, validate: false, transaction: t },
      );
    });
  }

  async getNextTask(): Promise<TaskRecord | undefined> {
    const [rows] = await this.sequelize.query(`
      UPDATE tasks SET status = 'processing', updated_at = now()
      WHERE id = (
        SELECT id FROM tasks WHERE status = 'pending'
        ORDER BY doc_id ASC, page_num ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `);
    const row = (rows as Record<string, any>[])[0];
    return row ? this.mapTaskRow(row) : undefined;
  }

  async completeTask(taskId: string, content: string): Promise<void> {
    await TaskModel.update(
      { status: 'completed', content, completedAt: sql.fn('now'), updatedAt: sql.fn('now') },
      { where: { id: taskId } },
    );
  }

  async failTask(taskId: string, error: string): Promise<void> {
    await TaskModel.update(
      { status: 'failed', error, completedAt: sql.fn('now'), updatedAt: sql.fn('now') },
      { where: { id: taskId } },
    );
  }

  async getTasksByDoc(docId: string): Promise<TaskRecord[]> {
    const rows = await TaskModel.findAll({ where: { docId }, order: [['pageNum', 'ASC']], raw: true });
    return rows.map((r: Record<string, any>) => this.toTaskRecord(r));
  }

  async getTaskCounts(docId: string): Promise<{ total: number; completed: number; failed: number; pending: number; processing: number }> {
    const rows = await this.sequelize.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'failed') as failed,
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'processing') as processing
      FROM tasks WHERE doc_id = $1
    `, { bind: [docId], type: QueryTypes.SELECT });
    const row = (rows as Record<string, any>[])[0];
    return {
      total: parseInt(row.total),
      completed: parseInt(row.completed),
      failed: parseInt(row.failed),
      pending: parseInt(row.pending),
      processing: parseInt(row.processing),
    };
  }

  async countProcessingTasks(): Promise<number> {
    return TaskModel.count({ where: { status: 'processing' } });
  }

  // ─── General ───────────────────────────────────────────────

  async close(): Promise<void> {
    // Don't close the sequelize instance — it's shared. Just a no-op.
  }

  static async closePool(): Promise<void> {
    await closeSequelize();
  }

  /** The shared Sequelize instance (used for raw queries / migrations). */
  get sequelize() {
    return this._sequelize;
  }

  // ─── Private helpers ──────────────────────────────────────

  /** Map a model row (camelCase attributes) → BookRecord. */
  private toBookRecord(row: Record<string, any>): BookRecord {
    return {
      id: row.id,
      title: row.title,
      author: row.author,
      language: row.language,
      filename: row.filename,
      totalBlocks: row.totalBlocks,
      translatedBlocks: row.translatedBlocks,
      targetLang: row.targetLang,
      sourceLang: row.sourceLang,
      model: row.model,
      createdAt: iso(row.createdAt),
      completedAt: isoOpt(row.completedAt),
      status: row.status ?? 'uploaded',
      totalPages: row.totalPages ?? 0,
      parsedPages: row.parsedPages ?? 0,
      sourcePath: row.sourcePath ?? null,
    };
  }

  /** Map a model row (camelCase attributes) → Block. */
  private toBlockRecord(row: Record<string, any>): Block {
    return {
      id: row.id,
      bookId: row.bookId,
      index: row.index,
      docPath: row.docPath,
      type: row.type as BlockType,
      content: row.content,
      lang: row.lang,
      model: row.model,
      sourceId: row.sourceId,
      fileId: row.fileId,
      tagName: row.tagName,
      attributes: row.attributes,
    };
  }

  /** Map a model row (camelCase attributes) → FileRecord. */
  private toFileRecord(row: Record<string, any>): FileRecord {
    return {
      id: row.id,
      bookId: row.bookId,
      originalPath: row.originalPath,
      mimeType: row.mimeType,
      data: row.data,
      createdAt: iso(row.createdAt),
    };
  }

  /** Map a model row (camelCase attributes) → TaskRecord. */
  private toTaskRecord(row: Record<string, any>): TaskRecord {
    return {
      id: row.id,
      docId: row.docId,
      type: row.type,
      pageNum: row.pageNum,
      totalPages: row.totalPages,
      status: row.status,
      content: row.content,
      error: row.error,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
      completedAt: isoOpt(row.completedAt),
    };
  }

  /** Map a raw SQL row (snake_case columns) → Block. */
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

  /** Map a raw SQL row (snake_case columns) → TaskRecord. */
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
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      completedAt: isoOpt(row.completed_at),
    };
  }
}
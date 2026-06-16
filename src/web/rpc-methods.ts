/**
 * JSON-RPC method handlers for ai-translate.
 *
 * Each handler corresponds to one API method and is registered
 * in registerMethods() with its schema for auto-documentation.
 */

import path from 'path';
import fs from 'fs';

import { JsonRpcRouter, RpcError, APP_ERRORS } from './jsonrpc.js';
import type { RpcContext, RpcMethodHandler } from './jsonrpc.js';
import type { JsonRpcRequest, RpcMethodSchema } from './jsonrpc.js';
import { JobQueue } from './job-queue.js';
import { runTranslation, runUpload } from './pipeline.js';
import { TranslateDb } from '../db/database.js';
import { OLLAMA_DEFAULT_URL, DEFAULT_MODEL, DEFAULT_API_KEY, DEFAULT_LLM_PROVIDER, UPLOAD_ONLY } from '../utils/constants.js';

// ─── Schemas ───────────────────────────────────────────────────────

const SCHEMAS: RpcMethodSchema[] = [
  // ── System ──────────────────────────────────────
  {
    method: 'system.health',
    description: 'Health check — returns server uptime and status',
    params: {},
    result: { type: 'object', description: 'Server health info', properties: {
      status: { type: 'string', description: 'Always "ok"' },
      uptime: { type: 'number', description: 'Process uptime in seconds' },
    }},
  },
  {
    method: 'system.config',
    description: 'Get client-side configuration (uploadOnly, defaultModel, provider)',
    params: {},
    result: { type: 'object', description: 'Client config', properties: {
      uploadOnly: { type: 'boolean', description: 'Books are parsed but not translated' },
      defaultModel: { type: 'string', description: 'Default LLM model name' },
      defaultProvider: { type: 'string', description: 'LLM provider (lmstudio, ollama, remote)' },
    }},
  },
  {
    method: 'system.discover',
    description: 'List all available JSON-RPC methods with their schemas',
    params: {},
    result: { type: 'array', description: 'Array of method schemas', properties: {} },
  },
  {
    method: 'system.errors',
    description: 'List all standard and application-specific error codes',
    params: {},
    result: { type: 'object', description: 'Error codes', properties: {
      errors: { type: 'array', description: 'Array of error code objects with code, name, description' },
    }},
  },

  // ── Models ──────────────────────────────────────
  {
    method: 'model.list',
    description: 'List available LLM models from the OpenAI-compatible API',
    params: {},
    result: { type: 'object', description: 'Available models', properties: {
      models: { type: 'array', description: 'Sorted list of model IDs' },
    }},
  },

  // ── Upload ───────────────────────────────────────
  {
    method: 'book.upload',
    description: 'Upload a book file (EPUB/FB2) and parse it into blocks. No translation — just indexing.',
    params: {
      file: { type: 'file', description: 'EPUB or FB2 file (multipart/form-data)', required: true },
    },
    result: { type: 'object', description: 'Upload result', properties: {
      jobId: { type: 'string', description: 'Job ID for tracking progress' },
      status: { type: 'string', description: 'Initial job status' },
      uploadOnly: { type: 'boolean', description: 'Always true for upload-only' },
    }},
  },
  {
    method: 'book.translate',
    description: 'Upload a book and immediately start translating it',
    params: {
      file: { type: 'file', description: 'EPUB or FB2 file (multipart/form-data)', required: true },
      targetLang: { type: 'string', description: 'Target language code (e.g. "ru", "es")', required: true },
      sourceLang: { type: 'string', description: 'Source language code or "auto"', required: false, default: 'auto' },
      model: { type: 'string', description: 'LLM model name', required: false },
    },
    result: { type: 'object', description: 'Translation job', properties: {
      jobId: { type: 'string', description: 'Job ID for tracking progress' },
      status: { type: 'string', description: 'Initial job status' },
    }},
  },
  {
    method: 'book.startTranslation',
    description: 'Start translating an already-uploaded book by its ID',
    params: {
      bookId: { type: 'string', description: 'Book ID from the database', required: true },
      targetLang: { type: 'string', description: 'Target language code (e.g. "ru", "es")', required: true },
      sourceLang: { type: 'string', description: 'Source language code or "auto"', required: false, default: 'auto' },
      model: { type: 'string', description: 'LLM model name', required: false },
    },
    result: { type: 'object', description: 'Translation job', properties: {
      jobId: { type: 'string', description: 'Job ID for tracking progress' },
      status: { type: 'string', description: 'Initial job status' },
    }},
  },

  // ── Books CRUD ──────────────────────────────────
  {
    method: 'book.list',
    description: 'List all books in the database',
    params: {},
    result: { type: 'object', description: 'Book list', properties: {
      books: { type: 'array', description: 'Array of book records' },
    }},
  },
  {
    method: 'book.get',
    description: 'Get book details including block counts, chapter breakdown, and image file IDs',
    params: {
      bookId: { type: 'string', description: 'Book ID', required: true },
    },
    result: { type: 'object', description: 'Book details with chapters and images', properties: {
      blockCounts: { type: 'object', description: 'Total and translated block counts' },
      chapters: { type: 'array', description: 'Per-chapter block statistics' },
      images: { type: 'array', description: 'Image file records (id, originalPath, mimeType, size)' },
    }},
  },
  {
    method: 'book.delete',
    description: 'Delete a book and all its blocks from the database',
    params: {
      bookId: { type: 'string', description: 'Book ID', required: true },
    },
    result: { type: 'object', description: 'Deletion result', properties: {
      deleted: { type: 'boolean', description: 'Always true on success' },
    }},
  },
  {
    method: 'book.download',
    description: 'Download the translated EPUB file for a completed job',
    params: {
      jobId: { type: 'string', description: 'Job ID with completed translation', required: true },
    },
    result: { type: 'file', description: 'Translated EPUB file (binary download)' },
  },

  // ── Files ────────────────────────────────────────
  {
    method: 'file.get',
    description: 'Get metadata for a stored image file (binary data served via GET /files/:id)',
    params: {
      fileId: { type: 'string', description: 'File ID (UUID v5 from keccak256 of binary data)', required: true },
    },
    result: { type: 'object', description: 'File metadata', properties: {
      id: { type: 'string', description: 'File ID' },
      originalPath: { type: 'string', description: 'Original path in EPUB/FB2' },
      mimeType: { type: 'string', description: 'MIME type (e.g. image/jpeg)' },
      size: { type: 'number', description: 'File size in bytes' },
      bookId: { type: 'string', description: 'Book ID this file belongs to' },
      url: { type: 'string', description: 'URL to download the file binary data' },
    }},
  },

  // ── Jobs ─────────────────────────────────────────
  {
    method: 'job.list',
    description: 'List all translation jobs (most recent first)',
    params: {},
    result: { type: 'object', description: 'Job list', properties: {
      jobs: { type: 'array', description: 'Array of serialized job objects' },
    }},
  },
  {
    method: 'job.get',
    description: 'Get status of a specific job',
    params: {
      jobId: { type: 'string', description: 'Job ID', required: true },
    },
    result: { type: 'object', description: 'Job details' },
  },
  {
    method: 'job.delete',
    description: 'Cancel/delete a job and clean up its files',
    params: {
      jobId: { type: 'string', description: 'Job ID', required: true },
    },
    result: { type: 'object', description: 'Deletion result', properties: {
      deleted: { type: 'boolean', description: 'Always true on success' },
    }},
  },
];

// ─── Method registration ───────────────────────────────────────────

/**
 * Register all JSON-RPC methods on the router.
 * Returns the configured router instance.
 */
export function registerMethods(router: JsonRpcRouter, deps: {
  jobQueue: JobQueue;
  ollamaUrl: string;
  defaultModel: string;
  apiKey: string;
  provider: string;
  dbPath?: string;
}): void {
  const { jobQueue, ollamaUrl, defaultModel, apiKey, provider, dbPath } = deps;

  // ── System ──────────────────────────────────────
  // ── System ──────────────────────────────────────
  router.register('system.health', (_params, _ctx) => {
    return { status: 'ok', uptime: process.uptime() };
  });

  router.register('system.config', (_params, _ctx) => {
    return {
      uploadOnly: UPLOAD_ONLY,
      defaultModel,
      defaultProvider: provider,
    };
  });

  router.register('system.discover', (_params, _ctx) => {
    return router.getDiscovery();
  });

  router.register('system.errors', (_params, _ctx) => {
    const allErrors = [
      // Standard JSON-RPC errors
      { code: -32700, name: 'Parse Error', description: 'Invalid JSON was received.' },
      { code: -32600, name: 'Invalid Request', description: 'The JSON sent is not a valid Request object.' },
      { code: -32601, name: 'Method Not Found', description: 'The method does not exist or is not available.' },
      { code: -32602, name: 'Invalid Params', description: 'Invalid method parameter(s).' },
      { code: -32603, name: 'Internal Error', description: 'Internal JSON-RPC error.' },
      // Application errors
      ...Object.values(APP_ERRORS).map((e: any) => ({
        code: e.code,
        name: e.message.replace(/([A-Z])/g, ' $1').trim(),
        description: e.message,
      })),
    ];
    return { errors: allErrors };
  });

  // ── Models ──────────────────────────────────────

  router.register('model.list', async (_params, _ctx) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    const response = await fetch(`${ollamaUrl}/v1/models`, { headers });
    if (!response.ok) {
      throw new RpcError(APP_ERRORS.API_UNAVAILABLE.code, APP_ERRORS.API_UNAVAILABLE.message);
    }
    const data = await response.json() as { data: Array<{ id: string }> };
    return { models: data.data.map((m) => m.id).sort() };
  });

  // ── Upload ───────────────────────────────────────

  router.register('book.upload', (params, ctx) => {
    if (!ctx.file) {
      throw new RpcError(APP_ERRORS.FILE_REQUIRED.code, APP_ERRORS.FILE_REQUIRED.message);
    }

    const job = jobQueue.create({
      originalFilename: ctx.file.originalname,
      inputPath: ctx.file.path,
      targetLang: '',
      sourceLang: 'auto',
      model: '',
    });

    runUpload(job, jobQueue, { dbPath }).then((bookRecord) => {
      job.metadata = {
        title: bookRecord.title,
        author: bookRecord.author,
        language: bookRecord.language,
        format: path.extname(job.originalFilename).replace('.', ''),
      };
    }).catch(() => {});

    return { jobId: job.id, status: job.status, uploadOnly: true };
  });

  router.register('book.translate', (params, ctx) => {
    if (!ctx.file) {
      throw new RpcError(APP_ERRORS.FILE_REQUIRED.code, APP_ERRORS.FILE_REQUIRED.message);
    }
    if (!params.targetLang) {
      // Clean up uploaded file
      fs.unlinkSync(ctx.file.path);
      throw new RpcError(APP_ERRORS.TARGET_LANG_REQUIRED.code, APP_ERRORS.TARGET_LANG_REQUIRED.message);
    }

    const sourceLang = params.sourceLang || 'auto';
    const model = params.model || defaultModel;

    const job = jobQueue.create({
      originalFilename: ctx.file.originalname,
      inputPath: ctx.file.path,
      targetLang: params.targetLang,
      sourceLang,
      model,
    });

    runTranslation(job, jobQueue, { ollamaUrl, apiKey, provider, dbPath }).catch(() => {});

    return { jobId: job.id, status: job.status };
  });

  router.register('book.startTranslation', (params, _ctx) => {
    const db = new TranslateDb(dbPath);
    try {
      const book = db.getBook(params.bookId);
      if (!book) {
        throw new RpcError(APP_ERRORS.BOOK_NOT_FOUND.code, APP_ERRORS.BOOK_NOT_FOUND.message);
      }

      if (!params.targetLang) {
        throw new RpcError(APP_ERRORS.TARGET_LANG_REQUIRED.code, APP_ERRORS.TARGET_LANG_REQUIRED.message);
      }

      const sourceLang = params.sourceLang || 'auto';
      const model = params.model || defaultModel;

      const uploadJobs = jobQueue.list().filter(j => j.originalFilename === book.filename);
      if (uploadJobs.length === 0) {
        throw new RpcError(APP_ERRORS.ORIGINAL_FILE_NOT_FOUND.code, APP_ERRORS.ORIGINAL_FILE_NOT_FOUND.message);
      }

      const job = jobQueue.create({
        originalFilename: book.filename,
        inputPath: uploadJobs[0].inputPath,
        targetLang: params.targetLang,
        sourceLang,
        model,
      });

      runTranslation(job, jobQueue, { ollamaUrl, apiKey, provider, dbPath }).catch(() => {});

      return { jobId: job.id, status: job.status };
    } finally {
      db.close();
    }
  });

  // ── Books CRUD ──────────────────────────────────

  router.register('book.list', (_params, _ctx) => {
    const db = new TranslateDb(dbPath);
    try {
      return { books: db.listBooks() };
    } finally {
      db.close();
    }
  });

  router.register('book.get', (params, _ctx) => {
    const db = new TranslateDb(dbPath);
    try {
      const book = db.getBook(params.bookId);
      if (!book) {
        throw new RpcError(APP_ERRORS.BOOK_NOT_FOUND.code, APP_ERRORS.BOOK_NOT_FOUND.message);
      }
      const counts = db.countBlocks(book.id);
      const docPaths = db.getDocPaths(book.id);
      const chapters = docPaths.map(dp => {
        const blocks = db.getBlocksByDoc(book.id, dp);
        return {
          docPath: dp,
          totalBlocks: blocks.length,
          translatedBlocks: blocks.filter(b => b.translatedMd !== null).length,
        };
      });
      // Include image file metadata (without binary data)
      const files = db.getFilesByBook(book.id);
      const images = files.map(f => ({
        id: f.id,
        originalPath: f.originalPath,
        mimeType: f.mimeType,
        size: f.data.length,
        bookId: f.bookId,
        url: `/files/${f.id}`,
      }));
      return { ...book, blockCounts: counts, chapters, images };
    } finally {
      db.close();
    }
  });

  router.register('book.delete', (params, _ctx) => {
    const db = new TranslateDb(dbPath);
    try {
      const book = db.getBook(params.bookId);
      if (!book) {
        throw new RpcError(APP_ERRORS.BOOK_NOT_FOUND.code, APP_ERRORS.BOOK_NOT_FOUND.message);
      }
      db.deleteBook(params.bookId);
      return { deleted: true };
    } finally {
      db.close();
    }
  });

  router.register('book.download', (params, _ctx) => {
    const job = jobQueue.get(params.jobId);
    if (!job) {
      throw new RpcError(APP_ERRORS.JOB_NOT_FOUND.code, APP_ERRORS.JOB_NOT_FOUND.message);
    }
    if (job.status !== 'completed' || !job.outputPath) {
      throw new RpcError(APP_ERRORS.JOB_NOT_COMPLETE.code, APP_ERRORS.JOB_NOT_COMPLETE.message);
    }
    if (!fs.existsSync(job.outputPath)) {
      throw new RpcError(APP_ERRORS.FILE_EXPIRED.code, APP_ERRORS.FILE_EXPIRED.message);
    }
    // Special: this method uses the Express response directly for file streaming
    const downloadName = job.originalFilename.replace(/\.(epub|fb2)$/i, `_${job.targetLang}.epub`);
    if (_ctx.res) {
      _ctx.res.download(job.outputPath, downloadName);
      return { __fileDownload: true }; // Marker — don't send as JSON
    }
    return { downloadUrl: `/api/download/${params.jobId}` };
  });

  // ── Files ────────────────────────────────────────

  router.register('file.get', (params, _ctx) => {
    const db = new TranslateDb(dbPath);
    try {
      const file = db.getFile(params.fileId);
      if (!file) {
        throw new RpcError(APP_ERRORS.BOOK_NOT_FOUND.code, `File not found: ${params.fileId}`);
      }
      return {
        id: file.id,
        originalPath: file.originalPath,
        mimeType: file.mimeType,
        size: file.data.length,
        bookId: file.bookId,
        url: `/files/${file.id}`,
      };
    } finally {
      db.close();
    }
  });

  // ── Jobs ─────────────────────────────────────────

  router.register('job.list', (_params, _ctx) => {
    return { jobs: jobQueue.list().map(serializeJob) };
  });

  router.register('job.get', (params, _ctx) => {
    const job = jobQueue.get(params.jobId);
    if (!job) {
      throw new RpcError(APP_ERRORS.JOB_NOT_FOUND.code, APP_ERRORS.JOB_NOT_FOUND.message);
    }
    return serializeJob(job);
  });

  router.register('job.delete', async (params, _ctx) => {
    const deleted = await jobQueue.delete(params.jobId);
    if (!deleted) {
      throw new RpcError(APP_ERRORS.JOB_NOT_FOUND.code, APP_ERRORS.JOB_NOT_FOUND.message);
    }
    return { deleted: true };
  });

  // ── Register schemas ─────────────────────────────
  for (const schema of SCHEMAS) {
    // Schemas are set directly on the router's public map
    router.schemas.set(schema.method, schema);
  }
}

/**
 * Serialize a TranslationJob for JSON transport.
 */
function serializeJob(job: any): object {
  return {
    ...job,
    createdAt: job.createdAt?.toISOString?.() ?? job.createdAt,
    finishedAt: job.finishedAt?.toISOString?.() ?? null,
  };
}
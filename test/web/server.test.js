import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../../src/web/server.js';
import { JobQueue } from '../../src/web/job-queue.js';
import { TranslateDb } from '../../src/db/database.js';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const SAMPLE_EPUB = path.join(FIXTURES_DIR, 'sample.epub');

const TEST_DB_URL = process.env.DATABASE_URL;

/** Helper: send a JSON-RPC request */
async function rpc(port, method, params = {}) {
  const id = Date.now() + Math.random();
  const res = await fetch(`http://localhost:${port}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
  });
  return await res.json();
}

/** Helper: send a JSON-RPC request with file upload (multipart) */
async function rpcUpload(port, method, params, filePath) {
  const id = Date.now() + Math.random();
  const form = new FormData();
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  form.append('file', new Blob([fileBuffer]), fileName);
  form.append('rpc', JSON.stringify({ jsonrpc: '2.0', method, params, id }));

  const res = await fetch(`http://localhost:${port}/rpc`, {
    method: 'POST',
    body: form,
  });
  return await res.json();
}

describe('JobQueue', () => {
  it('should create a job with correct defaults', () => {
    const queue = new JobQueue();
    const job = queue.create({
      originalFilename: 'test.epub',
      inputPath: '/tmp/test.epub',
      targetLang: 'es',
      sourceLang: 'en',
      model: 'llama3.1',
    });

    expect(job.id).toBeTruthy();
    expect(job.status).toBe('queued');
    expect(job.progress).toBe(0);
    expect(job.originalFilename).toBe('test.epub');
    expect(job.targetLang).toBe('es');
    expect(job.outputPath).toBeNull();
    expect(job.error).toBeNull();
    expect(job.metadata).toBeNull();
  });

  it('should update job status', () => {
    const queue = new JobQueue();
    const job = queue.create({
      originalFilename: 'test.epub',
      inputPath: '/tmp/test.epub',
      targetLang: 'es',
      sourceLang: 'en',
      model: 'llama3.1',
    });

    queue.updateStatus(job.id, 'parsing', 'Parsing file...', 10);
    const updated = queue.get(job.id);
    expect(updated.status).toBe('parsing');
    expect(updated.progress).toBe(10);
    expect(updated.message).toBe('Parsing file...');
  });

  it('should set completed status with 100% progress', () => {
    const queue = new JobQueue();
    const job = queue.create({
      originalFilename: 'test.epub',
      inputPath: '/tmp/test.epub',
      targetLang: 'es',
      sourceLang: 'en',
      model: 'llama3.1',
    });

    queue.updateStatus(job.id, 'completed', 'Done!');
    const updated = queue.get(job.id);
    expect(updated.status).toBe('completed');
    expect(updated.progress).toBe(100);
    expect(updated.finishedAt).not.toBeNull();
  });

  it('should set error on job', () => {
    const queue = new JobQueue();
    const job = queue.create({
      originalFilename: 'test.epub',
      inputPath: '/tmp/test.epub',
      targetLang: 'es',
      sourceLang: 'en',
      model: 'llama3.1',
    });

    queue.setError(job.id, 'Something went wrong');
    const updated = queue.get(job.id);
    expect(updated.status).toBe('failed');
    expect(updated.error).toBe('Something went wrong');
    expect(updated.finishedAt).not.toBeNull();
  });

  it('should set metadata and output path', () => {
    const queue = new JobQueue();
    const job = queue.create({
      originalFilename: 'test.epub',
      inputPath: '/tmp/test.epub',
      targetLang: 'es',
      sourceLang: 'en',
      model: 'llama3.1',
    });

    queue.setMetadata(job.id, { title: 'Test Book', author: 'Author', language: 'en' });
    queue.setOutputPath(job.id, '/tmp/output.epub');

    const updated = queue.get(job.id);
    expect(updated.metadata).toEqual({ title: 'Test Book', author: 'Author', language: 'en' });
    expect(updated.outputPath).toBe('/tmp/output.epub');
  });

  it('should list jobs (most recent first)', () => {
    const queue = new JobQueue();
    const job1 = queue.create({
      originalFilename: 'first.epub',
      inputPath: '/tmp/first.epub',
      targetLang: 'es',
      sourceLang: 'en',
      model: 'llama3.1',
    });
    const job2 = queue.create({
      originalFilename: 'second.epub',
      inputPath: '/tmp/second.epub',
      targetLang: 'fr',
      sourceLang: 'en',
      model: 'llama3.1',
    });

    const list = queue.list();
    expect(list.length).toBe(2);
    const ids = list.map((j) => j.id);
    expect(ids).toContain(job1.id);
    expect(ids).toContain(job2.id);
  });

  it('should call onUpdate callback on status change', () => {
    const updates = [];
    const queue = new JobQueue((job) => {
      updates.push(job.status);
    });

    const job = queue.create({
      originalFilename: 'test.epub',
      inputPath: '/tmp/test.epub',
      targetLang: 'es',
      sourceLang: 'en',
      model: 'llama3.1',
    });

    queue.updateStatus(job.id, 'parsing', 'Parsing...');
    queue.updateStatus(job.id, 'completed', 'Done!');

    expect(updates).toEqual(['queued', 'parsing', 'completed']);
  });

  it('should return static directories', () => {
    expect(JobQueue.getUploadDir()).toContain('.uploads');
    expect(JobQueue.getOutputDir()).toContain('.output');
  });
});

describe('JSON-RPC API', () => {
  let server;
  let jobQueue;
  let port;
  let migrateDb;

  beforeAll(async () => {
    // Ensure the PostgreSQL schema exists before the server handles DB-backed
    // RPC methods (book.list, book.get, etc.). The server's createApp() does not
    // run migrate on its own, so we do it here against the shared pool.
    migrateDb = new TranslateDb(TEST_DB_URL);
    await migrateDb.migrate();
    await migrateDb.close();

    const { app, server: srv, jobQueue: jq } = createApp({ dbPath: TEST_DB_URL });
    server = srv;
    jobQueue = jq;

    await new Promise((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = addr.port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    // Force-close the shared pg pool to release all connections held by
    // background tasks (runUpload/runTranslation) that may still be in-flight.
    await TranslateDb.closePool();
  });

  // ── System ──────────────────────────────────────

  it('should return health check via system.health', async () => {
    const data = await rpc(port, 'system.health');
    expect(data.result.status).toBe('ok');
    expect(typeof data.result.uptime).toBe('number');
  });

  it('should return config via system.config', async () => {
    const data = await rpc(port, 'system.config');
    expect(typeof data.result.uploadOnly).toBe('boolean');
    expect(typeof data.result.defaultModel).toBe('string');
  });

  it('should return method discovery via system.discover', async () => {
    const data = await rpc(port, 'system.discover');
    const methods = data.result.map((s) => s.method);
    expect(methods).toContain('system.health');
    expect(methods).toContain('system.errors');
    expect(methods).toContain('book.upload');
    expect(methods).toContain('book.translate');
    expect(methods).toContain('book.list');
  });

  it('should return error codes via system.errors', async () => {
    const data = await rpc(port, 'system.errors');
    expect(Array.isArray(data.result.errors)).toBe(true);
    expect(data.result.errors.length).toBeGreaterThan(5);
    // Standard JSON-RPC errors
    const codes = data.result.errors.map((e) => e.code);
    expect(codes).toContain(-32700);
    expect(codes).toContain(-32601);
    // Application errors
    expect(codes.some((c) => c >= 10001)).toBe(true);
  });

  // ── Error handling ──────────────────────────────

  it('should return METHOD_NOT_FOUND for unknown method', async () => {
    const data = await rpc(port, 'nonexistent.method');
    expect(data.error.code).toBe(-32601);
  });

  it('should return INVALID_PARAMS for non-object params', async () => {
    const id = Date.now();
    const res = await fetch(`http://localhost:${port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'system.health', params: 'bad', id }),
    });
    const data = await res.json();
    expect(data.error.code).toBe(-32602);
  });

  // ── Upload ───────────────────────────────────────

  it('should return FILE_REQUIRED error for book.upload without file', async () => {
    const data = await rpc(port, 'book.upload');
    expect(data.error.code).toBe(10001);
  });

  it.skip('should accept book.upload with file', async () => {
    const data = await rpcUpload(port, 'book.upload', {}, SAMPLE_EPUB);
    expect(data.result.jobId).toBeTruthy();
    expect(data.result.uploadOnly).toBe(true);
  });

  // ── Translate ───────────────────────────────────

  it('should return FILE_REQUIRED error for book.translate without file', async () => {
    const data = await rpc(port, 'book.translate', { targetLang: 'ru' });
    expect(data.error.code).toBe(10001);
  });

  it('should return TARGET_LANG_REQUIRED for book.translate without targetLang', async () => {
    const form = new FormData();
    const fileBuffer = fs.readFileSync(SAMPLE_EPUB);
    form.append('file', new Blob([fileBuffer]), 'sample.epub');
    form.append('rpc', JSON.stringify({ jsonrpc: '2.0', method: 'book.translate', params: {}, id: Date.now() }));

    const res = await fetch(`http://localhost:${port}/rpc`, { method: 'POST', body: form });
    const data = await res.json();
    expect(data.error.code).toBe(10002);
  });

  it.skip('should accept book.translate with file and targetLang', async () => {
    const data = await rpcUpload(port, 'book.translate', { targetLang: 'es', sourceLang: 'en', model: 'llama3.1' }, SAMPLE_EPUB);
    expect(data.result.jobId).toBeTruthy();
    expect(['queued', 'parsing']).toContain(data.result.status);
  });

  // ── Books ────────────────────────────────────────

  it('should list books via book.list', async () => {
    const data = await rpc(port, 'book.list');
    expect(Array.isArray(data.result.books)).toBe(true);
  });

  it('should return BOOK_NOT_FOUND for unknown book', async () => {
    const data = await rpc(port, 'book.get', { bookId: 'nonexistent-id' });
    expect(data.error.code).toBe(10003);
  });

  // ── Jobs ─────────────────────────────────────────

  it('should list jobs via job.list', async () => {
    const data = await rpc(port, 'job.list');
    expect(Array.isArray(data.result.jobs)).toBe(true);
  });

  it('should return JOB_NOT_FOUND for unknown job', async () => {
    const data = await rpc(port, 'job.get', { jobId: 'nonexistent-id' });
    expect(data.error.code).toBe(10004);
  });

  it('should return JOB_NOT_COMPLETE for download of incomplete job', async () => {
    const job = jobQueue.create({
      originalFilename: 'test.epub',
      inputPath: '/tmp/test.epub',
      targetLang: 'es',
      sourceLang: 'en',
      model: 'llama3.1',
    });

    const data = await rpc(port, 'book.download', { jobId: job.id });
    expect(data.error.code).toBe(10005);
  });

  it('should delete a job via job.delete', async () => {
    const job = jobQueue.create({
      originalFilename: 'delete-me.epub',
      inputPath: '/tmp/delete-me.epub',
      targetLang: 'es',
      sourceLang: 'en',
      model: 'llama3.1',
    });

    const data = await rpc(port, 'job.delete', { jobId: job.id });
    expect(data.result.deleted).toBe(true);
    expect(jobQueue.get(job.id)).toBeUndefined();
  });

  // ── Web UI ───────────────────────────────────────

  it('should serve the web UI', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('AI Translate');
  });
});
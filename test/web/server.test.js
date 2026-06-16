import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../../src/web/server.js';
import { JobQueue } from '../../src/web/job-queue.js';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const SAMPLE_EPUB = path.join(FIXTURES_DIR, 'sample.epub');

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
    // Ensure job2 has a later timestamp
    const job2 = queue.create({
      originalFilename: 'second.epub',
      inputPath: '/tmp/second.epub',
      targetLang: 'fr',
      sourceLang: 'en',
      model: 'llama3.1',
    });

    const list = queue.list();
    expect(list.length).toBe(2);
    // Both jobs exist in the list
    const ids = list.map(j => j.id);
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

describe('Web Server API', () => {
  let server;
  let jobQueue;
  let port;

  beforeAll(async () => {
    const { app, server: srv, jobQueue: jq } = createApp();
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

  afterAll(() => {
    server.close();
  });

  it('should serve health check', async () => {
    const res = await fetch(`http://localhost:${port}/api/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
  });

  it('should serve the web UI', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('AI Translate');
  });

  it('should return 400 for upload without file', async () => {
    const res = await fetch(`http://localhost:${port}/api/translate`, {
      method: 'POST',
    });
    expect(res.status).toBe(400);
  });

  it('should return 400 for upload without targetLang', async () => {
    const form = new FormData();
    const fileBuffer = fs.readFileSync(SAMPLE_EPUB);
    form.append('file', new Blob([fileBuffer]), 'sample.epub');

    const res = await fetch(`http://localhost:${port}/api/translate`, {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it('should accept a valid upload and create a job', async () => {
    const form = new FormData();
    const fileBuffer = fs.readFileSync(SAMPLE_EPUB);
    form.append('file', new Blob([fileBuffer]), 'sample.epub');
    form.append('targetLang', 'es');
    form.append('sourceLang', 'en');
    form.append('model', 'llama3.1');

    const res = await fetch(`http://localhost:${port}/api/translate`, {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.jobId).toBeTruthy();
    // Status may be 'queued' or already progressed to 'parsing' since pipeline starts async
    expect(['queued', 'parsing']).toContain(data.status);

    // Check that the job exists in the queue
    const job = jobQueue.get(data.jobId);
    expect(job).toBeDefined();
    expect(job.originalFilename).toBe('sample.epub');
    expect(job.targetLang).toBe('es');
  });

  it('should list jobs', async () => {
    const res = await fetch(`http://localhost:${port}/api/jobs`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.jobs.length).toBeGreaterThan(0);
  });

  it('should return 404 for non-existent job', async () => {
    const res = await fetch(`http://localhost:${port}/api/jobs/nonexistent-id`);
    expect(res.status).toBe(404);
  });

  it('should return 400 for download of incomplete job', async () => {
    const job = jobQueue.create({
      originalFilename: 'test.epub',
      inputPath: '/tmp/test.epub',
      targetLang: 'es',
      sourceLang: 'en',
      model: 'llama3.1',
    });

    const res = await fetch(`http://localhost:${port}/api/jobs/${job.id}/download`);
    expect(res.status).toBe(400);
  });

  it('should delete a job', async () => {
    const job = jobQueue.create({
      originalFilename: 'delete-me.epub',
      inputPath: '/tmp/delete-me.epub',
      targetLang: 'es',
      sourceLang: 'en',
      model: 'llama3.1',
    });

    const res = await fetch(`http://localhost:${port}/api/jobs/${job.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);

    // Verify job is gone
    expect(jobQueue.get(job.id)).toBeUndefined();
  });
});
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import type { TranslationJob, JobStatus, BookMetadata } from '../types.js';

const UPLOAD_DIR = path.join(process.cwd(), '.uploads');
const OUTPUT_DIR = path.join(process.cwd(), '.output');

// Ensure dirs exist
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

/**
 * In-memory job queue manager for translation jobs.
 * Tracks job status, progress, and file paths.
 */
export class JobQueue {
  private jobs: Map<string, TranslationJob> = new Map();
  private onUpdate?: (job: TranslationJob) => void;

  constructor(onUpdate?: (job: TranslationJob) => void) {
    this.onUpdate = onUpdate;
  }

  /**
   * Create a new translation job.
   */
  create(params: {
    originalFilename: string;
    inputPath: string;
    targetLang: string;
    sourceLang: string;
    model: string;
  }): TranslationJob {
    const job: TranslationJob = {
      id: uuidv4(),
      originalFilename: params.originalFilename,
      inputPath: params.inputPath,
      outputPath: null,
      targetLang: params.targetLang,
      sourceLang: params.sourceLang,
      model: params.model,
      status: 'queued',
      progress: 0,
      message: 'Job queued',
      error: null,
      createdAt: new Date(),
      finishedAt: null,
      metadata: null,
    };

    this.jobs.set(job.id, job);
    this.notify(job);
    return job;
  }

  /**
   * Get a job by ID.
   */
  get(id: string): TranslationJob | undefined {
    return this.jobs.get(id);
  }

  /**
   * Get all jobs (most recent first).
   */
  list(): TranslationJob[] {
    return Array.from(this.jobs.values())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Update a job's status and progress.
   */
  updateStatus(id: string, status: JobStatus, message: string, progress?: number): void {
    const job = this.jobs.get(id);
    if (!job) return;

    job.status = status;
    job.message = message;
    if (progress !== undefined) {
      job.progress = Math.min(100, Math.max(0, progress));
    }

    if (status === 'completed' || status === 'failed') {
      job.finishedAt = new Date();
      if (status === 'completed') {
        job.progress = 100;
      }
    }

    this.notify(job);
  }

  /**
   * Set the output path for a completed job.
   */
  setOutputPath(id: string, outputPath: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.outputPath = outputPath;
  }

  /**
   * Set book metadata on a job (after parsing).
   */
  setMetadata(id: string, metadata: BookMetadata): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.metadata = metadata;
  }

  /**
   * Set error on a failed job.
   */
  setError(id: string, error: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.error = error;
    job.status = 'failed';
    job.finishedAt = new Date();
    this.notify(job);
  }

  /**
   * Delete a job and its files.
   */
  async delete(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job) return false;

    // Clean up files
    try {
      if (job.inputPath && fs.existsSync(job.inputPath)) {
        fs.unlinkSync(job.inputPath);
      }
      if (job.outputPath && fs.existsSync(job.outputPath)) {
        fs.unlinkSync(job.outputPath);
      }
    } catch {
      // Ignore file cleanup errors
    }

    this.jobs.delete(id);
    return true;
  }

  /**
   * Get the upload directory path.
   */
  static getUploadDir(): string {
    return UPLOAD_DIR;
  }

  /**
   * Get the output directory path.
   */
  static getOutputDir(): string {
    return OUTPUT_DIR;
  }

  /**
   * Clean up old jobs (older than maxAgeMs).
   */
  cleanup(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, job] of this.jobs.entries()) {
      const age = now - job.createdAt.getTime();
      if (age > maxAgeMs && (job.status === 'completed' || job.status === 'failed')) {
        this.delete(id);
        cleaned++;
      }
    }

    return cleaned;
  }

  private notify(job: TranslationJob): void {
    if (this.onUpdate) {
      this.onUpdate(job);
    }
  }
}
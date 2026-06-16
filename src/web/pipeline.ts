import path from 'path';
import fs from 'fs';

import { JobQueue } from './job-queue.js';
import { EpubParser } from '../parsers/epub-parser.js';
import { Fb2Parser } from '../parsers/fb2-parser.js';
import { EpubWriter } from '../parsers/epub-writer.js';
import { OllamaClient } from '../translators/ollama-client.js';
import { TranslationOrchestrator } from '../translators/orchestrator.js';
import { JobQueue as JQStatic } from './job-queue.js';
import type { TranslationJob } from '../types.js';

/**
 * Run the full translation pipeline for a job.
 * Updates the job status in the queue as it progresses.
 */
export async function runTranslation(
  job: TranslationJob,
  jobQueue: JobQueue,
  options?: { ollamaUrl?: string },
): Promise<void> {
  const ollamaUrl = options?.ollamaUrl || 'http://localhost:11434';
  const outputDir = JQStatic.getOutputDir();

  try {
    // ── Step 1: Parse ──────────────────────────────────────────
    jobQueue.updateStatus(job.id, 'parsing', 'Parsing file...', 5);

    const ext = path.extname(job.inputPath).toLowerCase();
    let parsed;

    if (ext === '.epub') {
      const parser = new EpubParser(job.inputPath);
      parsed = await parser.parse();
    } else if (ext === '.fb2') {
      const parser = new Fb2Parser(job.inputPath);
      parsed = await parser.parse();
    } else {
      throw new Error(`Unsupported file format: ${ext}`);
    }

    // Store metadata
    jobQueue.setMetadata(job.id, parsed.metadata);
    jobQueue.updateStatus(job.id, 'parsing', `Parsed: "${parsed.metadata.title}" — ${parsed.contentDocs.length} chapters`, 10);

    // ── Step 2: Translate ──────────────────────────────────────
    jobQueue.updateStatus(job.id, 'translating', 'Starting translation...', 15);

    const client = new OllamaClient({ baseUrl: ollamaUrl, model: job.model });
    const orchestrator = new TranslationOrchestrator(client);

    // Count total text nodes for progress
    let totalNodes = 0;
    for (const doc of parsed.contentDocs) {
      totalNodes += orchestrator.extractTextNodes(doc.dom).length;
    }

    let completedNodes = 0;
    const totalDocs = parsed.contentDocs.length;

    for (let i = 0; i < totalDocs; i++) {
      const doc = parsed.contentDocs[i];

      await orchestrator.translateDocument(doc.dom, {
        sourceLang: job.sourceLang === 'auto' ? parsed.metadata.language : job.sourceLang,
        targetLang: job.targetLang,
        onProgress: (progress) => {
          completedNodes = progress.translated;
          // Progress: 15% (start) → 90% (translation done)
          const docProgress = ((i + progress.translated / progress.totalNodes) / totalDocs);
          const overallProgress = 15 + Math.round(docProgress * 75);
          const chapterMsg = `Chapter ${i + 1}/${totalDocs}: ${path.basename(doc.path)}`;
          jobQueue.updateStatus(job.id, 'translating', chapterMsg, overallProgress);
        },
      });
    }

    // ── Step 3: Assemble ────────────────────────────────────────
    jobQueue.updateStatus(job.id, 'assembling', 'Assembling translated EPUB...', 92);

    const writer = new EpubWriter(parsed);
    for (const doc of parsed.contentDocs) {
      writer.updateContentDoc(doc.path, doc.dom.outerHTML);
    }

    const baseName = path.basename(job.originalFilename, path.extname(job.originalFilename));
    const outputPath = path.join(outputDir, `${job.id}_${baseName}_${job.targetLang}.epub`);
    await writer.write(outputPath);

    jobQueue.setOutputPath(job.id, outputPath);
    jobQueue.updateStatus(job.id, 'completed', 'Translation complete!', 100);

  } catch (err: any) {
    jobQueue.setError(job.id, err.message || 'Unknown error');
    jobQueue.updateStatus(job.id, 'failed', `Failed: ${err.message}`, 0);
  }
}
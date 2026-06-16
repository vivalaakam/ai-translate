import path from 'path';
import fs from 'fs';

import { TranslateDb, generateBookId } from '../db/database.js';
import { EpubParser } from '../parsers/epub-parser.js';
import { Fb2Parser } from '../parsers/fb2-parser.js';
import { EpubWriter } from '../parsers/epub-writer.js';
import { OllamaClient } from '../translators/ollama-client.js';
import { extractAllBlocks } from '../parsers/block-extractor.js';
import { assembleDocHtml } from '../parsers/block-assembler.js';
import { JobQueue as JQStatic } from '../web/job-queue.js';
import { JobQueue } from '../web/job-queue.js';
import { parseProvider, ensureModelLoaded, unloadIfWeLoaded } from '../translators/model-manager.js';
import type { TranslationJob } from '../types.js';

/**
 * Run the full block-based translation pipeline for a job.
 *
 * 1. Parse the book file
 * 2. Extract blocks → store in SQLite
 * 3. Translate each untranslated block individually
 * 4. Assemble translated blocks back into EPUB
 *
 * For LM Studio: auto-loads the model before translation,
 * and unloads it after (if it wasn't already loaded).
 *
 * Updates the job status in the queue as it progresses.
 */
export async function runTranslation(
  job: TranslationJob,
  jobQueue: JobQueue,
  options?: { ollamaUrl?: string; apiKey?: string; dbPath?: string; provider?: string },
): Promise<void> {
  const ollamaUrl = options?.ollamaUrl || 'http://localhost:11434';
  const apiKey = options?.apiKey || '';
  const provider = parseProvider(options?.provider);
  const outputDir = JQStatic.getOutputDir();
  const db = new TranslateDb(options?.dbPath);
  let modelLoadedByUs = false;

  try {
    // ── Step 0: Load model (LM Studio) ──────────────────────
    if (provider === 'lmstudio') {
      jobQueue.updateStatus(job.id, 'parsing', `Loading model "${job.model}" in LM Studio...`, 2);
      modelLoadedByUs = ensureModelLoaded(job.model, provider);
      const statusMsg = modelLoadedByUs
        ? `Model "${job.model}" loaded into LM Studio`
        : `Model "${job.model}" already loaded in LM Studio`;
      jobQueue.updateStatus(job.id, 'parsing', statusMsg, 4);
    }

    // ── Step 1: Parse ──────────────────────────────────────────
    jobQueue.updateStatus(job.id, 'parsing', 'Parsing file...', 5);

    const ext = path.extname(job.inputPath).toLowerCase();
    const fileBuffer = fs.readFileSync(job.inputPath);
    const bookId = generateBookId(fileBuffer);

    // Check if book already exists in DB (resume support)
    const existingBook = db.getBook(bookId);
    if (existingBook && existingBook.completedAt) {
      jobQueue.updateStatus(job.id, 'completed', `Book already translated: "${existingBook.title}"`, 100);
      return;
    }

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

    // ── Step 2: Extract blocks ────────────────────────────────
    jobQueue.updateStatus(job.id, 'parsing', 'Extracting blocks...', 8);

    const blocks = extractAllBlocks(parsed.contentDocs, bookId);

    // Store book record
    if (!existingBook) {
      db.insertBook({
        id: bookId,
        title: parsed.metadata.title,
        author: parsed.metadata.author,
        language: parsed.metadata.language,
        filename: job.originalFilename,
        totalBlocks: blocks.length,
        targetLang: job.targetLang,
        sourceLang: job.sourceLang,
        model: job.model,
      });
    } else {
      db.setBookTranslationConfig(bookId, job.targetLang, job.sourceLang, job.model);
    }

    // Store blocks
    db.insertBlocks(blocks);

    // Store metadata on job
    jobQueue.setMetadata(job.id, parsed.metadata);
    jobQueue.updateStatus(job.id, 'parsing', `Parsed: "${parsed.metadata.title}" — ${blocks.length} blocks`, 10);

    // ── Step 3: Translate blocks ──────────────────────────────
    jobQueue.updateStatus(job.id, 'translating', 'Starting block-by-block translation...', 12);

    const client = new OllamaClient({ baseUrl: ollamaUrl, model: job.model, apiKey });
    const sourceLang = job.sourceLang === 'auto' ? parsed.metadata.language : job.sourceLang;

    // Get only untranslated blocks (skip images, already translated)
    const untranslated = db.getUntranslatedBlocks(bookId);
    const totalToTranslate = untranslated.length;
    let translatedCount = 0;

    // Get existing count for progress
    const counts = db.countBlocks(bookId);
    const alreadyTranslated = counts.translated;

    for (let i = 0; i < untranslated.length; i++) {
      const block = untranslated[i];

      try {
        const translatedMd = await client.translate(block.originalMd, {
          sourceLang,
          targetLang: job.targetLang,
          maxRetries: 3,
        });

        db.updateBlockTranslation(block.id, translatedMd);
        translatedCount++;

        // Update progress: 12% (start) → 90% (translation done)
        const overallProgress = 12 + Math.round((translatedCount / totalToTranslate) * 78);
        const chapterMsg = `Block ${i + 1}/${totalToTranslate}: ${block.originalMd.slice(0, 40)}...`;
        jobQueue.updateStatus(job.id, 'translating', chapterMsg, overallProgress);

        // Update book progress
        db.updateBookProgress(bookId, alreadyTranslated + translatedCount);
      } catch (err: any) {
        // Log but continue — one block failure shouldn't stop the whole book
        console.error(`Failed to translate block ${block.id}: ${err.message}`);
        // Store empty translation to mark as attempted
        db.updateBlockTranslation(block.id, block.originalMd); // Fallback to original
        translatedCount++;
      }
    }

    // Mark book as complete
    db.completeBook(bookId);

    // ── Step 4: Assemble ────────────────────────────────────────
    jobQueue.updateStatus(job.id, 'assembling', 'Assembling translated EPUB...', 92);

    const writer = new EpubWriter(parsed);

    // Reassemble each content doc from its blocks
    const docPaths = db.getDocPaths(bookId);
    for (const docPath of docPaths) {
      const docBlocks = db.getBlocksByDoc(bookId, docPath);
      const html = assembleDocHtml(docBlocks);
      writer.updateContentDoc(docPath, html);
    }

    const baseName = path.basename(job.originalFilename, path.extname(job.originalFilename));
    const outputPath = path.join(outputDir, `${job.id}_${baseName}_${job.targetLang}.epub`);
    await writer.write(outputPath);

    jobQueue.setOutputPath(job.id, outputPath);
    jobQueue.updateStatus(job.id, 'completed', 'Translation complete!', 100);

  } catch (err: any) {
    jobQueue.setError(job.id, err.message || 'Unknown error');
    jobQueue.updateStatus(job.id, 'failed', `Failed: ${err.message}`, 0);
  } finally {
    db.close();
    // Unload model if we loaded it (LM Studio)
    if (modelLoadedByUs) {
      try {
        unloadIfWeLoaded(job.model, modelLoadedByUs, provider);
      } catch {
        // Best-effort — don't fail the job on unload failure
      }
    }
  }
}
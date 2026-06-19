import path from 'path';
import fs from 'fs';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';

import { TranslateDb, generateBookId } from '../db/database.js';
import { QueryTypes } from '@sequelize/core';
import { EpubParser } from '../parsers/epub-parser.js';
import { Fb2Parser } from '../parsers/fb2-parser.js';
import { PdfParser, getPdfInfo, renderPdfPage, markdownToHtml } from '../parsers/pdf-parser.js';
import { assembleEpub } from '../parsers/epub-assembler.js';
import { OllamaClient } from '../translators/ollama-client.js';
import { OcrClient } from '../translators/ocr-client.js';
import { extractAllBlocks } from '../parsers/block-extractor.js';
import { JobQueue as JQStatic } from '../web/job-queue.js';
import { JobQueue } from '../web/job-queue.js';
import { parseProvider, ensureModelLoaded, unloadIfWeLoaded, unloadModel } from '../translators/model-manager.js';
import { OLLAMA_DEFAULT_URL, DEFAULT_OCR_MODEL, DEFAULT_API_KEY, DEFAULT_LLM_PROVIDER } from '../utils/constants.js';
import type { TranslationJob, BookRecord, ParsedEpub, TaskRecord } from '../types.js';
import { parse as parseHtml } from 'node-html-parser';

// Track which OCR models were loaded by us (per model name)
const _loadedOcrModels = new Set<string>();

/**
 * Check if there are any pending or processing ocr_page tasks in the DB.
 */
async function hasPendingOcrTasks(db: TranslateDb): Promise<boolean> {
  const rows = await db.sequelize.query<{ cnt: string }>(
    `SELECT COUNT(*) as cnt FROM tasks WHERE type = 'ocr_page' AND status IN ('pending', 'processing')`,
    { type: QueryTypes.SELECT },
  );
  return parseInt(rows[0].cnt) > 0;
}

/**
 * Unload OCR models if no more pending/processing ocr_page tasks remain.
 */
async function maybeUnloadOcrModels(db: TranslateDb): Promise<void> {
  const hasMore = await hasPendingOcrTasks(db);
  if (!hasMore) {
    for (const model of _loadedOcrModels) {
      try {
        unloadModel(model);
        console.log(`[ocr] Model "${model}" unloaded from LM Studio — no more ocr_page tasks`);
      } catch {
        // Best-effort
      }
    }
    _loadedOcrModels.clear();
  }
}

/**
 * Parse a file into ParsedEpub based on its extension.
 * Handles EPUB, FB2, and PDF (via OCR).
 */
async function parseFile(
  inputPath: string,
  ext: string,
  options: { ollamaUrl?: string; apiKey?: string; onProgress?: (current: number, total: number) => void },
): Promise<ParsedEpub> {
  if (ext === '.epub') {
    const parser = new EpubParser(inputPath);
    return await parser.parse();
  } else if (ext === '.fb2') {
    const parser = new Fb2Parser(inputPath);
    return await parser.parse();
  } else if (ext === '.pdf') {
    const parser = new PdfParser(inputPath, {
      ollamaUrl: options.ollamaUrl,
      apiKey: options.apiKey,
    });
    return await parser.parse(options.onProgress);
  }
  throw new Error(`Unsupported file format: ${ext}`);
}

/**
 * Upload a book: parse + extract blocks → store in PostgreSQL.
 * No translation — just indexing the book for later translation.
 *
 * Returns the book record from DB.
 */
export async function runUpload(
  job: TranslationJob,
  jobQueue: JobQueue,
  options?: { dbPath?: string; ollamaUrl?: string; apiKey?: string },
): Promise<BookRecord> {
  const db = new TranslateDb(options?.dbPath);

  try {
    // Ensure DB schema exists
    await db.migrate();

    // ── Parse ────────────────────────────────────────────────
    jobQueue.updateStatus(job.id, 'parsing', 'Parsing file...', 5);

    const ext = path.extname(job.inputPath).toLowerCase();
    const fileBuffer = fs.readFileSync(job.inputPath);
    const bookId = generateBookId(fileBuffer);

    // Check if book already exists in DB
    const existingBook = await db.getBook(bookId);
    if (existingBook) {
      jobQueue.updateStatus(job.id, 'completed', `Book already in DB: "${existingBook.title}"`, 100);
      jobQueue.setMetadata(job.id, {
        title: existingBook.title,
        author: existingBook.author,
        language: existingBook.language,
        format: ext.replace('.', ''),
      });
      return existingBook;
    }

    // ── PDF: async task-based parsing ────────────────────────
    if (ext === '.pdf') {
      const pdfMeta = getPdfInfo(job.inputPath);
      const totalPages = pdfMeta.pageCount;

      // Create doc record with status='parsing'
      await db.insertBook({
        id: bookId,
        title: pdfMeta.title || path.basename(job.originalFilename, '.pdf'),
        author: pdfMeta.author || '',
        language: 'en',
        filename: job.originalFilename,
        totalBlocks: 0,
        status: 'parsing',
        totalPages,
        parsedPages: 0,
        sourcePath: job.inputPath,
      });

      // Create OCR tasks — one per page
      const tasks = [];
      for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        tasks.push({
          id: uuidv4(),
          docId: bookId,
          type: 'ocr_page',
          pageNum,
          totalPages,
        });
      }
      await db.createTasks(tasks);

      jobQueue.setMetadata(job.id, {
        title: pdfMeta.title || path.basename(job.originalFilename, '.pdf'),
        author: pdfMeta.author || '',
        language: 'en',
        format: 'pdf',
      });
      jobQueue.updateStatus(job.id, 'completed', `PDF queued for OCR: ${totalPages} pages`, 100);

      return (await db.getBook(bookId))!;
    }

    // ── EPUB/FB2: synchronous parsing (as before) ────────────
    const parsed = await parseFile(job.inputPath, ext, {
      ollamaUrl: options?.ollamaUrl,
      apiKey: options?.apiKey,
      onProgress: (current, total) => {
        const pct = 5 + Math.round((current / total) * 20);
        jobQueue.updateStatus(job.id, 'parsing', `OCR page ${current}/${total}...`, pct);
      },
    });

    // ── Extract blocks + images ──────────────────────────────
    jobQueue.updateStatus(job.id, 'parsing', 'Extracting blocks...', 30);

    const { blocks, files } = extractAllBlocks(parsed.contentDocs, bookId, parsed.images);

    // Store book record
    await db.insertBook({
      id: bookId,
      title: parsed.metadata.title,
      author: parsed.metadata.author,
      language: parsed.metadata.language,
      filename: job.originalFilename,
      totalBlocks: blocks.length,
      status: 'parsed',
      sourcePath: job.inputPath,
    });

    // Store image files
    if (files.length > 0) {
      await db.insertFiles(files);
    }

    // Store blocks
    await db.insertBlocks(blocks);

    // Store metadata on job
    jobQueue.setMetadata(job.id, parsed.metadata);
    jobQueue.updateStatus(job.id, 'completed', `Parsed: "${parsed.metadata.title}" — ${blocks.length} blocks, ${files.length} images`, 100);

    const book = await db.getBook(bookId);
    return book!;
  } catch (err: any) {
    jobQueue.setError(job.id, err.message || 'Unknown error');
    jobQueue.updateStatus(job.id, 'failed', `Failed: ${err.message}`, 0);
    throw err;
  } finally {
    await db.close();
  }
}

/**
 * Run the full block-based translation pipeline for a job.
 *
 * 1. Parse the book file
 * 2. Extract blocks → store in PostgreSQL
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
    // Ensure DB schema exists
    await db.migrate();

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
    const existingBook = await db.getBook(bookId);
    if (existingBook && existingBook.completedAt) {
      jobQueue.updateStatus(job.id, 'completed', `Book already translated: "${existingBook.title}"`, 100);
      return;
    }

    const parsed = await parseFile(job.inputPath, ext, {
      ollamaUrl: ollamaUrl,
      apiKey: apiKey,
      onProgress: (current, total) => {
        const pct = 5 + Math.round((current / total) * 5);
        jobQueue.updateStatus(job.id, 'parsing', `OCR page ${current}/${total}...`, pct);
      },
    });

    // ── Step 2: Extract blocks + images ────────────────────────
    jobQueue.updateStatus(job.id, 'parsing', 'Extracting blocks...', 8);

    const { blocks, files } = extractAllBlocks(parsed.contentDocs, bookId, parsed.images);

    // Store book record
    if (!existingBook) {
      await db.insertBook({
        id: bookId,
        title: parsed.metadata.title,
        author: parsed.metadata.author,
        language: parsed.metadata.language,
        filename: job.originalFilename,
        totalBlocks: blocks.length,
        targetLang: job.targetLang,
        sourceLang: job.sourceLang,
        model: job.model,
        sourcePath: job.inputPath,
      });
    } else {
      await db.setBookTranslationConfig(bookId, job.targetLang, job.sourceLang, job.model);
    }

    // Store image files
    if (files.length > 0) {
      await db.insertFiles(files);
    }

    // Store blocks
    await db.insertBlocks(blocks);

    // Store metadata on job
    jobQueue.setMetadata(job.id, parsed.metadata);
    jobQueue.updateStatus(job.id, 'parsing', `Parsed: "${parsed.metadata.title}" — ${blocks.length} blocks, ${files.length} images`, 10);

    // ── Step 3: Translate blocks ──────────────────────────────
    jobQueue.updateStatus(job.id, 'translating', 'Starting block-by-block translation...', 12);

    const client = new OllamaClient({ baseUrl: ollamaUrl, model: job.model, apiKey });
    const sourceLang = job.sourceLang === 'auto' ? parsed.metadata.language : job.sourceLang;

    // Get only untranslated blocks (skip images, already translated)
    const untranslated = await db.getUntranslatedBlocks(bookId, job.targetLang, job.model);
    const totalToTranslate = untranslated.length;
    let translatedCount = 0;

    // Get existing count for progress
    const counts = await db.countBlocks(bookId, job.targetLang, job.model);
    const alreadyTranslated = counts.translated;

    for (let i = 0; i < untranslated.length; i++) {
      const block = untranslated[i];

      try {
        const translatedMd = await client.translate(block.content, {
          sourceLang,
          targetLang: job.targetLang,
          maxRetries: 3,
        });

        await db.upsertTranslation(block, translatedMd, job.targetLang, job.model);
        translatedCount++;

        // Update progress: 12% (start) → 90% (translation done)
        const overallProgress = 12 + Math.round((translatedCount / totalToTranslate) * 78);
        const chapterMsg = `Block ${i + 1}/${totalToTranslate}: ${block.content.slice(0, 40)}...`;
        jobQueue.updateStatus(job.id, 'translating', chapterMsg, overallProgress);

        // Update book progress
        await db.updateBookProgress(bookId, alreadyTranslated + translatedCount);
      } catch (err: any) {
        // Log but continue — one block failure shouldn't stop the whole book
        console.error(`Failed to translate block ${block.id}: ${err.message}`);
        // Store empty translation to mark as attempted
        await db.upsertTranslation(block, block.content, job.targetLang, job.model); // Fallback to original
        translatedCount++;
      }
    }

    // Mark book as complete
    await db.completeBook(bookId);

    // ── Step 4: Assemble ────────────────────────────────────────
    jobQueue.updateStatus(job.id, 'assembling', 'Assembling translated EPUB...', 92);

    const baseName = path.basename(job.originalFilename, path.extname(job.originalFilename));
    const outputPath = path.join(outputDir, `${job.id}_${baseName}_${job.targetLang}.epub`);
    await assembleEpub(bookId, db, outputPath, { mode: 'translated', lang: job.targetLang });

    jobQueue.setOutputPath(job.id, outputPath);
    jobQueue.updateStatus(job.id, 'completed', 'Translation complete!', 100);

  } catch (err: any) {
    jobQueue.setError(job.id, err.message || 'Unknown error');
    jobQueue.updateStatus(job.id, 'failed', `Failed: ${err.message}`, 0);
  } finally {
    await db.close();
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

/**
 * Process a single OCR task: ensure model loaded → render PDF page → OCR → save content.
 * Called by the task worker loop in server.ts.
 *
 * @param task - The task record from the DB
 * @param inputPath - Path to the uploaded PDF file
 * @param ollamaUrl - API base URL for the OCR model
 * @param apiKey - API key for authentication
 * @param ocrModel - OCR model name (e.g. 'deepseek-ocr')
 * @param provider - LLM provider ('lmstudio', 'ollama', 'remote')
 */
export async function processOcrTask(
  task: TaskRecord,
  inputPath: string,
  ollamaUrl: string,
  apiKey: string,
  ocrModel: string,
  provider: string,
): Promise<void> {
  const db = new TranslateDb();
  const parsedProvider = parseProvider(provider);
  let modelLoadedByUs = false;

  try {
    // ── Ensure OCR model is loaded (LM Studio) ────────────────
    if (parsedProvider === 'lmstudio' && !_loadedOcrModels.has(ocrModel)) {
      console.log(`[ocr] Loading model "${ocrModel}" into LM Studio (provider=${parsedProvider})...`);
      modelLoadedByUs = ensureModelLoaded(ocrModel, parsedProvider);
      _loadedOcrModels.add(ocrModel);
      console.log(`[ocr] Model "${ocrModel}" ${modelLoadedByUs ? 'loaded into LM Studio' : 'already loaded'}`);
    }

    // Render the PDF page to PNG
    console.log(`[ocr] Task ${task.id}: rendering page ${task.pageNum} from ${inputPath}...`);
    const imgBuffer = renderPdfPage(inputPath, task.pageNum!);
    console.log(`[ocr] Task ${task.id}: page ${task.pageNum} rendered, ${imgBuffer.length} bytes`);

    // OCR the page
    console.log(`[ocr] Task ${task.id}: calling OCR API (model=${ocrModel}, url=${ollamaUrl})...`);
    const ocrClient = new OcrClient({ baseUrl: ollamaUrl, model: ocrModel, apiKey });
    const markdown = await ocrClient.extractPage(imgBuffer, 'image/png', task.pageNum!);
    console.log(`[ocr] Task ${task.id}: OCR done, ${markdown.length} chars extracted`);

    // Save content to task
    await db.completeTask(task.id, markdown);
    console.log(`[ocr] Task ${task.id}: completed, content saved`);

    // Update doc progress
    const counts = await db.getTaskCounts(task.docId);
    await db.updateDocStatus(task.docId, 'parsing', { parsedPages: counts.completed });
    console.log(`[ocr] Doc ${task.docId}: ${counts.completed}/${counts.total} pages done (${counts.failed} failed)`);

    // Check if all tasks are done
    if (counts.completed + counts.failed >= counts.total && counts.processing === 0) {
      console.log(`[ocr] Doc ${task.docId}: all tasks done, finalizing...`);
      await finalizeDocParsing(task.docId, inputPath);
    }

    // ── Unload OCR model if no more ocr_page tasks pending ──
    await maybeUnloadOcrModels(db);
  } catch (err: any) {
    console.error(`[ocr] Task ${task.id} FAILED: ${err.message}`);
    if (err.stack) console.error(err.stack);
    await db.failTask(task.id, err.message || 'Unknown error');
    console.error(`[ocr] Task ${task.id}: marked as failed in DB`);
    // Check if all tasks are done even after failure
    const counts = await db.getTaskCounts(task.docId);
    if (counts.completed + counts.failed >= counts.total && counts.processing === 0) {
      console.log(`[ocr] Doc ${task.docId}: all tasks done (after failure), finalizing...`);
      await finalizeDocParsing(task.docId, inputPath);
    }
    // ── Unload OCR model if no more ocr_page tasks pending ──
    await maybeUnloadOcrModels(db);
  } finally {
    await db.close();
  }
}

/**
 * Finalize document parsing after all OCR tasks are complete.
 * Collects all task content, converts to ContentDocs, extracts blocks,
 * and stores them in the DB.
 *
 * @param docId - Document ID
 * @param inputPath - Path to the original PDF file
 */
export async function finalizeDocParsing(docId: string, inputPath: string): Promise<void> {
  const db = new TranslateDb();
  try {
    const tasks = await db.getTasksByDoc(docId);
    const completedTasks = tasks.filter(t => t.status === 'completed' && t.content);

    if (completedTasks.length === 0) {
      await db.updateDocStatus(docId, 'failed');
      return;
    }

    // Build ContentDocs from task content (ordered by page number)
    const contentDocs = completedTasks
      .sort((a, b) => (a.pageNum ?? 0) - (b.pageNum ?? 0))
      .map(t => {
        const html = markdownToHtml(t.content!);
        const dom = parseHtml(html, { comment: true, voidTag: { closingSlash: true } });
        const docPath = `page-${String(t.pageNum ?? 0).padStart(4, '0')}.xhtml`;
        return { path: docPath, dom, rawContent: html, sectionTitle: `Page ${t.pageNum}` };
      });

    // Extract blocks
    const { blocks, files: imgFiles } = extractAllBlocks(contentDocs, docId, []);

    // Update doc record with block count and status='parsed'
    await db.updateDocStatus(docId, 'parsed', { parsedPages: completedTasks.length });

    // Store files (if any images were extracted)
    if (imgFiles.length > 0) {
      await db.insertFiles(imgFiles);
    }

    // Store blocks
    await db.insertBlocks(blocks);

    // Update total_blocks
    await db.updateTotalBlocks(docId, blocks.length);

    console.log(`[finalizeDocParsing] Doc ${docId}: ${blocks.length} blocks from ${completedTasks.length} pages`);
  } catch (err: any) {
    console.error(`[finalizeDocParsing] Failed for doc ${docId}:`, err.message);
    await db.updateDocStatus(docId, 'failed');
  } finally {
    await db.close();
  }
}

/**
 * Export a book from the database to an EPUB file.
 * Works for both original and translated versions.
 *
 * @param bookId - Book ID in the database
 * @param options - Export mode ('original' or 'translated') and language
 * @param outputDir - Directory for the output EPUB file
 * @param dbPath - Path to the database
 * @returns Output file path
 */
export async function runExport(
  bookId: string,
  options: { mode: 'original' | 'translated'; lang?: string },
  outputDir: string,
  dbPath?: string,
): Promise<string> {
  const db = new TranslateDb(dbPath);
  try {
    await db.migrate();
    const book = await db.getBook(bookId);
    if (!book) throw new Error(`Book not found: ${bookId}`);

    const suffix = options.mode === 'translated' ? `_${book.targetLang || 'translated'}` : '_exported';
    const baseName = path.basename(book.filename, path.extname(book.filename));
    const outputPath = path.join(outputDir, `${baseName}${suffix}.epub`);

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    await assembleEpub(bookId, db, outputPath, options);

    return outputPath;
  } finally {
    await db.close();
  }
}
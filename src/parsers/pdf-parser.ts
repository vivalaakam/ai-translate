/**
 * PDF Parser — converts PDF files to ParsedEpub format via OCR.
 *
 * Pipeline:
 *   PDF file → pdftoppm (poppler) → PNG per page → OcrClient (vision LLM) → Markdown → HTML → ContentDoc
 *
 * Each page becomes a separate ContentDoc (chapter), consistent with how
 * EPUB/FB2 parsers produce one ContentDoc per chapter.
 *
 * Requirements:
 *   - poppler-utils (pdftoppm, pdfinfo) — install via `brew install poppler` (macOS)
 *   - A vision-capable LLM accessible via OpenAI-compatible API (configured by OCR_MODEL)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { parse as parseHtml } from 'node-html-parser';

import { OcrClient } from '../translators/ocr-client.js';
import { OLLAMA_DEFAULT_URL, DEFAULT_OCR_MODEL, DEFAULT_API_KEY } from '../utils/constants.js';
import type { ParsedEpub, ContentDoc, BookMetadata, ExtractedImage } from '../types.js';

/** DPI for page rendering — higher = better OCR quality but slower */
const DEFAULT_DPI = 200;

/**
 * Get PDF metadata and page count using pdfinfo (poppler).
 */
export function getPdfInfo(filePath: string): { title: string; author: string; pageCount: number } {
  let output: string;
  try {
    output = execFileSync('pdfinfo', [filePath], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    throw new Error('Failed to run pdfinfo. Make sure poppler is installed (brew install poppler).');
  }

  const lines = output.split('\n');
  const info: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      info[key] = value;
    }
  }

  return {
    title: info['Title'] || '',
    author: info['Author'] || '',
    pageCount: parseInt(info['Pages'] || '0', 10),
  };
}

/**
 * Render a single PDF page to a PNG buffer.
 * Uses pdftoppm (poppler) to render at the specified DPI.
 *
 * @param filePath - Path to the PDF file
 * @param pageNum - 1-based page number
 * @param dpi - Rendering DPI (default: 200)
 * @returns PNG image buffer
 */
export function renderPdfPage(filePath: string, pageNum: number, dpi: number = DEFAULT_DPI): Buffer {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-translate-pdf-'));
  try {
    execFileSync('pdftoppm', [
      '-png',
      '-r', String(dpi),
      '-f', String(pageNum),
      '-l', String(pageNum),
      filePath,
      path.join(tmpDir, 'page'),
    ], { stdio: ['pipe', 'ignore', 'ignore'] });

    // Find the generated PNG file
    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.png'));
    if (files.length === 0) {
      throw new Error(`Failed to render page ${pageNum}: no PNG generated (pdftoppm produced no files)`);
    }
    const pngPath = path.join(tmpDir, files[0]);
    const buffer = fs.readFileSync(pngPath);
    return buffer;
  } catch (err: any) {
    console.error(`[pdf-render] Failed to render page ${pageNum} from ${filePath}: ${err.message}`);
    throw err;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export interface PdfParserOptions {
  /** API base URL for the OCR model */
  ollamaUrl?: string;
  /** OCR model name (default: from OCR_MODEL env var) */
  ocrModel?: string;
  /** API key for authentication */
  apiKey?: string;
  /** DPI for page rendering (default: 200) */
  dpi?: number;
  /** Maximum pages to process (0 = all) */
  maxPages?: number;
}

export class PdfParser {
  private filePath: string;
  private ocrClient: OcrClient;
  private dpi: number;
  private maxPages: number;

  constructor(filePath: string, options: PdfParserOptions = {}) {
    this.filePath = filePath;
    this.ocrClient = new OcrClient({
      baseUrl: options.ollamaUrl || OLLAMA_DEFAULT_URL,
      model: options.ocrModel || DEFAULT_OCR_MODEL,
      apiKey: options.apiKey || DEFAULT_API_KEY,
    });
    this.dpi = options.dpi || DEFAULT_DPI;
    this.maxPages = options.maxPages || 0;
  }

  /**
   * Parse the PDF file into a ParsedEpub structure.
   * Each page becomes a ContentDoc with OCR-extracted text.
   *
   * @param onProgress - Optional callback: (currentPage, totalPages) => void
   */
  async parse(onProgress?: (current: number, total: number) => void): Promise<ParsedEpub> {
    // ── Step 1: Get PDF metadata and page count ───────────────
    const meta = this.getPdfInfo();
    const totalPages = this.maxPages > 0 ? Math.min(this.maxPages, meta.pageCount) : meta.pageCount;

    // ── Step 2: Render pages to images and OCR ────────────────
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-translate-pdf-'));
    const contentDocs: ContentDoc[] = [];

    try {
      for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        if (onProgress) onProgress(pageNum, totalPages);

        // Render page to PNG
        execFileSync('pdftoppm', [
          '-png',
          '-r', String(this.dpi),
          '-f', String(pageNum),
          '-l', String(pageNum),
          this.filePath,
          path.join(tmpDir, 'page'),
        ], { stdio: ['pipe', 'ignore', 'ignore'] });

        // pdftoppm names files as page-NN.png (zero-padded to 2 digits by default)
        // But with -f/-l it uses the actual page number. Find the generated file.
        const generatedFile = this.findGeneratedPng(tmpDir, pageNum);
        if (!generatedFile) {
          throw new Error(`Failed to render page ${pageNum}: no PNG generated`);
        }

        const imgBuffer = fs.readFileSync(generatedFile);

        // OCR the page
        const markdown = await this.ocrClient.extractPage(imgBuffer, 'image/png', pageNum);

        // Convert markdown → HTML for ContentDoc
        const html = markdownToHtml(markdown);
        const dom = parseHtml(html, { comment: true, voidTag: { closingSlash: true } });

        const docPath = `page-${String(pageNum).padStart(4, '0')}.xhtml`;
        contentDocs.push({
          path: docPath,
          dom,
          rawContent: html,
          sectionTitle: `Page ${pageNum}`,
        });

        // Clean up the image file to save disk space
        fs.unlinkSync(generatedFile);
      }
    } finally {
      // Clean up temp directory
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // ── Step 3: Build metadata ────────────────────────────────
    const metadata: BookMetadata = {
      title: meta.title || path.basename(this.filePath, '.pdf'),
      author: meta.author || '',
      language: 'en', // Default; OCR may detect, but we use 'en' as fallback
      format: 'pdf',
    };

    return {
      metadata,
      contentDocs,
      images: [] as ExtractedImage[], // PDF images are not extracted separately — they're OCR'd as part of pages
    };
  }

  /**
   * Get PDF metadata and page count using pdfinfo (poppler).
   */
  private getPdfInfo(): { title: string; author: string; pageCount: number } {
    return getPdfInfo(this.filePath);
  }

  /**
   * Find the PNG file generated by pdftoppm for a specific page.
   * (kept for backward compat with the parse() method above)
   */
  private findGeneratedPng(dir: string, pageNum: number): string | null {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.png'));
    // Look for file containing the page number
    const padded2 = String(pageNum).padStart(2, '0');
    const padded4 = String(pageNum).padStart(4, '0');

    // Try exact matches first
    for (const f of files) {
      if (f === `page-${padded2}.png` || f === `page-${padded4}.png` || f === `page-${pageNum}.png`) {
        return path.join(dir, f);
      }
    }
    // Fallback: find any PNG that contains the page number
    for (const f of files) {
      if (f.includes(`-${padded2}.png`) || f.includes(`-${padded4}.png`)) {
        return path.join(dir, f);
      }
    }
    // Last resort: return first PNG
    if (files.length > 0) return path.join(dir, files[0]);
    return null;
  }
}

/**
 * Convert Markdown text to HTML for use in a ContentDoc.
 * Uses a simple Markdown-to-HTML conversion (paragraphs, headings, lists).
 * The block-extractor will then convert this HTML back to Markdown blocks via Turndown,
 * ensuring consistency with the EPUB/FB2 pipeline.
 */
export function markdownToHtml(markdown: string): string {
  if (!markdown.trim()) {
    return '<body></body>';
  }

  const lines = markdown.split('\n');
  const htmlParts: string[] = [];
  let inList = false;
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let paragraphLines: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length > 0) {
      const text = paragraphLines.join(' ').trim();
      if (text) {
        htmlParts.push(`<p>${escapeHtml(text)}</p>`);
      }
      paragraphLines = [];
    }
  };

  const closeList = () => {
    if (inList) {
      htmlParts.push('</ul>');
      inList = false;
    }
  };

  for (const line of lines) {
    // Code block fencing
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        htmlParts.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = [];
        inCodeBlock = false;
      } else {
        flushParagraph();
        closeList();
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      closeList();
      const level = headingMatch[1].length;
      htmlParts.push(`<h${level}>${escapeHtml(headingMatch[2].trim())}</h${level}>`);
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      flushParagraph();
      closeList();
      htmlParts.push(`<blockquote>${escapeHtml(line.slice(2).trim())}</blockquote>`);
      continue;
    }

    // List item
    const listMatch = line.match(/^[-*]\s+(.+)$/);
    if (listMatch) {
      flushParagraph();
      if (!inList) {
        htmlParts.push('<ul>');
        inList = true;
      }
      htmlParts.push(`<li>${escapeHtml(listMatch[1].trim())}</li>`);
      continue;
    }

    // Numbered list item
    const numListMatch = line.match(/^\d+\.\s+(.+)$/);
    if (numListMatch) {
      flushParagraph();
      if (!inList) {
        htmlParts.push('<ul>');
        inList = true;
      }
      htmlParts.push(`<li>${escapeHtml(numListMatch[1].trim())}</li>`);
      continue;
    }

    // Empty line — paragraph break
    if (line.trim() === '') {
      flushParagraph();
      closeList();
      continue;
    }

    // Regular text — accumulate into paragraph
    paragraphLines.push(line);
  }

  // Flush remaining
  if (inCodeBlock) {
    htmlParts.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  }
  flushParagraph();
  closeList();

  return `<body>\n${htmlParts.join('\n')}\n</body>`;
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
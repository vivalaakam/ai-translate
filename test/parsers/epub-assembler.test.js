import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { assembleEpub } from '../../src/parsers/epub-assembler.js';
import { TranslateDb, generateFileId } from '../../src/db/database.js';
import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import os from 'os';

const TEST_DB_URL = process.env.DATABASE_URL;

let tmpDir;
let db;
let bookId;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-translate-assembler-'));
  db = new TranslateDb(TEST_DB_URL);
  await db.migrate();

  // Clean any leftover assembler test data
  await db.raw.query(`DELETE FROM blocks WHERE book_id IN ('test-book-assembler','test-book-pagebreak','test-book-images')`);
  await db.raw.query(`DELETE FROM files WHERE book_id IN ('test-book-assembler','test-book-pagebreak','test-book-images')`);
  await db.raw.query(`DELETE FROM books WHERE id IN ('test-book-assembler','test-book-pagebreak','test-book-images')`);

  // Create a book with some blocks
  bookId = 'test-book-assembler';
  await db.insertBook({
    id: bookId,
    title: 'Assembler Test Book',
    author: 'Test Author',
    language: 'en',
    filename: 'test.epub',
    totalBlocks: 4,
  });

  const blockH1 = {
    id: 'block-h1',
    bookId,
    index: 0,
    docPath: 'chapter1.xhtml',
    type: 'heading',
    content: '# Chapter One',
    lang: 'en',
    model: null,
    sourceId: null,
    fileId: null,
    tagName: 'h1',
    attributes: '{}',
  };
  const blockP1 = {
    id: 'block-p1',
    bookId,
    index: 1,
    docPath: 'chapter1.xhtml',
    type: 'paragraph',
    content: 'Hello world, this is a test paragraph.',
    lang: 'en',
    model: null,
    sourceId: null,
    fileId: null,
    tagName: 'p',
    attributes: '{}',
  };
  const blockH2 = {
    id: 'block-h2',
    bookId,
    index: 2,
    docPath: 'chapter2.xhtml',
    type: 'heading',
    content: '## Chapter Two',
    lang: 'en',
    model: null,
    sourceId: null,
    fileId: null,
    tagName: 'h2',
    attributes: '{}',
  };
  const blockP2 = {
    id: 'block-p2',
    bookId,
    index: 3,
    docPath: 'chapter2.xhtml',
    type: 'paragraph',
    content: 'Second chapter content.',
    lang: 'en',
    model: null,
    sourceId: null,
    fileId: null,
    tagName: 'p',
    attributes: '{}',
  };

  await db.insertBlocks([blockH1, blockP1, blockH2, blockP2]);

  // Set book translation config so translated mode knows target lang + model
  await db.setBookTranslationConfig(bookId, 'es', 'en', 'test-model');

  // Add a translation for block-p1 only (the paragraph)
  await db.upsertTranslation(blockP1, 'Hola mundo, este es un párrafo de prueba.', 'es', 'test-model');
});

afterAll(async () => {
  await db.raw.query(`DELETE FROM blocks WHERE book_id IN ('test-book-assembler','test-book-pagebreak','test-book-images')`);
  await db.raw.query(`DELETE FROM files WHERE book_id IN ('test-book-assembler','test-book-pagebreak','test-book-images')`);
  await db.raw.query(`DELETE FROM books WHERE id IN ('test-book-assembler','test-book-pagebreak','test-book-images')`);
  await db.close();
  await TranslateDb.closePool();
  fs.rmSync(tmpDir, { recursive: true });
});

describe('assembleEpub', () => {
  it('should create a valid EPUB file (original mode)', async () => {
    const outputPath = path.join(tmpDir, 'test_exported.epub');
    await assembleEpub(bookId, db, outputPath, { mode: 'original' });

    expect(fs.existsSync(outputPath)).toBe(true);

    const zip = new AdmZip(outputPath);
    const entries = zip.getEntries().map((e) => e.entryName);

    // Check EPUB structure
    expect(entries).toContain('mimetype');
    expect(entries).toContain('META-INF/container.xml');
    expect(entries).toContain('OEBPS/content.opf');
    expect(entries).toContain('OEBPS/nav.xhtml');
    expect(entries).toContain('OEBPS/styles.css');
    expect(entries).toContain('OEBPS/chapter_0.xhtml');
    expect(entries).toContain('OEBPS/chapter_1.xhtml');

    // Check mimetype exists and has correct content
    const mimetypeEntry = zip.getEntries().find((e) => e.entryName === 'mimetype');
    expect(mimetypeEntry).toBeDefined();
    expect(zip.readAsText('mimetype')).toBe('application/epub+zip');

    // Check content — original mode should use content (not translation)
    const ch0 = zip.readAsText('OEBPS/chapter_0.xhtml');
    expect(ch0).toContain('Chapter One');
    expect(ch0).toContain('Hello world');
    expect(ch0).not.toContain('Hola mundo');
  });

  it('should create a valid EPUB file (translated mode)', async () => {
    const outputPath = path.join(tmpDir, 'test_translated.epub');
    await assembleEpub(bookId, db, outputPath, { mode: 'translated' });

    expect(fs.existsSync(outputPath)).toBe(true);

    const zip = new AdmZip(outputPath);

    // Check content — translated mode should use translatedContent where available
    const ch0 = zip.readAsText('OEBPS/chapter_0.xhtml');
    expect(ch0).toContain('Chapter One'); // heading has no translation, uses original
    expect(ch0).toContain('Hola mundo'); // paragraph has translation

    // Chapter 2 — no translations, should use original
    const ch1 = zip.readAsText('OEBPS/chapter_1.xhtml');
    expect(ch1).toContain('Chapter Two');
    expect(ch1).toContain('Second chapter content');
  });

  it('should include page break blocks in assembled EPUB', async () => {
    const pbBookId = 'test-book-pagebreak';
    await db.insertBook({
      id: pbBookId,
      title: 'Page Break Book',
      author: 'Test',
      language: 'en',
      filename: 'pb.epub',
      totalBlocks: 3,
    });

    await db.insertBlocks([
      {
        id: 'pb-h1',
        bookId: pbBookId,
        index: 0,
        docPath: 'ch1.xhtml',
        type: 'heading',
        content: '# Title',
        lang: 'en',
        model: null,
        sourceId: null,
        fileId: null,
        tagName: 'h1',
        attributes: '{}',
      },
      {
        id: 'pb-break',
        bookId: pbBookId,
        index: 1,
        docPath: 'ch1.xhtml',
        type: 'page_break',
        content: '---',
        lang: 'en',
        model: null,
        sourceId: null,
        fileId: null,
        tagName: 'hr',
        attributes: '{}',
      },
      {
        id: 'pb-p1',
        bookId: pbBookId,
        index: 2,
        docPath: 'ch1.xhtml',
        type: 'paragraph',
        content: 'After the break.',
        lang: 'en',
        model: null,
        sourceId: null,
        fileId: null,
        tagName: 'p',
        attributes: '{}',
      },
    ]);

    const outputPath = path.join(tmpDir, 'test_pagebreak.epub');
    await assembleEpub(pbBookId, db, outputPath, { mode: 'original' });

    const zip = new AdmZip(outputPath);
    const ch0 = zip.readAsText('OEBPS/chapter_0.xhtml');
    expect(ch0).toContain('page-break-before:always');
    expect(ch0).toContain('After the break');

    // Cleanup
    await db.deleteBook(pbBookId);
  });

  it('should include images in assembled EPUB', async () => {
    const imgBookId = 'test-book-images';
    const imageData = Buffer.from('fake-image-data-for-test');
    const fileId = generateFileId(imageData);

    await db.insertBook({
      id: imgBookId,
      title: 'Image Book',
      author: 'Test',
      language: 'en',
      filename: 'img.epub',
      totalBlocks: 2,
    });

    await db.insertFile({
      id: fileId,
      bookId: imgBookId,
      originalPath: 'OEBPS/images/test.jpg',
      mimeType: 'image/jpeg',
      data: imageData,
      createdAt: new Date().toISOString(),
    });

    await db.insertBlocks([
      {
        id: 'img-h1',
        bookId: imgBookId,
        index: 0,
        docPath: 'ch1.xhtml',
        type: 'heading',
        content: '# Image Chapter',
        lang: 'en',
        model: null,
        sourceId: null,
        fileId: null,
        tagName: 'h1',
        attributes: '{}',
      },
      {
        id: 'img-block',
        bookId: imgBookId,
        index: 1,
        docPath: 'ch1.xhtml',
        type: 'image',
        content: `![Alt text](file:${fileId})`,
        lang: 'en',
        model: null,
        sourceId: null,
        fileId: fileId,
        tagName: 'img',
        attributes: '{}',
      },
    ]);

    const outputPath = path.join(tmpDir, 'test_images.epub');
    await assembleEpub(imgBookId, db, outputPath, { mode: 'original' });

    const zip = new AdmZip(outputPath);
    const entries = zip.getEntries().map((e) => e.entryName);

    // Image should be in the EPUB
    const imageEntry = entries.find((e) => e.includes(fileId));
    expect(imageEntry).toBeDefined();

    // Content doc should reference the image with EPUB-relative path
    const ch0 = zip.readAsText('OEBPS/chapter_0.xhtml');
    expect(ch0).toContain(`images/${fileId}.jpg`);

    // Cleanup
    await db.deleteBook(imgBookId);
  });

  it('should throw for nonexistent book', async () => {
    await expect(
      assembleEpub('nonexistent-book', db, path.join(tmpDir, 'nope.epub')),
    ).rejects.toThrow('Book not found');
  });
});
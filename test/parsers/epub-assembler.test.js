import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { assembleEpub } from '../../src/parsers/epub-assembler.js';
import { TranslateDb, generateFileId } from '../../src/db/database.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import AdmZip from 'adm-zip';

let tmpDir;
let db;
let bookId;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-translate-assembler-'));
  db = new TranslateDb(path.join(tmpDir, 'test.db'));

  // Create a book with some blocks
  bookId = 'test-book-assembler';
  db.insertBook({
    id: bookId,
    title: 'Assembler Test Book',
    author: 'Test Author',
    language: 'en',
    filename: 'test.epub',
    totalBlocks: 4,
  });

  db.insertBlocks([
    {
      id: 'block-h1',
      bookId,
      index: 0,
      docPath: 'chapter1.xhtml',
      type: 'heading',
      originalMd: '# Chapter One',
      translatedMd: null,
      fileId: null,
      tagName: 'h1',
      attributes: '{}',
    },
    {
      id: 'block-p1',
      bookId,
      index: 1,
      docPath: 'chapter1.xhtml',
      type: 'paragraph',
      originalMd: 'Hello world, this is a test paragraph.',
      translatedMd: 'Hola mundo, este es un párrafo de prueba.',
      fileId: null,
      tagName: 'p',
      attributes: '{}',
    },
    {
      id: 'block-h2',
      bookId,
      index: 2,
      docPath: 'chapter2.xhtml',
      type: 'heading',
      originalMd: '## Chapter Two',
      translatedMd: null,
      fileId: null,
      tagName: 'h2',
      attributes: '{}',
    },
    {
      id: 'block-p2',
      bookId,
      index: 3,
      docPath: 'chapter2.xhtml',
      type: 'paragraph',
      originalMd: 'Second chapter content.',
      translatedMd: null,
      fileId: null,
      tagName: 'p',
      attributes: '{}',
    },
  ]);
});

afterAll(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true });
});

describe('assembleEpub', () => {
  it('should create a valid EPUB file (original mode)', () => {
    const outputPath = path.join(tmpDir, 'test_original.epub');
    assembleEpub(bookId, db, outputPath, { mode: 'original' });

    expect(fs.existsSync(outputPath)).toBe(true);

    const zip = new AdmZip(outputPath);
    const entries = zip.getEntries().map(e => e.entryName);

    // Check EPUB structure
    expect(entries).toContain('mimetype');
    expect(entries).toContain('META-INF/container.xml');
    expect(entries).toContain('OEBPS/content.opf');
    expect(entries).toContain('OEBPS/nav.xhtml');
    expect(entries).toContain('OEBPS/styles.css');
    expect(entries).toContain('OEBPS/chapter_0.xhtml');
    expect(entries).toContain('OEBPS/chapter_1.xhtml');

    // Check mimetype exists and has correct content
    const mimetypeEntry = zip.getEntries().find(e => e.entryName === 'mimetype');
    expect(mimetypeEntry).toBeDefined();
    expect(zip.readAsText('mimetype')).toBe('application/epub+zip');

    // Check content — original mode should use originalMd
    const ch0 = zip.readAsText('OEBPS/chapter_0.xhtml');
    expect(ch0).toContain('Chapter One');
    expect(ch0).toContain('Hello world');
    expect(ch0).not.toContain('Hola mundo');
  });

  it('should create a valid EPUB file (translated mode)', () => {
    const outputPath = path.join(tmpDir, 'test_translated.epub');
    assembleEpub(bookId, db, outputPath, { mode: 'translated' });

    expect(fs.existsSync(outputPath)).toBe(true);

    const zip = new AdmZip(outputPath);

    // Check content — translated mode should use translatedMd where available
    const ch0 = zip.readAsText('OEBPS/chapter_0.xhtml');
    expect(ch0).toContain('Chapter One'); // heading has no translation, uses original
    expect(ch0).toContain('Hola mundo'); // paragraph has translation

    // Chapter 2 — no translations, should use original
    const ch1 = zip.readAsText('OEBPS/chapter_1.xhtml');
    expect(ch1).toContain('Chapter Two');
    expect(ch1).toContain('Second chapter content');
  });

  it('should include page break blocks in assembled EPUB', () => {
    const pbBookId = 'test-book-pagebreak';
    db.insertBook({
      id: pbBookId,
      title: 'Page Break Book',
      author: 'Test',
      language: 'en',
      filename: 'pb.epub',
      totalBlocks: 3,
    });

    db.insertBlocks([
      {
        id: 'pb-h1',
        bookId: pbBookId,
        index: 0,
        docPath: 'ch1.xhtml',
        type: 'heading',
        originalMd: '# Title',
        translatedMd: null,
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
        originalMd: '---',
        translatedMd: null,
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
        originalMd: 'After the break.',
        translatedMd: null,
        fileId: null,
        tagName: 'p',
        attributes: '{}',
      },
    ]);

    const outputPath = path.join(tmpDir, 'test_pagebreak.epub');
    assembleEpub(pbBookId, db, outputPath, { mode: 'original' });

    const zip = new AdmZip(outputPath);
    const ch0 = zip.readAsText('OEBPS/chapter_0.xhtml');
    expect(ch0).toContain('page-break-before:always');
    expect(ch0).toContain('After the break');

    // Cleanup
    db.deleteBook(pbBookId);
  });

  it('should include images in assembled EPUB', () => {
    const imgBookId = 'test-book-images';
    const imageData = Buffer.from('fake-image-data-for-test');
    const fileId = generateFileId(imageData);

    db.insertBook({
      id: imgBookId,
      title: 'Image Book',
      author: 'Test',
      language: 'en',
      filename: 'img.epub',
      totalBlocks: 2,
    });

    db.insertFile({
      id: fileId,
      bookId: imgBookId,
      originalPath: 'OEBPS/images/test.jpg',
      mimeType: 'image/jpeg',
      data: imageData,
      createdAt: new Date().toISOString(),
    });

    db.insertBlocks([
      {
        id: 'img-h1',
        bookId: imgBookId,
        index: 0,
        docPath: 'ch1.xhtml',
        type: 'heading',
        originalMd: '# Image Chapter',
        translatedMd: null,
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
        originalMd: `![Alt text](file:${fileId})`,
        translatedMd: null,
        fileId: fileId,
        tagName: 'img',
        attributes: '{}',
      },
    ]);

    const outputPath = path.join(tmpDir, 'test_images.epub');
    assembleEpub(imgBookId, db, outputPath, { mode: 'original' });

    const zip = new AdmZip(outputPath);
    const entries = zip.getEntries().map(e => e.entryName);

    // Image should be in the EPUB
    const imageEntry = entries.find(e => e.includes(fileId));
    expect(imageEntry).toBeDefined();

    // Content doc should reference the image with EPUB-relative path
    const ch0 = zip.readAsText('OEBPS/chapter_0.xhtml');
    expect(ch0).toContain(`images/${fileId}.jpg`);

    // Cleanup
    db.deleteBook(imgBookId);
  });

  it('should throw for nonexistent book', () => {
    expect(() => {
      assembleEpub('nonexistent-book', db, path.join(tmpDir, 'nope.epub'));
    }).toThrow('Book not found');
  });
});
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TranslateDb, generateBookId, generateBlockId, generateFileId } from '../../src/db/database.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir;
let db;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-translate-test-'));
  db = new TranslateDb(path.join(tmpDir, 'test.db'));
});

afterAll(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true });
});

describe('TranslateDb', () => {
  it('should create tables on init', () => {
    const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const names = tables.map(t => t.name);
    expect(names).toContain('books');
    expect(names).toContain('blocks');
    expect(names).toContain('files');
  });

  it('should insert and retrieve a book', () => {
    db.insertBook({
      id: 'book-1',
      title: 'Test Book',
      author: 'Author',
      language: 'en',
      filename: 'test.epub',
      totalBlocks: 10,
    });
    const book = db.getBook('book-1');
    expect(book).toBeDefined();
    expect(book.title).toBe('Test Book');
    expect(book.totalBlocks).toBe(10);
    expect(book.translatedBlocks).toBe(0);
  });

  it('should update book progress', () => {
    db.updateBookProgress('book-1', 5);
    const book = db.getBook('book-1');
    expect(book.translatedBlocks).toBe(5);
  });

  it('should set book translation config', () => {
    db.setBookTranslationConfig('book-1', 'es', 'en', 'llama3.1');
    const book = db.getBook('book-1');
    expect(book.targetLang).toBe('es');
    expect(book.sourceLang).toBe('en');
    expect(book.model).toBe('llama3.1');
  });

  it('should complete a book', () => {
    db.completeBook('book-1');
    const book = db.getBook('book-1');
    expect(book.completedAt).not.toBeNull();
    expect(book.translatedBlocks).toBe(book.totalBlocks);
  });

  it('should insert and retrieve blocks', () => {
    db.insertBlocks([
      {
        id: 'block-1',
        bookId: 'book-1',
        index: 0,
        docPath: 'OEBPS/chapter1.xhtml',
        type: 'paragraph',
        originalMd: 'Hello world',
        translatedMd: null,
        fileId: null,
        tagName: 'p',
        attributes: '{}',
      },
      {
        id: 'block-2',
        bookId: 'book-1',
        index: 1,
        docPath: 'OEBPS/chapter1.xhtml',
        type: 'heading',
        originalMd: '## Chapter 1',
        translatedMd: null,
        fileId: null,
        tagName: 'h2',
        attributes: '{}',
      },
    ]);

    const blocks = db.getBlocksByBook('book-1');
    expect(blocks.length).toBe(2);
    expect(blocks[0].originalMd).toBe('Hello world');
    expect(blocks[1].type).toBe('heading');
  });

  it('should update block translation', () => {
    db.updateBlockTranslation('block-1', 'Hola mundo');
    const blocks = db.getBlocksByBook('book-1');
    const b1 = blocks.find(b => b.id === 'block-1');
    expect(b1.translatedMd).toBe('Hola mundo');
  });

  it('should get untranslated blocks', () => {
    const untranslated = db.getUntranslatedBlocks('book-1');
    expect(untranslated.length).toBe(1);
    expect(untranslated[0].id).toBe('block-2');
  });

  it('should get blocks by doc path', () => {
    const blocks = db.getBlocksByDoc('book-1', 'OEBPS/chapter1.xhtml');
    expect(blocks.length).toBe(2);
  });

  it('should count blocks', () => {
    const counts = db.countBlocks('book-1');
    expect(counts.total).toBe(2);
    expect(counts.translated).toBe(1);
  });

  it('should get doc paths', () => {
    const paths = db.getDocPaths('book-1');
    expect(paths).toContain('OEBPS/chapter1.xhtml');
  });

  it('should delete a book and its blocks and files', () => {
    db.deleteBook('book-1');
    expect(db.getBook('book-1')).toBeUndefined();
    expect(db.getBlocksByBook('book-1').length).toBe(0);
    expect(db.getFilesByBook('book-1').length).toBe(0);
  });

  it('should list books', () => {
    db.insertBook({
      id: 'book-2',
      title: 'Second Book',
      author: 'Writer',
      language: 'de',
      filename: 'second.epub',
      totalBlocks: 5,
    });
    const books = db.listBooks();
    expect(books.length).toBeGreaterThan(0);
  });
});

describe('FileRecord CRUD', () => {
  let fileDb;
  let fileTmpDir;

  beforeAll(() => {
    fileTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-translate-files-'));
    fileDb = new TranslateDb(path.join(fileTmpDir, 'files-test.db'));
    fileDb.insertBook({
      id: 'book-files',
      title: 'Files Test Book',
      author: 'Test',
      language: 'en',
      filename: 'images.epub',
      totalBlocks: 1,
    });
  });

  afterAll(() => {
    fileDb.close();
    fs.rmSync(fileTmpDir, { recursive: true });
  });

  it('should insert and retrieve a file', () => {
    const imageData = Buffer.from('fake-image-data');
    const fileId = generateFileId(imageData);

    fileDb.insertFile({
      id: fileId,
      bookId: 'book-files',
      originalPath: 'OEBPS/images/photo.jpg',
      mimeType: 'image/jpeg',
      data: imageData,
      createdAt: new Date().toISOString(),
    });

    const file = fileDb.getFile(fileId);
    expect(file).toBeDefined();
    expect(file.id).toBe(fileId);
    expect(file.originalPath).toBe('OEBPS/images/photo.jpg');
    expect(file.mimeType).toBe('image/jpeg');
    expect(file.data).toBeInstanceOf(Buffer);
    expect(file.data.length).toBe(imageData.length);
  });

  it('should get file by path', () => {
    const imageData = Buffer.from('another-image');
    const fileId = generateFileId(imageData);

    fileDb.insertFile({
      id: fileId,
      bookId: 'book-files',
      originalPath: 'OEBPS/images/cover.png',
      mimeType: 'image/png',
      data: imageData,
      createdAt: new Date().toISOString(),
    });

    const file = fileDb.getFileByPath('book-files', 'OEBPS/images/cover.png');
    expect(file).toBeDefined();
    expect(file.mimeType).toBe('image/png');
  });

  it('should get all files for a book', () => {
    const files = fileDb.getFilesByBook('book-files');
    expect(files.length).toBe(2);
  });

  it('should insert multiple files at once', () => {
    const files = [
      {
        id: generateFileId(Buffer.from('img-data-1')),
        bookId: 'book-files',
        originalPath: 'OEBPS/images/batch1.jpg',
        mimeType: 'image/jpeg',
        data: Buffer.from('img-data-1'),
        createdAt: new Date().toISOString(),
      },
      {
        id: generateFileId(Buffer.from('img-data-2')),
        bookId: 'book-files',
        originalPath: 'OEBPS/images/batch2.png',
        mimeType: 'image/png',
        data: Buffer.from('img-data-2'),
        createdAt: new Date().toISOString(),
      },
    ];

    fileDb.insertFiles(files);
    const allFiles = fileDb.getFilesByBook('book-files');
    expect(allFiles.length).toBe(4); // 2 from before + 2 new
  });

  it('should generate deterministic file IDs from content hash', () => {
    const data = Buffer.from('deterministic-content');
    const id1 = generateFileId(data);
    const id2 = generateFileId(data);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('should generate different file IDs for different content', () => {
    const id1 = generateFileId(Buffer.from('content A'));
    const id2 = generateFileId(Buffer.from('content B'));
    expect(id1).not.toBe(id2);
  });

  it('should support blocks with fileId references', () => {
    const imageData = Buffer.from('block-image-data');
    const fileId = generateFileId(imageData);

    fileDb.insertFile({
      id: fileId,
      bookId: 'book-files',
      originalPath: 'OEBPS/images/inline.jpg',
      mimeType: 'image/jpeg',
      data: imageData,
      createdAt: new Date().toISOString(),
    });

    fileDb.insertBlocks([{
      id: 'block-img-1',
      bookId: 'book-files',
      index: 99,
      docPath: 'OEBPS/chapter2.xhtml',
      type: 'image',
      originalMd: '![Photo](file:' + fileId + ')',
      translatedMd: null,
      fileId: fileId,
      tagName: 'img',
      attributes: '{"src": "file:' + fileId + '"}',
    }]);

    const blocks = fileDb.getBlocksByBook('book-files');
    const imgBlock = blocks.find(b => b.id === 'block-img-1');
    expect(imgBlock).toBeDefined();
    expect(imgBlock.fileId).toBe(fileId);
    expect(imgBlock.type).toBe('image');
    expect(imgBlock.originalMd).toContain('file:' + fileId);
  });
});

describe('generateBookId', () => {
  it('should produce deterministic UUID v5 from file contents', () => {
    const buf = Buffer.from('test file contents');
    const id1 = generateBookId(buf);
    const id2 = generateBookId(buf);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('should produce different IDs for different files', () => {
    const id1 = generateBookId(Buffer.from('file A'));
    const id2 = generateBookId(Buffer.from('file B'));
    expect(id1).not.toBe(id2);
  });
});

describe('generateBlockId', () => {
  it('should produce deterministic UUID v5 from book+text', () => {
    const id1 = generateBlockId('book-1', 'Hello world');
    const id2 = generateBlockId('book-1', 'Hello world');
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('should produce different IDs for different texts', () => {
    const id1 = generateBlockId('book-1', 'Hello');
    const id2 = generateBlockId('book-1', 'World');
    expect(id1).not.toBe(id2);
  });
});
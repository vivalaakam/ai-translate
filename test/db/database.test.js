import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TranslateDb, generateBookId, generateBlockId } from '../../src/db/database.js';
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
        imageBase64: null,
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
        imageBase64: null,
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

  it('should delete a book and its blocks', () => {
    db.deleteBook('book-1');
    expect(db.getBook('book-1')).toBeUndefined();
    expect(db.getBlocksByBook('book-1').length).toBe(0);
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
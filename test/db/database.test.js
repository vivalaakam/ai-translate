import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { TranslateDb, generateBookId, generateBlockId, generateFileId } from '../../src/db/database.js';

// All DB methods are async (PostgreSQL via pg). We use the real DATABASE_URL
// (loaded by test/setup.js) and clean up data between tests for isolation.
const TEST_DB_URL = process.env.DATABASE_URL;

let db;

beforeAll(async () => {
  db = new TranslateDb(TEST_DB_URL);
  await db.migrate();
});

afterAll(async () => {
  // Clean up any leftover test data, then close.
  await db.sequelize.query(`DELETE FROM tasks WHERE doc_id LIKE 'test-%' OR doc_id LIKE 'book-%'`);
  await db.sequelize.query(`DELETE FROM blocks WHERE book_id LIKE 'test-%' OR book_id LIKE 'book-%'`);
  await db.sequelize.query(`DELETE FROM files WHERE book_id LIKE 'test-%' OR book_id LIKE 'book-%'`);
  await db.sequelize.query(`DELETE FROM docs WHERE id LIKE 'test-%' OR id LIKE 'book-%'`);
  await db.close();
  await TranslateDb.closePool();
});

// Helper to clean all test-related rows before each test for isolation
async function cleanup() {
  await db.sequelize.query(`DELETE FROM tasks WHERE doc_id LIKE 'test-%' OR doc_id LIKE 'book-%'`);
  await db.sequelize.query(`DELETE FROM blocks WHERE book_id LIKE 'test-%' OR book_id LIKE 'book-%'`);
  await db.sequelize.query(`DELETE FROM files WHERE book_id LIKE 'test-%' OR book_id LIKE 'book-%'`);
  await db.sequelize.query(`DELETE FROM docs WHERE id LIKE 'test-%' OR id LIKE 'book-%'`);
}

describe('TranslateDb', () => {
  beforeEach(cleanup);

  it('should create tables on migrate', async () => {
    // After migrate() the tables must exist. Query pg_catalog.
    const [rows] = await db.sequelize.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const names = rows.map((r) => r.tablename);
    expect(names).toContain('docs');
    expect(names).toContain('blocks');
    expect(names).toContain('files');
    expect(names).toContain('tasks');
  });

  it('should insert and retrieve a book', async () => {
    await db.insertBook({
      id: 'book-1',
      title: 'Test Book',
      author: 'Author',
      language: 'en',
      filename: 'test.epub',
      totalBlocks: 10,
    });
    const book = await db.getBook('book-1');
    expect(book).toBeDefined();
    expect(book.title).toBe('Test Book');
    expect(book.totalBlocks).toBe(10);
    expect(book.translatedBlocks).toBe(0);
  });

  it('should store and retrieve source_path', async () => {
    await db.insertBook({
      id: 'book-src-1',
      title: 'PDF Book',
      author: 'Author',
      language: 'en',
      filename: 'doc.pdf',
      totalBlocks: 0,
      sourcePath: '/uploads/12345-abc.pdf',
    });
    const book = await db.getBook('book-src-1');
    expect(book).toBeDefined();
    expect(book.sourcePath).toBe('/uploads/12345-abc.pdf');
  });

  it('should default source_path to null when not provided', async () => {
    await db.insertBook({
      id: 'book-src-2',
      title: 'EPUB Book',
      author: 'Author',
      language: 'en',
      filename: 'book.epub',
      totalBlocks: 5,
    });
    const book = await db.getBook('book-src-2');
    expect(book).toBeDefined();
    expect(book.sourcePath).toBeNull();
  });

  it('should update book progress', async () => {
    await db.insertBook({
      id: 'book-1',
      title: 'Test Book',
      author: 'Author',
      language: 'en',
      filename: 'test.epub',
      totalBlocks: 10,
    });
    await db.updateBookProgress('book-1', 5);
    const book = await db.getBook('book-1');
    expect(book.translatedBlocks).toBe(5);
  });

  it('should set book translation config', async () => {
    await db.insertBook({
      id: 'book-1',
      title: 'Test Book',
      author: 'Author',
      language: 'en',
      filename: 'test.epub',
      totalBlocks: 10,
    });
    await db.setBookTranslationConfig('book-1', 'es', 'en', 'llama3.1');
    const book = await db.getBook('book-1');
    expect(book.targetLang).toBe('es');
    expect(book.sourceLang).toBe('en');
    expect(book.model).toBe('llama3.1');
  });

  it('should complete a book', async () => {
    await db.insertBook({
      id: 'book-1',
      title: 'Test Book',
      author: 'Author',
      language: 'en',
      filename: 'test.epub',
      totalBlocks: 10,
    });
    await db.completeBook('book-1');
    const book = await db.getBook('book-1');
    expect(book.completedAt).not.toBeNull();
    expect(book.translatedBlocks).toBe(book.totalBlocks);
  });

  it('should insert and retrieve blocks', async () => {
    await db.insertBook({
      id: 'book-1',
      title: 'Test Book',
      author: 'Author',
      language: 'en',
      filename: 'test.epub',
      totalBlocks: 10,
    });
    await db.insertBlocks([
      {
        id: 'block-1',
        bookId: 'book-1',
        index: 0,
        docPath: 'OEBPS/chapter1.xhtml',
        type: 'paragraph',
        content: 'Hello world',
        lang: 'en',
        model: null,
        sourceId: null,
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
        content: '## Chapter 1',
        lang: 'en',
        model: null,
        sourceId: null,
        fileId: null,
        tagName: 'h2',
        attributes: '{}',
      },
    ]);

    const blocks = await db.getBlocksByBook('book-1');
    expect(blocks.length).toBe(2);
    expect(blocks[0].content).toBe('Hello world');
    expect(blocks[1].type).toBe('heading');
  });

  it('should upsert a translation block', async () => {
    await db.insertBook({
      id: 'book-1',
      title: 'Test Book',
      author: 'Author',
      language: 'en',
      filename: 'test.epub',
      totalBlocks: 10,
    });
    const sourceBlock = {
      id: 'block-1',
      bookId: 'book-1',
      index: 0,
      docPath: 'OEBPS/chapter1.xhtml',
      type: 'paragraph',
      content: 'Hello world',
      lang: 'en',
      model: null,
      sourceId: null,
      fileId: null,
      tagName: 'p',
      attributes: '{}',
    };
    await db.insertBlocks([sourceBlock]);

    // Insert a translation (es) for block-1
    await db.upsertTranslation(sourceBlock, 'Hola mundo', 'es', 'llama3.1');

    // getBlocksByBookWithTranslations should join in translatedContent
    const blocks = await db.getBlocksByBookWithTranslations('book-1', 'es', 'llama3.1');
    const b1 = blocks.find((b) => b.id === 'block-1');
    expect(b1).toBeDefined();
    expect(b1.translatedContent).toBe('Hola mundo');
  });

  it('should get untranslated blocks', async () => {
    await db.insertBook({
      id: 'book-1',
      title: 'Test Book',
      author: 'Author',
      language: 'en',
      filename: 'test.epub',
      totalBlocks: 10,
    });
    const block1 = {
      id: 'block-1',
      bookId: 'book-1',
      index: 0,
      docPath: 'OEBPS/chapter1.xhtml',
      type: 'paragraph',
      content: 'Hello world',
      lang: 'en',
      model: null,
      sourceId: null,
      fileId: null,
      tagName: 'p',
      attributes: '{}',
    };
    const block2 = {
      id: 'block-2',
      bookId: 'book-1',
      index: 1,
      docPath: 'OEBPS/chapter1.xhtml',
      type: 'heading',
      content: '## Chapter 1',
      lang: 'en',
      model: null,
      sourceId: null,
      fileId: null,
      tagName: 'h2',
      attributes: '{}',
    };
    await db.insertBlocks([block1, block2]);

    // Add a translation for block-1 only
    await db.upsertTranslation(block1, 'Hola mundo', 'es', 'llama3.1');

    const untranslated = await db.getUntranslatedBlocks('book-1', 'es');
    expect(untranslated.length).toBe(1);
    expect(untranslated[0].id).toBe('block-2');
  });

  it('should get blocks by doc path', async () => {
    await db.insertBook({
      id: 'book-1',
      title: 'Test Book',
      author: 'Author',
      language: 'en',
      filename: 'test.epub',
      totalBlocks: 10,
    });
    await db.insertBlocks([
      {
        id: 'block-1',
        bookId: 'book-1',
        index: 0,
        docPath: 'OEBPS/chapter1.xhtml',
        type: 'paragraph',
        content: 'Hello world',
        lang: 'en',
        model: null,
        sourceId: null,
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
        content: '## Chapter 1',
        lang: 'en',
        model: null,
        sourceId: null,
        fileId: null,
        tagName: 'h2',
        attributes: '{}',
      },
    ]);

    const blocks = await db.getBlocksByDoc('book-1', 'OEBPS/chapter1.xhtml');
    expect(blocks.length).toBe(2);
  });

  it('should count blocks', async () => {
    await db.insertBook({
      id: 'book-1',
      title: 'Test Book',
      author: 'Author',
      language: 'en',
      filename: 'test.epub',
      totalBlocks: 10,
    });
    const block1 = {
      id: 'block-1',
      bookId: 'book-1',
      index: 0,
      docPath: 'OEBPS/chapter1.xhtml',
      type: 'paragraph',
      content: 'Hello world',
      lang: 'en',
      model: null,
      sourceId: null,
      fileId: null,
      tagName: 'p',
      attributes: '{}',
    };
    const block2 = {
      id: 'block-2',
      bookId: 'book-1',
      index: 1,
      docPath: 'OEBPS/chapter1.xhtml',
      type: 'heading',
      content: '## Chapter 1',
      lang: 'en',
      model: null,
      sourceId: null,
      fileId: null,
      tagName: 'h2',
      attributes: '{}',
    };
    await db.insertBlocks([block1, block2]);
    await db.upsertTranslation(block1, 'Hola mundo', 'es', 'llama3.1');

    const counts = await db.countBlocks('book-1', 'es');
    expect(counts.total).toBe(2);
    expect(counts.translated).toBe(1);
  });

  it('should get doc paths', async () => {
    await db.insertBook({
      id: 'book-1',
      title: 'Test Book',
      author: 'Author',
      language: 'en',
      filename: 'test.epub',
      totalBlocks: 10,
    });
    await db.insertBlocks([
      {
        id: 'block-1',
        bookId: 'book-1',
        index: 0,
        docPath: 'OEBPS/chapter1.xhtml',
        type: 'paragraph',
        content: 'Hello world',
        lang: 'en',
        model: null,
        sourceId: null,
        fileId: null,
        tagName: 'p',
        attributes: '{}',
      },
    ]);

    const paths = await db.getDocPaths('book-1');
    expect(paths).toContain('OEBPS/chapter1.xhtml');
  });

  it('should delete a book and its blocks and files', async () => {
    await db.insertBook({
      id: 'book-1',
      title: 'Test Book',
      author: 'Author',
      language: 'en',
      filename: 'test.epub',
      totalBlocks: 10,
    });
    await db.insertBlocks([
      {
        id: 'block-1',
        bookId: 'book-1',
        index: 0,
        docPath: 'OEBPS/chapter1.xhtml',
        type: 'paragraph',
        content: 'Hello world',
        lang: 'en',
        model: null,
        sourceId: null,
        fileId: null,
        tagName: 'p',
        attributes: '{}',
      },
    ]);

    await db.deleteBook('book-1');
    expect(await db.getBook('book-1')).toBeUndefined();
    expect((await db.getBlocksByBook('book-1')).length).toBe(0);
    expect((await db.getFilesByBook('book-1')).length).toBe(0);
  });

  it('should list books', async () => {
    await db.insertBook({
      id: 'book-2',
      title: 'Second Book',
      author: 'Writer',
      language: 'de',
      filename: 'second.epub',
      totalBlocks: 5,
    });
    const books = await db.listBooks();
    expect(books.length).toBeGreaterThan(0);
  });
});

describe('FileRecord CRUD', () => {
  beforeEach(cleanup);

  it('should insert and retrieve a file', async () => {
    await db.insertBook({
      id: 'book-files',
      title: 'Files Test Book',
      author: 'Test',
      language: 'en',
      filename: 'images.epub',
      totalBlocks: 1,
    });

    const imageData = Buffer.from('fake-image-data');
    const fileId = generateFileId(imageData);

    await db.insertFile({
      id: fileId,
      bookId: 'book-files',
      originalPath: 'OEBPS/images/photo.jpg',
      mimeType: 'image/jpeg',
      data: imageData,
      createdAt: new Date().toISOString(),
    });

    const file = await db.getFile(fileId);
    expect(file).toBeDefined();
    expect(file.id).toBe(fileId);
    expect(file.originalPath).toBe('OEBPS/images/photo.jpg');
    expect(file.mimeType).toBe('image/jpeg');
    expect(file.data).toBeInstanceOf(Buffer);
    expect(file.data.length).toBe(imageData.length);
  });

  it('should get file by path', async () => {
    await db.insertBook({
      id: 'book-files',
      title: 'Files Test Book',
      author: 'Test',
      language: 'en',
      filename: 'images.epub',
      totalBlocks: 1,
    });

    const imageData = Buffer.from('another-image');
    const fileId = generateFileId(imageData);

    await db.insertFile({
      id: fileId,
      bookId: 'book-files',
      originalPath: 'OEBPS/images/cover.png',
      mimeType: 'image/png',
      data: imageData,
      createdAt: new Date().toISOString(),
    });

    const file = await db.getFileByPath('book-files', 'OEBPS/images/cover.png');
    expect(file).toBeDefined();
    expect(file.mimeType).toBe('image/png');
  });

  it('should get all files for a book', async () => {
    await db.insertBook({
      id: 'book-files',
      title: 'Files Test Book',
      author: 'Test',
      language: 'en',
      filename: 'images.epub',
      totalBlocks: 1,
    });

    await db.insertFile({
      id: generateFileId(Buffer.from('img-a')),
      bookId: 'book-files',
      originalPath: 'OEBPS/images/a.jpg',
      mimeType: 'image/jpeg',
      data: Buffer.from('img-a'),
      createdAt: new Date().toISOString(),
    });
    await db.insertFile({
      id: generateFileId(Buffer.from('img-b')),
      bookId: 'book-files',
      originalPath: 'OEBPS/images/b.png',
      mimeType: 'image/png',
      data: Buffer.from('img-b'),
      createdAt: new Date().toISOString(),
    });

    const files = await db.getFilesByBook('book-files');
    expect(files.length).toBe(2);
  });

  it('should insert multiple files at once', async () => {
    await db.insertBook({
      id: 'book-files',
      title: 'Files Test Book',
      author: 'Test',
      language: 'en',
      filename: 'images.epub',
      totalBlocks: 1,
    });

    // Pre-insert 2 files individually
    await db.insertFile({
      id: generateFileId(Buffer.from('img-a')),
      bookId: 'book-files',
      originalPath: 'OEBPS/images/a.jpg',
      mimeType: 'image/jpeg',
      data: Buffer.from('img-a'),
      createdAt: new Date().toISOString(),
    });
    await db.insertFile({
      id: generateFileId(Buffer.from('img-b')),
      bookId: 'book-files',
      originalPath: 'OEBPS/images/b.png',
      mimeType: 'image/png',
      data: Buffer.from('img-b'),
      createdAt: new Date().toISOString(),
    });

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

    await db.insertFiles(files);
    const allFiles = await db.getFilesByBook('book-files');
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

  it('should support blocks with fileId references', async () => {
    await db.insertBook({
      id: 'book-files',
      title: 'Files Test Book',
      author: 'Test',
      language: 'en',
      filename: 'images.epub',
      totalBlocks: 1,
    });

    const imageData = Buffer.from('block-image-data');
    const fileId = generateFileId(imageData);

    await db.insertFile({
      id: fileId,
      bookId: 'book-files',
      originalPath: 'OEBPS/images/inline.jpg',
      mimeType: 'image/jpeg',
      data: imageData,
      createdAt: new Date().toISOString(),
    });

    await db.insertBlocks([
      {
        id: 'block-img-1',
        bookId: 'book-files',
        index: 99,
        docPath: 'OEBPS/chapter2.xhtml',
        type: 'image',
        content: '![Photo](file:' + fileId + ')',
        lang: 'en',
        model: null,
        sourceId: null,
        fileId: fileId,
        tagName: 'img',
        attributes: '{"src": "file:' + fileId + '"}',
      },
    ]);

    const blocks = await db.getBlocksByBook('book-files');
    const imgBlock = blocks.find((b) => b.id === 'block-img-1');
    expect(imgBlock).toBeDefined();
    expect(imgBlock.fileId).toBe(fileId);
    expect(imgBlock.type).toBe('image');
    expect(imgBlock.content).toContain('file:' + fileId);
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

describe('Task CRUD', () => {
  beforeEach(cleanup);

  it('should create and retrieve tasks', async () => {
    await db.insertBook({
      id: 'test-doc-tasks',
      title: 'Test PDF',
      author: '',
      language: 'en',
      filename: 'test.pdf',
      totalBlocks: 0,
    });

    await db.createTasks([
      { id: 'task-1', docId: 'test-doc-tasks', type: 'ocr_page', pageNum: 1, totalPages: 3 },
      { id: 'task-2', docId: 'test-doc-tasks', type: 'ocr_page', pageNum: 2, totalPages: 3 },
      { id: 'task-3', docId: 'test-doc-tasks', type: 'ocr_page', pageNum: 3, totalPages: 3 },
    ]);

    const tasks = await db.getTasksByDoc('test-doc-tasks');
    expect(tasks).toHaveLength(3);
    expect(tasks[0].pageNum).toBe(1);
    expect(tasks[0].status).toBe('pending');
    expect(tasks[1].pageNum).toBe(2);
    expect(tasks[2].pageNum).toBe(3);
  });

  it('should get next task and mark it processing', async () => {
    await db.insertBook({
      id: 'test-doc-next',
      title: 'Test',
      author: '',
      language: 'en',
      filename: 'test.pdf',
      totalBlocks: 0,
    });

    await db.createTasks([
      { id: 'task-next-1', docId: 'test-doc-next', type: 'ocr_page', pageNum: 1, totalPages: 2 },
      { id: 'task-next-2', docId: 'test-doc-next', type: 'ocr_page', pageNum: 2, totalPages: 2 },
    ]);

    // Clean up any stray pending tasks from other tests
    await db.sequelize.query(`UPDATE tasks SET status = 'cancelled' WHERE doc_id != 'test-doc-next' AND status = 'pending'`);

    const task = await db.getNextTask();
    expect(task).toBeDefined();
    expect(task.status).toBe('processing');
    expect(task.docId).toBe('test-doc-next');
    expect(task.pageNum).toBe(1);

    // Next call should get the second task
    const task2 = await db.getNextTask();
    expect(task2).toBeDefined();
    expect(task2.status).toBe('processing');
    expect(task2.pageNum).toBe(2);

    // Third call should return undefined
    const task3 = await db.getNextTask();
    expect(task3).toBeUndefined();
  });

  it('should complete a task with content', async () => {
    await db.insertBook({
      id: 'test-doc-complete',
      title: 'Test',
      author: '',
      language: 'en',
      filename: 'test.pdf',
      totalBlocks: 0,
    });

    await db.createTasks([
      { id: 'task-complete-1', docId: 'test-doc-complete', type: 'ocr_page', pageNum: 1, totalPages: 1 },
    ]);

    // Clean up any stray pending tasks from other tests
    await db.sequelize.query(`UPDATE tasks SET status = 'cancelled' WHERE doc_id != 'test-doc-complete' AND status = 'pending'`);

    const task = await db.getNextTask();
    expect(task).toBeDefined();
    expect(task.id).toBe('task-complete-1');
    await db.completeTask(task.id, '# Heading\n\nParagraph text');

    const tasks = await db.getTasksByDoc('test-doc-complete');
    expect(tasks[0].status).toBe('completed');
    expect(tasks[0].content).toBe('# Heading\n\nParagraph text');
    expect(tasks[0].completedAt).not.toBeNull();
  });

  it('should fail a task with error', async () => {
    await db.insertBook({
      id: 'test-doc-fail',
      title: 'Test',
      author: '',
      language: 'en',
      filename: 'test.pdf',
      totalBlocks: 0,
    });

    await db.createTasks([
      { id: 'task-fail-1', docId: 'test-doc-fail', type: 'ocr_page', pageNum: 1, totalPages: 1 },
    ]);

    // Clean up any stray pending tasks from other tests
    await db.sequelize.query(`UPDATE tasks SET status = 'cancelled' WHERE doc_id != 'test-doc-fail' AND status = 'pending'`);

    const task = await db.getNextTask();
    expect(task).toBeDefined();
    expect(task.id).toBe('task-fail-1');
    await db.failTask(task.id, 'OCR failed');

    const tasks = await db.getTasksByDoc('test-doc-fail');
    expect(tasks[0].status).toBe('failed');
    expect(tasks[0].error).toBe('OCR failed');
  });

  it('should get task counts', async () => {
    await db.insertBook({
      id: 'test-doc-counts',
      title: 'Test',
      author: '',
      language: 'en',
      filename: 'test.pdf',
      totalBlocks: 0,
    });

    await db.createTasks([
      { id: 'task-cnt-1', docId: 'test-doc-counts', type: 'ocr_page', pageNum: 1, totalPages: 3 },
      { id: 'task-cnt-2', docId: 'test-doc-counts', type: 'ocr_page', pageNum: 2, totalPages: 3 },
      { id: 'task-cnt-3', docId: 'test-doc-counts', type: 'ocr_page', pageNum: 3, totalPages: 3 },
    ]);

    // Complete one task
    await db.completeTask('task-cnt-1', 'content');

    const counts = await db.getTaskCounts('test-doc-counts');
    expect(counts.total).toBe(3);
    expect(counts.completed).toBe(1);
    expect(counts.pending).toBe(2);
    expect(counts.processing).toBe(0);
    expect(counts.failed).toBe(0);
  });

  it('should update doc status', async () => {
    await db.insertBook({
      id: 'test-doc-status',
      title: 'Test',
      author: '',
      language: 'en',
      filename: 'test.pdf',
      totalBlocks: 0,
    });

    await db.updateDocStatus('test-doc-status', 'parsing', { totalPages: 10, parsedPages: 3 });
    const book = await db.getBook('test-doc-status');
    expect(book.status).toBe('parsing');
    expect(book.totalPages).toBe(10);
    expect(book.parsedPages).toBe(3);
  });
});
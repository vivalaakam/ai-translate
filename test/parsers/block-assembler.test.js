import { describe, it, expect } from 'vitest';
import { assembleDocHtml, blockToHtml } from '../../src/parsers/block-assembler.js';

describe('blockToHtml', () => {
  it('should convert a paragraph block to HTML', () => {
    const block = {
      id: 'b1',
      bookId: 'book-1',
      index: 0,
      docPath: 'ch1.xhtml',
      type: 'paragraph',
      lang: 'es',
      model: null,
      sourceId: null,
      fileId: null,
      content: 'Hello world',
      translatedContent: 'Hola mundo',
      tagName: 'p',
      attributes: '{}',
    };
    const html = blockToHtml(block);
    expect(html).toContain('Hola mundo');
    expect(html).toMatch(/<p>.*<\/p>/);
  });

  it('should use content when translatedContent is null', () => {
    const block = {
      id: 'b2',
      bookId: 'book-1',
      index: 1,
      docPath: 'ch1.xhtml',
      type: 'paragraph',
      lang: 'en',
      model: null,
      sourceId: null,
      fileId: null,
      content: 'Original text',
      translatedContent: null,
      tagName: 'p',
      attributes: '{}',
    };
    const html = blockToHtml(block);
    expect(html).toContain('Original text');
  });

  it('should convert a heading block with correct level', () => {
    const block = {
      id: 'b3',
      bookId: 'book-1',
      index: 2,
      docPath: 'ch1.xhtml',
      type: 'heading',
      lang: 'es',
      model: null,
      sourceId: null,
      fileId: null,
      content: '## Chapter Title',
      translatedContent: '## Título del Capítulo',
      tagName: 'h2',
      attributes: '{}',
    };
    const html = blockToHtml(block);
    expect(html).toMatch(/<h2>.*<\/h2>/);
    expect(html).toContain('Título del Capítulo');
  });

  it('should convert an image block', () => {
    const block = {
      id: 'b4',
      bookId: 'book-1',
      index: 3,
      docPath: 'ch1.xhtml',
      type: 'image',
      lang: 'en',
      model: null,
      sourceId: null,
      fileId: null,
      content: '![Cover](cover.jpg)',
      translatedContent: null,
      tagName: 'img',
      attributes: '{}',
    };
    const html = blockToHtml(block);
    expect(html).toContain('cover.jpg');
  });

  it('should preserve class attributes', () => {
    const block = {
      id: 'b5',
      bookId: 'book-1',
      index: 4,
      docPath: 'ch1.xhtml',
      type: 'paragraph',
      lang: 'en',
      model: null,
      sourceId: null,
      fileId: null,
      content: 'Styled paragraph',
      translatedContent: null,
      tagName: 'p',
      attributes: '{"class": "intro"}',
    };
    const html = blockToHtml(block);
    expect(html).toContain('class="intro"');
  });
});

describe('assembleDocHtml', () => {
  it('should assemble multiple blocks into one HTML string', () => {
    const blocks = [
      {
        id: 'b1',
        bookId: 'book-1',
        index: 0,
        docPath: 'ch1.xhtml',
        type: 'heading',
        lang: 'en',
        model: null,
        sourceId: null,
        fileId: null,
        content: '## Title',
        translatedContent: null,
        tagName: 'h2',
        attributes: '{}',
      },
      {
        id: 'b2',
        bookId: 'book-1',
        index: 1,
        docPath: 'ch1.xhtml',
        type: 'paragraph',
        lang: 'en',
        model: null,
        sourceId: null,
        fileId: null,
        content: 'Some text here.',
        translatedContent: null,
        tagName: 'p',
        attributes: '{}',
      },
    ];
    const html = assembleDocHtml(blocks);
    expect(html).toContain('Title');
    expect(html).toContain('Some text here');
    expect(html).toContain('<h2');
    expect(html).toContain('<p');
  });
});
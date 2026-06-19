import { describe, it, expect } from 'vitest';
import { markdownToHtml } from '../../src/parsers/pdf-parser.js';

describe('PdfParser — markdownToHtml', () => {
  it('should convert empty markdown to empty body', () => {
    const html = markdownToHtml('');
    expect(html).toBe('<body></body>');
  });

  it('should convert whitespace-only markdown to empty body', () => {
    const html = markdownToHtml('   \n\n  ');
    expect(html).toBe('<body></body>');
  });

  it('should convert headings', () => {
    const html = markdownToHtml('# Title\n\n## Subtitle\n\n### Sub-subtitle');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<h2>Subtitle</h2>');
    expect(html).toContain('<h3>Sub-subtitle</h3>');
  });

  it('should convert paragraphs', () => {
    const html = markdownToHtml('First paragraph.\n\nSecond paragraph.');
    expect(html).toContain('<p>First paragraph.</p>');
    expect(html).toContain('<p>Second paragraph.</p>');
  });

  it('should convert unordered lists', () => {
    const html = markdownToHtml('- Item 1\n- Item 2\n- Item 3');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>Item 1</li>');
    expect(html).toContain('<li>Item 2</li>');
    expect(html).toContain('<li>Item 3</li>');
    expect(html).toContain('</ul>');
  });

  it('should convert ordered lists as unordered (simplified)', () => {
    const html = markdownToHtml('1. First item\n2. Second item');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>First item</li>');
    expect(html).toContain('<li>Second item</li>');
  });

  it('should convert blockquotes', () => {
    const html = markdownToHtml('> This is a quote');
    expect(html).toContain('<blockquote>This is a quote</blockquote>');
  });

  it('should convert code blocks', () => {
    const html = markdownToHtml('```\nconst x = 1;\nconsole.log(x);\n```');
    expect(html).toContain('<pre><code>');
    expect(html).toContain('const x = 1;');
    expect(html).toContain('</code></pre>');
  });

  it('should escape HTML special characters', () => {
    const html = markdownToHtml('Text with <script>alert(1)</script> and & symbol');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).not.toContain('<script>alert');
  });

  it('should handle mixed content', () => {
    const md = `# Article Title

## Introduction

This is the first paragraph.

- Point one
- Point two

> Important note

Final paragraph.`;

    const html = markdownToHtml(md);
    expect(html).toContain('<h1>Article Title</h1>');
    expect(html).toContain('<h2>Introduction</h2>');
    expect(html).toContain('<p>This is the first paragraph.</p>');
    expect(html).toContain('<li>Point one</li>');
    expect(html).toContain('<blockquote>Important note</blockquote>');
    expect(html).toContain('<p>Final paragraph.</p>');
  });

  it('should handle multi-line paragraphs', () => {
    const html = markdownToHtml('Line one\nLine two\nLine three\n\nNew paragraph');
    expect(html).toContain('<p>Line one Line two Line three</p>');
    expect(html).toContain('<p>New paragraph</p>');
  });
});
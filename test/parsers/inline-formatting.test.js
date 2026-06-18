import { describe, it, expect } from 'vitest';
import { blockToHtml } from '../../src/parsers/block-assembler.js';
import TurndownService from 'turndown';

// ── Turndown: HTML → Markdown (inline formatting) ─────────────

function createTurndown() {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  td.keep(['code']);
  td.addRule('underline', { filter: 'u', replacement: c => `++${c}++` });
  td.addRule('styledItalic', {
    filter: n => n.nodeName === 'SPAN' && /font-style\s*:\s*(italic|oblique)/i.test(n.getAttribute('style') || ''),
    replacement: c => `_${c}_`,
  });
  td.addRule('styledBold', {
    filter: n => n.nodeName === 'SPAN' && /font-weight\s*:\s*(bold|[7-9]00)/i.test(n.getAttribute('style') || ''),
    replacement: c => `**${c}**`,
  });
  td.addRule('styledUnderline', {
    filter: n => n.nodeName === 'SPAN' && /text-decoration\s*:\s*.*underline/i.test(n.getAttribute('style') || ''),
    replacement: c => `++${c}++`,
  });
  return td;
}

describe('Inline formatting: Turndown extraction', () => {
  it('should preserve <em> as _italic_', () => {
    const td = createTurndown();
    const md = td.turndown('<p>This is <em>italic</em> text.</p>');
    expect(md).toContain('_italic_');
  });

  it('should preserve <strong> as **bold**', () => {
    const td = createTurndown();
    const md = td.turndown('<p>This is <strong>bold</strong> text.</p>');
    expect(md).toContain('**bold**');
  });

  it('should preserve <u> as ++underline++', () => {
    const td = createTurndown();
    const md = td.turndown('<p>This is <u>underline</u> text.</p>');
    expect(md).toContain('++underline++');
  });

  it('should preserve <span style="font-style:italic"> as _italic_', () => {
    const td = createTurndown();
    const md = td.turndown('<p>This is <span style="font-style:italic">styled italic</span>.</p>');
    expect(md).toContain('_styled italic_');
  });

  it('should preserve <span style="font-weight:bold"> as **bold**', () => {
    const td = createTurndown();
    const md = td.turndown('<p>This is <span style="font-weight:bold">styled bold</span>.</p>');
    expect(md).toContain('**styled bold**');
  });

  it('should preserve <span style="font-weight:700"> as **bold**', () => {
    const td = createTurndown();
    const md = td.turndown('<p>This is <span style="font-weight:700">weight 700</span>.</p>');
    expect(md).toContain('**weight 700**');
  });

  it('should preserve <span style="text-decoration:underline"> as ++underline++', () => {
    const td = createTurndown();
    const md = td.turndown('<p>This is <span style="text-decoration:underline">styled underline</span>.</p>');
    expect(md).toContain('++styled underline++');
  });

  it('should preserve combined formatting', () => {
    const td = createTurndown();
    const md = td.turndown('<p><strong>Bold</strong>, <em>italic</em>, <u>underline</u>.</p>');
    expect(md).toContain('**Bold**');
    expect(md).toContain('_italic_');
    expect(md).toContain('++underline++');
  });
});

// ── MarkdownIt: Markdown → HTML (inline formatting) ────────────

describe('Inline formatting: MarkdownIt assembly', () => {
  function makeBlock(md) {
    return {
      id: 'test', bookId: 'b', docPath: 'x', index: 0,
      type: 'paragraph', lang: 'en', model: null, sourceId: null, fileId: null,
      tagName: 'p', content: md,
      translatedContent: null, attributes: '{}',
    };
  }

  it('should render **bold** as <strong>', () => {
    const html = blockToHtml(makeBlock('This is **bold** text.'));
    expect(html).toContain('<strong>bold</strong>');
  });

  it('should render _italic_ as <em>', () => {
    const html = blockToHtml(makeBlock('This is _italic_ text.'));
    expect(html).toContain('<em>italic</em>');
  });

  it('should render ++underline++ as <u>', () => {
    const html = blockToHtml(makeBlock('This is ++underline++ text.'));
    expect(html).toContain('<u>underline</u>');
  });

  it('should render combined formatting', () => {
    const html = blockToHtml(makeBlock('**bold**, _italic_, and ++underline++.'));
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<u>underline</u>');
  });
});

// ── Round-trip: HTML → Markdown → HTML ─────────────────────────

describe('Inline formatting: round-trip', () => {
  function makeBlock(md) {
    return {
      id: 'test', bookId: 'b', docPath: 'x', index: 0,
      type: 'paragraph', lang: 'en', model: null, sourceId: null, fileId: null,
      tagName: 'p', content: md,
      translatedContent: null, attributes: '{}',
    };
  }

  it('should round-trip bold: <strong> → **b** → <strong>', () => {
    const td = createTurndown();
    const md = td.turndown('<p><strong>bold</strong></p>');
    const html = blockToHtml(makeBlock(md.trim()));
    expect(html).toContain('<strong>bold</strong>');
  });

  it('should round-trip italic: <em> → _i_ → <em>', () => {
    const td = createTurndown();
    const md = td.turndown('<p><em>italic</em></p>');
    const html = blockToHtml(makeBlock(md.trim()));
    expect(html).toContain('<em>italic</em>');
  });

  it('should round-trip underline: <u> → ++u++ → <u>', () => {
    const td = createTurndown();
    const md = td.turndown('<p><u>underline</u></p>');
    const html = blockToHtml(makeBlock(md.trim()));
    expect(html).toContain('<u>underline</u>');
  });

  it('should round-trip styled italic: <span style="font-style:italic"> → _i_ → <em>', () => {
    const td = createTurndown();
    const md = td.turndown('<p><span style="font-style:italic">styled italic</span></p>');
    const html = blockToHtml(makeBlock(md.trim()));
    expect(html).toContain('<em>styled italic</em>');
  });
});
import { describe, it, expect } from 'vitest';
import { parseProvider } from '../../src/translators/model-manager.js';

describe('parseProvider', () => {
  it('should parse "lmstudio" variants', () => {
    expect(parseProvider('lmstudio')).toBe('lmstudio');
    expect(parseProvider('lm-studio')).toBe('lmstudio');
    expect(parseProvider('LMStudio')).toBe('lmstudio');
    expect(parseProvider('LM_STUDIO')).toBe('lmstudio');
  });

  it('should parse "ollama"', () => {
    expect(parseProvider('ollama')).toBe('ollama');
    expect(parseProvider('Ollama')).toBe('ollama');
  });

  it('should parse "remote" variants', () => {
    expect(parseProvider('remote')).toBe('remote');
    expect(parseProvider('openai')).toBe('remote');
    expect(parseProvider('api')).toBe('remote');
  });

  it('should default to "remote" for empty/unknown', () => {
    expect(parseProvider('')).toBe('remote');
    expect(parseProvider()).toBe('remote');
    expect(parseProvider('unknown')).toBe('remote');
  });
});
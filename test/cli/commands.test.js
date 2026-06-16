import { describe, it, expect } from 'vitest';
import { run } from '../../src/cli/commands.js';

describe('CLI commands', () => {
  it('should export a run function', () => {
    expect(typeof run).toBe('function');
  });
});
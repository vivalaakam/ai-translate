import { execSync } from 'child_process';

/**
 * Provider type for model management.
 * - 'lmstudio': uses `lms` CLI for load/unload
 * - 'ollama': uses `ollama` CLI for load/unload (future)
 * - 'remote': no local model management (OpenAI, etc.)
 */
export type LlmProvider = 'lmstudio' | 'ollama' | 'remote';

/**
 * Parse LLM_PROVIDER env var into a typed value.
 */
export function parseProvider(value?: string): LlmProvider {
  const normalized = (value || '').toLowerCase().trim();
  if (normalized === 'lmstudio' || normalized === 'lm-studio' || normalized === 'lm_studio') return 'lmstudio';
  if (normalized === 'ollama') return 'ollama';
  if (normalized === 'remote' || normalized === 'openai' || normalized === 'api') return 'remote';
  // Default: auto-detect from URL
  return 'remote';
}

/**
 * Check if a model is currently loaded in LM Studio.
 * Uses `lms ps` — parses the output table.
 */
export function isModelLoaded(model: string): boolean {
  try {
    const output = execSync('lms ps --format json 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 10000,
    });
    // Try JSON parse first (lms ps --format json may not be supported)
    try {
      const data = JSON.parse(output);
      if (Array.isArray(data)) {
        return data.some((m: any) => m.identifier === model || m.model === model);
      }
    } catch {
      // Fall through to text parsing
    }
    return false;
  } catch {
    // Fallback: try text output parsing
    try {
      const output = execSync('lms ps', { encoding: 'utf-8', timeout: 10000 });
      const lines = output.split('\n').slice(1); // skip header
      return lines.some(line => {
        const parts = line.split(/\s+/);
        return parts[0] === model || parts[1] === model;
      });
    } catch {
      return false;
    }
  }
}

/**
 * Load a model into LM Studio memory.
 * Uses `lms load <model>`.
 */
export function loadModel(model: string): void {
  execSync(`lms load ${model}`, {
    encoding: 'utf-8',
    timeout: 300000, // 5 min — large models take time to load
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Unload a model from LM Studio memory.
 * Uses `lms unload <model>`.
 */
export function unloadModel(model: string): void {
  execSync(`lms unload ${model}`, {
    encoding: 'utf-8',
    timeout: 30000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Ensure a model is loaded for translation.
 * Returns `true` if the model was loaded by this call (needs unloading after),
 * or `false` if it was already loaded.
 */
export function ensureModelLoaded(model: string, provider: LlmProvider): boolean {
  if (provider !== 'lmstudio') return false;

  if (isModelLoaded(model)) {
    return false; // Already loaded — don't unload after
  }

  loadModel(model);
  return true; // We loaded it — should unload after
}

/**
 * Unload a model if we were the ones who loaded it.
 */
export function unloadIfWeLoaded(model: string, wasLoadedByUs: boolean, provider: LlmProvider): void {
  if (!wasLoadedByUs || provider !== 'lmstudio') return;

  try {
    unloadModel(model);
  } catch {
    // Best-effort — don't fail the whole job if unload fails
  }
}
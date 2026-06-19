// Shared constants for ai-translate
// Values can be overridden via environment variables or .env file

export const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://local_user:local_user_dev@localhost:5432/ai_translate';
export const OLLAMA_DEFAULT_URL = process.env.OPENAI_BASE_URL || process.env.OLLAMA_URL || 'http://localhost:11434';
export const DEFAULT_MODEL = process.env.TRANSLATE_MODEL || process.env.OLLAMA_MODEL || 'llama3.1';
export const DEFAULT_OCR_MODEL = process.env.OCR_MODEL || 'deepseek-ocr';
export const DEFAULT_API_KEY = process.env.OPENAI_API_KEY || '';
export const DEFAULT_CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || '8000', 10); // chars per translation chunk
export const DEFAULT_PORT = parseInt(process.env.PORT || '3000', 10);
export const DEFAULT_LLM_PROVIDER = process.env.LLM_PROVIDER || '';
export const UPLOAD_ONLY = (process.env.UPLOAD_ONLY || '').toLowerCase() === 'true';
export const TEMP_MARKER_PREFIX = 'ai-tr';
export const SUPPORTED_INPUT_FORMATS: string[] = ['.epub', '.fb2', '.pdf'];

// FB2 XML namespace
export const FB2_NS = 'http://www.gribuser.ru/xml/fictionbook/2.0';

// Translation prompt template
export const TRANSLATION_PROMPT_TEMPLATE = `Translate the following text into {targetLang}. Note that you should only output the translated result without any additional explanation:

{sourceText}`;
// Shared constants for ai-translate
// Values can be overridden via environment variables or .env file

export const OLLAMA_DEFAULT_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
export const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'llama3.1';
export const DEFAULT_CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || '8000', 10); // chars per translation chunk
export const DEFAULT_PORT = parseInt(process.env.PORT || '3000', 10);
export const TEMP_MARKER_PREFIX = 'ai-tr';
export const SUPPORTED_INPUT_FORMATS: string[] = ['.epub', '.fb2'];

// FB2 XML namespace
export const FB2_NS = 'http://www.gribuser.ru/xml/fictionbook/2.0';

// Translation prompt template
export const TRANSLATION_PROMPT_TEMPLATE = `You are a professional translator. Translate the following text from {sourceLang} to {targetLang}.
Preserve all formatting markers exactly as they appear. Do not add any commentary or notes.
Only output the translation, nothing else.

Text to translate:
{text}`;
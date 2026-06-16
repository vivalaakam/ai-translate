// Shared constants for ai-translate

export const DEFAULT_CHUNK_SIZE = 8000; // chars per translation chunk
export const OLLAMA_DEFAULT_URL = 'http://localhost:11434';
export const DEFAULT_MODEL = 'llama3.1';
export const TEMP_MARKER_PREFIX = 'ai-tr';
export const SUPPORTED_INPUT_FORMATS = ['.epub', '.fb2'];

// FB2 XML namespace
export const FB2_NS = 'http://www.gribuser.ru/xml/fictionbook/2.0';

// Translation prompt template
export const TRANSLATION_PROMPT_TEMPLATE = `You are a professional translator. Translate the following text from {sourceLang} to {targetLang}.
Preserve all formatting markers exactly as they appear. Do not add any commentary or notes.
Only output the translation, nothing else.

Text to translate:
{text}`;
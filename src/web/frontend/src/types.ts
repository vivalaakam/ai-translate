/// <reference types="vite/client" />

export type JobStatus = 'queued' | 'parsing' | 'translating' | 'assembling' | 'completed' | 'failed';

export type BlockType = 'heading' | 'paragraph' | 'image' | 'list_item' | 'quote' | 'code' | 'table_row' | 'page_break' | 'other';

export interface BookRecord {
  id: string;
  title: string;
  author: string;
  language: string;
  filename: string;
  totalBlocks: number;
  translatedBlocks: number;
  targetLang: string | null;
  sourceLang: string | null;
  model: string | null;
  createdAt: string;
  completedAt: string | null;
  status: string;
  totalPages: number;
  parsedPages: number;
}

export interface ChapterInfo {
  docPath: string;
  totalBlocks: number;
  translatedBlocks: number;
}

export interface ImageInfo {
  id: string;
  originalPath: string;
  mimeType: string;
  size: number;
  bookId: string;
  url: string;
}

export interface BookDetail extends BookRecord {
  blockCounts: { total: number; translated: number };
  chapters: ChapterInfo[];
  images: ImageInfo[];
}

export interface TranslationJob {
  id: string;
  originalFilename: string;
  targetLang: string;
  sourceLang: string;
  model: string;
  status: JobStatus;
  progress: number;
  message: string;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  metadata: {
    title: string;
    author: string;
    language: string;
    format: string;
  } | null;
}

export interface SystemConfig {
  uploadOnly: boolean;
  defaultModel: string;
  defaultProvider: string;
}

export interface WSMessage {
  type: 'job:update' | 'jobs:list';
  job?: TranslationJob;
  jobs?: TranslationJob[];
}
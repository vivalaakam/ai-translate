import type { BookRecord, BookDetail, TranslationJob, SystemConfig } from './types';

let rpcId = 0;

export async function rpc<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
  const id = ++rpcId;
  const res = await fetch('/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
  });
  const data = await res.json();
  if (data.error) {
    const err = new Error(data.error.message) as any;
    err.code = data.error.code;
    err.data = data.error.data;
    throw err;
  }
  return data.result as T;
}

export async function rpcWithFile<T = any>(method: string, params: Record<string, any>, file: File): Promise<T> {
  const id = ++rpcId;
  const form = new FormData();
  form.append('file', file);
  form.append('rpc', JSON.stringify({ jsonrpc: '2.0', method, params, id }));
  const res = await fetch('/rpc', { method: 'POST', body: form });
  const data = await res.json();
  if (data.error) {
    const err = new Error(data.error.message) as any;
    err.code = data.error.code;
    throw err;
  }
  return data.result as T;
}

// ── Typed API methods ──────────────────────────────────

export const api = {
  systemConfig: () => rpc<SystemConfig>('system.config'),
  modelList: () => rpc<{ models: string[] }>('model.list'),
  bookList: () => rpc<{ books: BookRecord[] }>('book.list'),
  bookGet: (bookId: string) => rpc<BookDetail>('book.get', { bookId }),
  bookDelete: (bookId: string) => rpc<{ deleted: boolean }>('book.delete', { bookId }),
  bookUpload: (file: File) => rpcWithFile<{ jobId: string; status: string; uploadOnly: boolean }>('book.upload', {}, file),
  bookTranslate: (file: File, targetLang: string, sourceLang?: string, model?: string) =>
    rpcWithFile<{ jobId: string; status: string }>('book.translate', { targetLang, sourceLang, model }, file),
  bookStartTranslation: (bookId: string, targetLang: string, sourceLang?: string, model?: string) =>
    rpc<{ jobId: string; status: string }>('book.startTranslation', { bookId, targetLang, sourceLang, model }),
  bookExport: (bookId: string, mode: 'original' | 'translated') =>
    rpc<{ outputPath: string; downloadUrl: string; mode: string }>('book.export', { bookId, mode }),
  jobList: () => rpc<{ jobs: TranslationJob[] }>('job.list'),
  jobGet: (jobId: string) => rpc<TranslationJob>('job.get', { jobId }),
  jobDelete: (jobId: string) => rpc<{ deleted: boolean }>('job.delete', { jobId }),
  taskList: (docId: string) => rpc<{ tasks: any[] }>('task.list', { docId }),
};
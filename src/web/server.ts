import express from 'express';
import multer from 'multer';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import fs from 'fs';

import { JobQueue } from './job-queue.js';
import { runTranslation, runUpload } from './pipeline.js';
import { TranslateDb } from '../db/database.js';
import { OLLAMA_DEFAULT_URL, DEFAULT_MODEL, DEFAULT_PORT, DEFAULT_API_KEY, DEFAULT_LLM_PROVIDER, UPLOAD_ONLY } from '../utils/constants.js';
import type { TranslationJob } from '../types.js';

// Storage config
const uploadDir = JobQueue.getUploadDir();
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${uniqueSuffix}${ext}`);
  },
});
const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.epub' || ext === '.fb2') {
      cb(null, true);
    } else {
      cb(new Error('Only .epub and .fb2 files are allowed'));
    }
  },
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

// WebSocket clients
interface WSClient {
  ws: WebSocket;
  jobId?: string;
}
const wsClients: Set<WSClient> = new Set();

/**
 * Create and configure the Express app + WebSocket server.
 */
export function createApp(options?: { ollamaUrl?: string; defaultModel?: string; apiKey?: string; provider?: string; dbPath?: string }): {
  app: express.Application;
  server: http.Server;
  jobQueue: JobQueue;
} {
  const app = express();
  const server = http.createServer(app);
  const ollamaUrl = options?.ollamaUrl || OLLAMA_DEFAULT_URL;
  const defaultModel = options?.defaultModel || DEFAULT_MODEL;
  const apiKey = options?.apiKey || DEFAULT_API_KEY;
  const provider = options?.provider || DEFAULT_LLM_PROVIDER;
  const dbPath = options?.dbPath;

  // Job queue with WebSocket broadcast
  const jobQueue = new JobQueue((job) => {
    broadcastJobUpdate(job);
  });

  // WebSocket server
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    const client: WSClient = { ws };
    wsClients.add(client);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'subscribe' && msg.jobId) {
          client.jobId = msg.jobId;
          // Send current job state
          const job = jobQueue.get(msg.jobId);
          if (job) {
            ws.send(JSON.stringify({ type: 'job:update', job: serializeJob(job) }));
          }
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      wsClients.delete(client);
    });

    // Send list of recent jobs on connect
    const recentJobs = jobQueue.list().slice(0, 10).map(serializeJob);
    ws.send(JSON.stringify({ type: 'jobs:list', jobs: recentJobs }));
  });

  function broadcastJobUpdate(job: TranslationJob): void {
    const payload = JSON.stringify({ type: 'job:update', job: serializeJob(job) });
    for (const client of wsClients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        // Send to all subscribers or to those watching this specific job
        if (!client.jobId || client.jobId === job.id) {
          client.ws.send(payload);
        }
      }
    }
  }

  // Middleware
  app.use(express.json());
  app.use(express.static(path.join(import.meta.dirname, 'public')));

  // ─── API Routes ─────────────────────────────────────────────

  // POST /api/upload — upload and parse a book (no translation)
  app.post('/api/upload', upload.single('file'), async (req, res): Promise<void> => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }

      const job = jobQueue.create({
        originalFilename: req.file.originalname,
        inputPath: req.file.path,
        targetLang: '',
        sourceLang: 'auto',
        model: '',
      });

      // Run upload-only (parse + extract blocks)
      runUpload(job, jobQueue, { dbPath }).then((bookRecord) => {
        // Attach book info to job for the response
        job.metadata = {
          title: bookRecord.title,
          author: bookRecord.author,
          language: bookRecord.language,
          format: path.extname(job.originalFilename).replace('.', ''),
        };
      }).catch(() => {
        // Error handled inside runUpload
      });

      res.json({ jobId: job.id, status: job.status, uploadOnly: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/translate — upload file and start translation
  app.post('/api/translate', upload.single('file'), async (req, res): Promise<void> => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }

      const targetLang = req.body.targetLang;
      if (!targetLang) {
        // Clean up uploaded file
        fs.unlinkSync(req.file.path);
        res.status(400).json({ error: 'Target language is required' });
        return;
      }

      const sourceLang = req.body.sourceLang || 'auto';
      const model = req.body.model || defaultModel;

      const job = jobQueue.create({
        originalFilename: req.file.originalname,
        inputPath: req.file.path,
        targetLang,
        sourceLang,
        model,
      });

      // Start translation in background
      runTranslation(job, jobQueue, { ollamaUrl, apiKey, provider, dbPath }).catch(() => {
        // Error is already handled inside runTranslation
      });

      res.json({ jobId: job.id, status: job.status });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/books/:id/translate — start translating an already-uploaded book
  app.post('/api/books/:id/translate', async (req, res): Promise<void> => {
    try {
      const db = new TranslateDb(dbPath);
      const book = db.getBook(req.params.id);
      db.close();

      if (!book) {
        res.status(404).json({ error: 'Book not found' });
        return;
      }

      const targetLang = req.body.targetLang;
      if (!targetLang) {
        res.status(400).json({ error: 'Target language is required' });
        return;
      }

      const sourceLang = req.body.sourceLang || 'auto';
      const model = req.body.model || defaultModel;

      // Find the original upload for this book
      const uploadJobs = jobQueue.list().filter(j => j.originalFilename === book.filename);
      if (uploadJobs.length === 0) {
        res.status(404).json({ error: 'Original file not found — re-upload the book' });
        return;
      }

      const job = jobQueue.create({
        originalFilename: book.filename,
        inputPath: uploadJobs[0].inputPath,
        targetLang,
        sourceLang,
        model,
      });

      runTranslation(job, jobQueue, { ollamaUrl, apiKey, provider, dbPath }).catch(() => {});

      res.json({ jobId: job.id, status: job.status });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/jobs — list all jobs
  app.get('/api/jobs', (_req, res) => {
    const jobs = jobQueue.list().map(serializeJob);
    res.json({ jobs });
  });

  // GET /api/jobs/:id — get job status
  app.get('/api/jobs/:id', (req, res) => {
    const job = jobQueue.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json(serializeJob(job));
  });

  // GET /api/jobs/:id/download — download translated file
  app.get('/api/jobs/:id/download', (req, res) => {
    const job = jobQueue.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (job.status !== 'completed' || !job.outputPath) {
      res.status(400).json({ error: 'Translation not yet completed' });
      return;
    }
    if (!fs.existsSync(job.outputPath)) {
      res.status(410).json({ error: 'Output file expired' });
      return;
    }

    const downloadName = job.originalFilename.replace(/\.(epub|fb2)$/i, `_${job.targetLang}.epub`);
    res.download(job.outputPath, downloadName);
  });

  // DELETE /api/jobs/:id — cancel/delete a job
  app.delete('/api/jobs/:id', async (req, res) => {
    const deleted = await jobQueue.delete(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json({ deleted: true });
  });

  // GET /api/books — list all books in the database
  app.get('/api/books', (_req, res) => {
    try {
      const db = new TranslateDb(dbPath);
      const books = db.listBooks();
      db.close();
      res.json({ books });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/books/:id — get a book with block details
  app.get('/api/books/:id', (req, res) => {
    try {
      const db = new TranslateDb(dbPath);
      const book = db.getBook(req.params.id);
      if (!book) {
        db.close();
        res.status(404).json({ error: 'Book not found' });
        return;
      }
      const counts = db.countBlocks(book.id);
      const docPaths = db.getDocPaths(book.id);
      const chapters = docPaths.map(dp => {
        const blocks = db.getBlocksByDoc(book.id, dp);
        return {
          docPath: dp,
          totalBlocks: blocks.length,
          translatedBlocks: blocks.filter(b => b.translatedMd !== null).length,
        };
      });
      db.close();

      res.json({
        ...book,
        blockCounts: counts,
        chapters,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/books/:id — delete a book and its blocks
  app.delete('/api/books/:id', (req, res) => {
    try {
      const db = new TranslateDb(dbPath);
      const book = db.getBook(req.params.id);
      if (!book) {
        db.close();
        res.status(404).json({ error: 'Book not found' });
        return;
      }
      db.deleteBook(req.params.id);
      db.close();
      res.json({ deleted: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/models — list available models via OpenAI-compatible API
  app.get('/api/models', async (_req, res) => {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
      const response = await fetch(`${ollamaUrl}/v1/models`, { headers });
      if (!response.ok) {
        res.status(502).json({ error: 'API not available' });
        return;
      }
      const data = await response.json() as { data: Array<{ id: string }> };
      const models = data.data.map((m) => m.id).sort();
      res.json({ models });
    } catch {
      res.status(502).json({ error: 'API not available' });
    }
  });

  // GET /api/config — return client-side config (uploadOnly flag, defaultModel)
  app.get('/api/config', (_req, res) => {
    res.json({
      uploadOnly: UPLOAD_ONLY,
      defaultModel,
      defaultProvider: provider,
    });
  });

  // GET /api/health — health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  return { app, server, jobQueue };
}

/**
 * Start the web server.
 */
export function startServer(port: number = DEFAULT_PORT, options?: { ollamaUrl?: string; defaultModel?: string; apiKey?: string; provider?: string }): http.Server {
  const { server, jobQueue } = createApp(options);

  server.listen(port, () => {
    console.log(`🌐 ai-translate web server running at http://localhost:${port}`);
    console.log(`   API: http://localhost:${port}/api/translate`);
    if (UPLOAD_ONLY) {
      console.log(`   Mode: UPLOAD_ONLY — books are parsed but not translated`);
    }
    console.log(`   WebSocket: ws://localhost:${port}/ws`);
  });

  // Cleanup old jobs every hour
  setInterval(() => {
    jobQueue.cleanup();
  }, 60 * 60 * 1000);

  return server;
}

/**
 * Serialize a TranslationJob for JSON transport (convert Date objects to ISO strings).
 */
function serializeJob(job: TranslationJob): object {
  return {
    ...job,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() || null,
  };
}
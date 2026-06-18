import { useState, useCallback } from 'react';
import { api } from '../api';
import type { BookDetail as BookDetailType, SystemConfig } from '../types';

interface BookDetailProps {
  detail: BookDetailType;
  config: SystemConfig;
  models: string[];
  modelsError: boolean;
  onRefresh: () => void;
  onSubscribeJob: (jobId: string) => void;
  onDelete: () => void;
}

export function BookDetail({
  detail,
  config,
  models,
  modelsError,
  onRefresh,
  onSubscribeJob,
  onDelete,
}: BookDetailProps) {
  const [targetLang, setTargetLang] = useState('');
  const [sourceLang, setSourceLang] = useState('auto');
  const [model, setModel] = useState(config.defaultModel || '');
  const [translating, setTranslating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportMode, setExportMode] = useState<'original' | 'translated'>('translated');
  const [exportError, setExportError] = useState<string | null>(null);

  const total = detail.totalBlocks || detail.blockCounts?.total || 0;
  const translated = detail.translatedBlocks || detail.blockCounts?.translated || 0;
  const pct = total > 0 ? Math.round((translated / total) * 100) : 0;
  const isComplete = detail.completedAt !== null;
  const isTranslating = translated > 0 && !isComplete;

  const handleTranslate = useCallback(async () => {
    if (!targetLang) return;
    setTranslating(true);
    try {
      const result = await api.bookStartTranslation(detail.id, targetLang, sourceLang, model || undefined);
      onSubscribeJob(result.jobId);
      onRefresh();
    } catch (err: any) {
      alert(err.message || 'Failed to start translation');
    }
    setTranslating(false);
  }, [detail.id, targetLang, sourceLang, model, onSubscribeJob, onRefresh]);

  const handleExport = useCallback(async (mode: 'original' | 'translated') => {
    setExporting(true);
    setExportMode(mode);
    setExportError(null);
    try {
      const result = await api.bookExport(detail.id, mode);
      // Use .zip extension — Telegram WebView blocks .epub
      const a = document.createElement('a');
      a.href = result.downloadUrl;
      a.download = result.downloadUrl.split('/').pop()?.replace('.epub', '.zip') || 'book.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err: any) {
      setExportError(err.message || 'Export failed');
    } finally {
      setExporting(false);
    }
  }, [detail.id]);

  const handleDelete = useCallback(async () => {
    if (!confirm('Delete this book and all its data?')) return;
    try {
      await api.bookDelete(detail.id);
      onDelete();
    } catch {}
  }, [detail.id, onDelete]);

  const showTranslateSection = !config.uploadOnly && !isComplete;
  const showExportTranslated = translated > 0;

  return (
    <div>
      {/* Info card */}
      <div className="card">
        <div className="detail-title">{detail.title || detail.filename}</div>
        <div className="detail-author">{detail.author || 'Unknown author'}</div>
        <div className="detail-meta">
          <span>📄 {total} blocks</span>
          <span>🌍 {detail.language || '?'}</span>
          <span>📦 {detail.filename?.split('.').pop() || '?'}</span>
          {isComplete && <span className="badge completed">✓ complete</span>}
          {isTranslating && <span className="badge translating">translating</span>}
          {!isComplete && !isTranslating && <span className="badge queued">parsed</span>}
        </div>

        {translated > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className="progress-text">
              <span>{translated} / {total} blocks</span>
              <span>{pct}%</span>
            </div>
            <div className="progress-bar">
              <div className={`progress-fill ${isComplete ? 'completed' : ''}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}

        <div className="btn-row">
          <button className="btn-sm btn-danger" onClick={handleDelete}>✕ Delete</button>
        </div>
      </div>

      {/* Translate section */}
      {showTranslateSection && (
        <div className="translate-section">
          <h3>🌐 Translate this book</h3>
          <div className="form-row">
            <div className="form-group">
              <label>Source Language</label>
              <select value={sourceLang} onChange={(e) => setSourceLang(e.target.value)}>
                <option value="auto">Auto-detect</option>
                <option value="English">English</option>
                <option value="Russian">Russian</option>
                <option value="Spanish">Spanish</option>
                <option value="French">French</option>
                <option value="German">German</option>
                <option value="Chinese">Chinese</option>
                <option value="Japanese">Japanese</option>
                <option value="Italian">Italian</option>
                <option value="Portuguese">Portuguese</option>
              </select>
            </div>
            <div className="form-group">
              <label>Target Language</label>
              <select value={targetLang} onChange={(e) => setTargetLang(e.target.value)}>
                <option value="">Select…</option>
                <option value="English">English</option>
                <option value="Russian">Russian</option>
                <option value="Spanish">Spanish</option>
                <option value="French">French</option>
                <option value="German">German</option>
                <option value="Chinese">Chinese</option>
                <option value="Japanese">Japanese</option>
                <option value="Italian">Italian</option>
                <option value="Portuguese">Portuguese</option>
              </select>
            </div>
            <div className="form-group full">
              <label>Model</label>
              <select value={model} onChange={(e) => setModel(e.target.value)} disabled={modelsError}>
                {modelsError ? (
                  <option value="">API unavailable</option>
                ) : models.length === 0 ? (
                  <option value="">No models found</option>
                ) : (
                  models.map((m) => <option key={m} value={m}>{m}</option>)
                )}
              </select>
            </div>
          </div>
          <div className="btn-row">
            <button
              className="btn btn-green"
              onClick={handleTranslate}
              disabled={translating || !targetLang || (models.length > 0 && !model && !modelsError)}
            >
              {translating ? '⏳ Starting…' : '🚀 Start Translation'}
            </button>
          </div>
        </div>
      )}

      {/* Export section */}
      <div className="card">
        <h3>📦 Export EPUB</h3>
        <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 12 }}>
          Download the book as EPUB — original text or translated version.
        </p>
        <div className="btn-row">
          <button
            className="btn btn-blue"
            onClick={() => handleExport('original')}
            disabled={exporting}
          >
            📄 Export Original
          </button>
          {showExportTranslated && (
            <button
              className="btn btn-green"
              onClick={() => handleExport('translated')}
              disabled={exporting}
            >
              🌐 Export Translated
            </button>
          )}
        </div>
        {exporting && (
          <div style={{ marginTop: 12 }}>
            <div className="progress-text">
              <span>Assembling {exportMode} EPUB…</span>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: '50%' }} />
            </div>
          </div>
        )}
        {exportError && (
          <p style={{ color: 'var(--red)', fontSize: 13, marginTop: 8 }}>{exportError}</p>
        )}
      </div>

      {/* Chapters */}
      {detail.chapters?.length > 0 && (
        <div className="card">
          <h3>📑 Chapters ({detail.chapters.length})</h3>
          <div className="chapters-list">
            {detail.chapters.map((ch, i) => {
              const chPct = ch.totalBlocks > 0 ? Math.round((ch.translatedBlocks / ch.totalBlocks) * 100) : 0;
              return (
                <div className="chapter-row" key={i}>
                  <span className="chapter-name">{ch.docPath}</span>
                  <span className="chapter-progress">{ch.translatedBlocks}/{ch.totalBlocks} ({chPct}%)</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Images */}
      {detail.images?.length > 0 && (
        <div className="card">
          <h3>🖼️ Images ({detail.images.length})</h3>
          <div className="images-grid">
            {detail.images.map((img) => {
              const sizeKB = (img.size / 1024).toFixed(1);
              return (
                <div className="img-item" key={img.id}>
                  <img
                    src={img.url}
                    alt={img.originalPath}
                    loading="lazy"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                  <div className="img-size">{sizeKB}KB</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
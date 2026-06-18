import { useState, useCallback, useEffect } from 'react';
import { DropZone } from './DropZone';
import { BookDetail } from './BookDetail';
import { api } from '../api';
import type { BookRecord, BookDetail as BookDetailType, SystemConfig } from '../types';

interface MainContentProps {
  view: 'library' | 'detail';
  selectedBookId: string | null;
  books: BookRecord[];
  config: SystemConfig;
  models: string[];
  modelsError: boolean;
  onSelectBook: (bookId: string | null) => void;
  onRefresh: () => void;
  onSubscribeJob: (jobId: string) => void;
  onUploadStart: (jobId: string) => void;
  onUploadComplete: (bookId: string) => void;
}

export function MainContent(props: MainContentProps) {
  if (props.view === 'detail' && props.selectedBookId) {
    return (
      <main className="main">
        <div className="main-header">
          <button className="btn btn-secondary" onClick={() => props.onSelectBook(null)}>
            ← Back
          </button>
        </div>
        <div className="main-content">
          <BookDetailView
            bookId={props.selectedBookId}
            config={props.config}
            models={props.models}
            modelsError={props.modelsError}
            onRefresh={props.onRefresh}
            onSubscribeJob={props.onSubscribeJob}
            onBack={() => props.onSelectBook(null)}
          />
        </div>
      </main>
    );
  }

  return (
    <main className="main">
      <div className="main-header">
        <span style={{ fontSize: 16, fontWeight: 600 }}>Upload Book</span>
      </div>
      <div className="main-content">
        <DropZone
          onUploadStart={props.onUploadStart}
          onUploadComplete={props.onUploadComplete}
        />
      </div>
    </main>
  );
}

// ── Book detail with data fetching ───────────────

function BookDetailView({
  bookId,
  config,
  models,
  modelsError,
  onRefresh,
  onSubscribeJob,
  onBack,
}: {
  bookId: string;
  config: SystemConfig;
  models: string[];
  modelsError: boolean;
  onRefresh: () => void;
  onSubscribeJob: (jobId: string) => void;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<BookDetailType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const d = await api.bookGet(bookId);
      setDetail(d);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to load book');
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  if (loading && !detail) {
    return <div className="empty-state">Loading book details…</div>;
  }

  if (error) {
    return (
      <div>
        <p style={{ color: 'var(--red)', marginBottom: 12 }}>{error}</p>
        <button className="btn btn-secondary" onClick={onBack}>← Back</button>
      </div>
    );
  }

  if (!detail) return null;

  return (
    <BookDetail
      detail={detail}
      config={config}
      models={models}
      modelsError={modelsError}
      onRefresh={() => { onRefresh(); load(); }}
      onSubscribeJob={onSubscribeJob}
      onDelete={onBack}
    />
  );
}
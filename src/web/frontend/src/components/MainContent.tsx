import { useState, useCallback, useEffect } from 'react';
import { DropZone } from './DropZone';
import { BookDetail } from './BookDetail';
import { JobsView } from './JobsView';
import { api } from '../api';
import type { BookRecord, BookDetail as BookDetailType, SystemConfig, TranslationJob } from '../types';
import type { Route } from '../hooks/useHashRoute';

interface MainContentProps {
  route: Route;
  books: BookRecord[];
  config: SystemConfig;
  models: string[];
  modelsError: boolean;
  jobs: TranslationJob[];
  onNavigate: (route: Route) => void;
  onSelectBook: (bookId: string | null) => void;
  onRefresh: () => void;
  onSubscribeJob: (jobId: string) => void;
  onUploadStart: (jobId: string) => void;
  onUploadComplete: (bookId: string) => void;
}

export function MainContent(props: MainContentProps) {
  const { route } = props;

  // Breadcrumb rendering
  const renderBreadcrumb = () => {
    if (route.view === 'library') {
      return (
        <div className="breadcrumb">
          <span className="breadcrumb-item active">📖 Library</span>
        </div>
      );
    }
    if (route.view === 'jobs') {
      return (
        <div className="breadcrumb">
          <button className="breadcrumb-link" onClick={() => props.onNavigate({ view: 'library' })}>
            📖 Library
          </button>
          <span className="breadcrumb-sep">/</span>
          <span className="breadcrumb-item active">⚙️ Jobs</span>
        </div>
      );
    }
    // detail view
    const book = props.books.find(b => b.id === route.bookId);
    return (
      <div className="breadcrumb">
        <button className="breadcrumb-link" onClick={() => props.onNavigate({ view: 'library' })}>
          📖 Library
        </button>
        <span className="breadcrumb-sep">/</span>
        <span className="breadcrumb-item active">
          {book?.title || 'Book details'}
        </span>
      </div>
    );
  };

  if (route.view === 'detail') {
    return (
      <main className="main">
        <div className="main-header">
          <button className="btn btn-secondary btn-sm" onClick={() => props.onNavigate({ view: 'library' })}>
            ← Back
          </button>
          {renderBreadcrumb()}
        </div>
        <div className="main-content">
          <BookDetailView
            bookId={route.bookId}
            config={props.config}
            models={props.models}
            modelsError={props.modelsError}
            onRefresh={props.onRefresh}
            onSubscribeJob={props.onSubscribeJob}
            onBack={() => props.onNavigate({ view: 'library' })}
          />
        </div>
      </main>
    );
  }

  if (route.view === 'jobs') {
    return (
      <main className="main">
        <div className="main-header">
          {renderBreadcrumb()}
        </div>
        <div className="main-content">
          <JobsView
            jobs={props.jobs}
            onRefresh={props.onRefresh}
            onSubscribeJob={props.onSubscribeJob}
          />
        </div>
      </main>
    );
  }

  // Library view: drop zone + book cards grid
  return (
    <main className="main">
      <div className="main-header">
        {renderBreadcrumb()}
        <span className="main-header-count">
          {props.books.length} book{props.books.length !== 1 ? 's' : ''}
        </span>
      </div>
      <div className="main-content">
        <DropZone
          onUploadStart={props.onUploadStart}
          onUploadComplete={props.onUploadComplete}
        />
        {props.books.length > 0 && (
          <div className="books-grid">
            {props.books.map((book) => (
              <BookCard
                key={book.id}
                book={book}
                onClick={() => props.onSelectBook(book.id)}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

// ── Book card for library grid ───────────────────

function BookCard({ book, onClick }: { book: BookRecord; onClick: () => void }) {
  const total = book.totalBlocks || 0;
  const translated = book.translatedBlocks || 0;
  const pct = total > 0 ? Math.round((translated / total) * 100) : 0;
  const isComplete = book.completedAt !== null;
  const isTranslating = translated > 0 && !isComplete;
  const isParsing = book.status === 'parsing';
  const parsePct = book.totalPages > 0 ? Math.round((book.parsedPages / book.totalPages) * 100) : 0;
  const ext = book.filename?.split('.').pop()?.toUpperCase() || '?';

  return (
    <div className={`book-card ${isComplete ? 'completed' : ''}`} onClick={onClick}>
      <div className="book-card-top">
        <div className="book-card-format">{ext}</div>
        {isComplete ? (
          <span className="badge completed">✓ done</span>
        ) : isParsing ? (
          <span className="badge translating">parsing {parsePct}%</span>
        ) : isTranslating ? (
          <span className="badge translating">{pct}%</span>
        ) : (
          <span className="badge queued">parsed</span>
        )}
      </div>
      <div className="book-card-title">{book.title || book.filename}</div>
      <div className="book-card-author">{book.author || 'Unknown author'}</div>
      <div className="book-card-stats">
        <span>📄 {total}</span>
        <span>✅ {translated}</span>
        <span>🌍 {book.language || '?'}</span>
        {book.targetLang && <span>→ {book.targetLang}</span>}
      </div>
      {(translated > 0 || isParsing) && (
        <div className="mini-bar">
          <div
            className={`mini-bar-fill ${isComplete ? 'completed' : ''}`}
            style={{ width: `${isParsing ? parsePct : pct}%` }}
          />
        </div>
      )}
    </div>
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
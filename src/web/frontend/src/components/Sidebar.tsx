import type { BookRecord } from '../types';

interface SidebarProps {
  books: BookRecord[];
  loading: boolean;
  selectedBookId: string | null;
  onSelectBook: (bookId: string | null) => void;
  onRefresh: () => void;
  connected: boolean;
  modelsCount: number;
  modelsError: boolean;
  onUploadClick: () => void;
  currentView: 'library' | 'detail' | 'jobs';
  onNavigate: (path: string) => void;
}

export function Sidebar({
  books,
  loading,
  selectedBookId,
  onSelectBook,
  connected,
  modelsCount,
  modelsError,
  onUploadClick,
  currentView,
  onNavigate,
}: SidebarProps) {
  // Count active jobs (parsing/translating) for badge
  const activeCount = books.filter(b => b.status === 'parsing' || (b.translatedBlocks > 0 && !b.completedAt)).length;

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1>📚 AI Translate</h1>
        <div className="subtitle">EPUB & FB2 & PDF Translator</div>
      </div>

      {/* Navigation tabs */}
      <nav className="sidebar-nav">
        <button
          className={`nav-tab ${currentView === 'library' ? 'active' : ''}`}
          onClick={() => onNavigate('/')}
        >
          <span className="nav-icon">📖</span>
          <span>Library</span>
          {books.length > 0 && <span className="nav-badge">{books.length}</span>}
        </button>
        <button
          className={`nav-tab ${currentView === 'jobs' ? 'active' : ''}`}
          onClick={() => onNavigate('/jobs')}
        >
          <span className="nav-icon">⚙️</span>
          <span>Jobs</span>
          {activeCount > 0 && <span className="nav-badge active">{activeCount}</span>}
        </button>
      </nav>

      <div className="sidebar-upload">
        <button className="upload-btn" onClick={onUploadClick}>
          ⬆ Upload Book
        </button>
        <div className="api-status">
          <div className={`api-dot ${modelsError ? 'err' : 'ok'}`} />
          <span>
            {modelsError
              ? 'API unavailable'
              : `API connected — ${modelsCount} model(s)`}
          </span>
        </div>
      </div>

      <div className="sidebar-list">
        {loading && books.length === 0 ? (
          <div className="empty-state">Loading…</div>
        ) : books.length === 0 ? (
          <div className="empty-state">
            No books yet
            <br />
            <span style={{ fontSize: 12, opacity: 0.7 }}>
              Upload or drag a file →
            </span>
          </div>
        ) : (
          books.map((book) => (
            <BookListItem
              key={book.id}
              book={book}
              active={book.id === selectedBookId}
              onClick={() => onSelectBook(book.id)}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function BookListItem({
  book,
  active,
  onClick,
}: {
  book: BookRecord;
  active: boolean;
  onClick: () => void;
}) {
  const total = book.totalBlocks || 0;
  const translated = book.translatedBlocks || 0;
  const pct = total > 0 ? Math.round((translated / total) * 100) : 0;
  const isComplete = book.completedAt !== null;
  const isTranslating = translated > 0 && !isComplete;
  const isParsing = book.status === 'parsing';
  const parsePct = book.totalPages > 0 ? Math.round((book.parsedPages / book.totalPages) * 100) : 0;

  const className = `book-item ${active ? 'active' : ''} ${
    isComplete ? 'completed' : isTranslating ? 'translating' : isParsing ? 'translating' : ''
  }`;

  return (
    <div className={className} onClick={onClick}>
      <div className="book-item-top">
        <div className="book-item-title">{book.title || book.filename}</div>
        {isComplete ? (
          <span className="badge completed">done</span>
        ) : isParsing ? (
          <span className="badge translating">parsing {parsePct}%</span>
        ) : isTranslating ? (
          <span className="badge translating">translating</span>
        ) : (
          <span className="badge queued">parsed</span>
        )}
      </div>
      <div className="book-item-author">{book.author || 'Unknown author'}</div>
      <div className="book-item-stats">
        <span>📄 {total}</span>
        <span>✅ {translated}</span>
        <span>🌍 {book.language || '?'}</span>
      </div>
      {isParsing && book.totalPages > 0 && (
        <div className="mini-bar">
          <div
            className="mini-bar-fill"
            style={{ width: `${parsePct}%` }}
          />
        </div>
      )}
      {translated > 0 && !isParsing && (
        <div className="mini-bar">
          <div
            className={`mini-bar-fill ${isComplete ? 'completed' : ''}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}
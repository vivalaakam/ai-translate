import { useState, useCallback, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { MainContent } from './components/MainContent';
import { UploadOverlay } from './components/UploadOverlay';
import { useWebSocket } from './hooks/useWebSocket';
import { useBooks, useConfig, useModels } from './hooks/useBooks';
import { api } from './api';
import type { TranslationJob } from './types';

export type View = 'library' | 'detail';

export function App() {
  const [view, setView] = useState<View>('library');
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);
  const [jobUpdate, setJobUpdate] = useState<TranslationJob | null>(null);
  const [uploadJobId, setUploadJobId] = useState<string | null>(null);

  const { connected, subscribe } = useWebSocket((job) => {
    setJobUpdate(job);
  });

  const { books, loading, refresh } = useBooks(jobUpdate);
  const config = useConfig();
  const { models, error: modelsError } = useModels();

  const handleJobUpdate = useCallback((jobId: string) => {
    subscribe(jobId);
  }, [subscribe]);

  const selectBook = useCallback((bookId: string | null) => {
    setSelectedBookId(bookId);
    setView(bookId ? 'detail' : 'library');
  }, []);

  // When a job update arrives for the selected book, refresh books
  useEffect(() => {
    if (jobUpdate) {
      refresh();
    }
  }, [jobUpdate, refresh]);

  const handleUploadComplete = useCallback((bookId: string) => {
    refresh();
    selectBook(bookId);
    setUploadJobId(null);
  }, [refresh, selectBook]);

  return (
    <div className="app">
      <Sidebar
        books={books}
        loading={loading}
        selectedBookId={selectedBookId}
        onSelectBook={selectBook}
        onRefresh={refresh}
        connected={connected}
        modelsCount={models.length}
        modelsError={modelsError}
        onUploadClick={() => {
          setSelectedBookId(null);
          setView('library');
        }}
      />
      <MainContent
        view={view}
        selectedBookId={selectedBookId}
        books={books}
        config={config}
        models={models}
        modelsError={modelsError}
        onSelectBook={selectBook}
        onRefresh={refresh}
        onSubscribeJob={handleJobUpdate}
        onUploadStart={(jobId) => {
          setUploadJobId(jobId);
          subscribe(jobId);
        }}
        onUploadComplete={handleUploadComplete}
      />
      {uploadJobId && <UploadOverlay jobId={uploadJobId} onComplete={handleUploadComplete} />}
    </div>
  );
}
import { useState, useCallback, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { MainContent } from './components/MainContent';
import { UploadOverlay } from './components/UploadOverlay';
import { useWebSocket } from './hooks/useWebSocket';
import { useBooks, useConfig, useModels } from './hooks/useBooks';
import { api } from './api';
import type { TranslationJob } from './types';

export type View = 'library' | 'detail' | 'jobs';

export function App() {
  const [view, setView] = useState<View>('library');
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);
  const [jobUpdate, setJobUpdate] = useState<TranslationJob | null>(null);
  const [uploadJobId, setUploadJobId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<TranslationJob[]>([]);

  const { connected, subscribe } = useWebSocket((job) => {
    setJobUpdate(job);
    // Refresh jobs list when a job update arrives
    if (view === 'jobs') {
      api.jobList().then((data) => setJobs(data.jobs || [])).catch(() => {});
    }
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

  // When a job update arrives, refresh books
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

  const handleNavigate = useCallback((newView: View) => {
    setSelectedBookId(null);
    setView(newView);
    if (newView === 'jobs') {
      api.jobList().then((data) => setJobs(data.jobs || [])).catch(() => {});
    }
  }, []);

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
        currentView={view}
        onNavigate={handleNavigate}
      />
      <MainContent
        view={view}
        selectedBookId={selectedBookId}
        books={books}
        config={config}
        models={models}
        modelsError={modelsError}
        jobs={jobs}
        onNavigate={handleNavigate}
        onRefresh={refresh}
        onSubscribeJob={handleJobUpdate}
        onUploadStart={(jobId) => {
          setUploadJobId(jobId);
          subscribe(jobId);
        }}
        onUploadComplete={handleUploadComplete}
        onSelectBook={selectBook}
      />
      {uploadJobId && <UploadOverlay jobId={uploadJobId} onComplete={handleUploadComplete} />}
    </div>
  );
}
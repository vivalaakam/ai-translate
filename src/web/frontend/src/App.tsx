import { useState, useCallback, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { MainContent } from './components/MainContent';
import { UploadOverlay } from './components/UploadOverlay';
import { useWebSocket } from './hooks/useWebSocket';
import { useBooks, useConfig, useModels } from './hooks/useBooks';
import { useHashRoute, type Route } from './hooks/useHashRoute';
import { api } from './api';
import type { TranslationJob } from './types';

export function App() {
  const { route, navigate } = useHashRoute();
  const [jobUpdate, setJobUpdate] = useState<TranslationJob | null>(null);
  const [uploadJobId, setUploadJobId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<TranslationJob[]>([]);

  const { connected, subscribe } = useWebSocket((job) => {
    setJobUpdate(job);
    // Refresh jobs list when a job update arrives and we're on the jobs view
    if (route.view === 'jobs') {
      api.jobList().then((data) => setJobs(data.jobs || [])).catch(() => {});
    }
  });

  const { books, loading, refresh } = useBooks(jobUpdate);
  const config = useConfig();
  const { models, error: modelsError } = useModels();

  const handleJobUpdate = useCallback((jobId: string) => {
    subscribe(jobId);
  }, [subscribe]);

  // Navigate helpers
  const selectBook = useCallback((bookId: string | null) => {
    if (bookId) {
      navigate({ view: 'detail', bookId });
    } else {
      navigate({ view: 'library' });
    }
  }, [navigate]);

  const handleNavigate = useCallback((newRoute: Route) => {
    navigate(newRoute);
    if (newRoute.view === 'jobs') {
      api.jobList().then((data) => setJobs(data.jobs || [])).catch(() => {});
    }
  }, [navigate]);

  // When a job update arrives, refresh books
  useEffect(() => {
    if (jobUpdate) {
      refresh();
    }
  }, [jobUpdate, refresh]);

  const handleUploadComplete = useCallback((bookId: string) => {
    refresh();
    if (bookId) {
      navigate({ view: 'detail', bookId });
    } else {
      navigate({ view: 'library' });
    }
    setUploadJobId(null);
  }, [refresh, navigate]);

  // Derive display values from route
  const view = route.view;
  const selectedBookId = route.view === 'detail' ? route.bookId : null;

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
        onUploadClick={() => navigate({ view: 'library' })}
        currentView={view}
        onNavigate={handleNavigate}
      />
      <MainContent
        route={route}
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
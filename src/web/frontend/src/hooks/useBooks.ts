import { useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import type { BookRecord, SystemConfig, TranslationJob } from '../types';

export function useBooks(jobUpdates: TranslationJob | null) {
  const [books, setBooks] = useState<BookRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api.bookList();
      setBooks(data.books || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Refresh books when a job update arrives
  useEffect(() => {
    if (jobUpdates) refresh();
  }, [jobUpdates, refresh]);

  return { books, loading, refresh };
}

export function useConfig() {
  const [config, setConfig] = useState<SystemConfig>({
    uploadOnly: false,
    defaultModel: '',
    defaultProvider: '',
  });

  useEffect(() => {
    api.systemConfig().then(setConfig).catch(() => {});
  }, []);

  return config;
}

export function useModels() {
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    api.modelList()
      .then((data) => setModels(data.models || []))
      .catch(() => setError(true));
  }, []);

  return { models, error };
}
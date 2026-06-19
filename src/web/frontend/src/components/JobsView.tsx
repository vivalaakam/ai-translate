import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import type { TranslationJob } from '../types';

interface JobsViewProps {
  jobs: TranslationJob[];
  onRefresh: () => void;
  onSubscribeJob: (jobId: string) => void;
}

export function JobsView({ jobs, onSubscribeJob }: JobsViewProps) {
  const [localJobs, setLocalJobs] = useState<TranslationJob[]>(jobs);

  useEffect(() => {
    setLocalJobs(jobs);
  }, [jobs]);

  const refreshJobs = useCallback(async () => {
    try {
      const data = await api.jobList();
      setLocalJobs(data.jobs || []);
    } catch {
      // ignore
    }
  }, []);

  // Auto-refresh every 3 seconds when there are active jobs
  useEffect(() => {
    const hasActive = localJobs.some(j =>
      j.status === 'queued' || j.status === 'parsing' || j.status === 'translating' || j.status === 'assembling'
    );
    if (!hasActive) return;
    const interval = setInterval(refreshJobs, 3000);
    return () => clearInterval(interval);
  }, [localJobs, refreshJobs]);

  if (localJobs.length === 0) {
    return (
      <div className="empty-state" style={{ padding: 60 }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>⚙️</div>
        <div>No jobs yet</div>
        <div style={{ fontSize: 12, marginTop: 8, opacity: 0.7 }}>
          Upload a book and start a translation to see jobs here
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="jobs-header">
        <h3>Active Jobs</h3>
        <button className="btn-sm btn-secondary" onClick={refreshJobs}>↻ Refresh</button>
      </div>
      <div className="jobs-list">
        {localJobs.map((job) => (
          <JobCard key={job.id} job={job} />
        ))}
      </div>
    </div>
  );
}

function JobCard({ job }: { job: TranslationJob }) {
  const statusClass = `job-status ${job.status}`;
  const isActive = job.status === 'queued' || job.status === 'parsing' ||
    job.status === 'translating' || job.status === 'assembling';

  return (
    <div className={`card job-card ${job.status}`}>
      <div className="job-card-header">
        <div className="job-filename">{job.originalFilename}</div>
        <span className={`badge ${job.status}`}>
          {job.status}
        </span>
      </div>
      <div className="job-meta">
        {job.targetLang && <span>→ {job.targetLang}</span>}
        {job.sourceLang && <span>from: {job.sourceLang}</span>}
        {job.model && <span>🤖 {job.model}</span>}
        {job.metadata?.title && <span className="job-book-title">📖 {job.metadata.title}</span>}
      </div>
      <div className="job-message">{job.message || '—'}</div>
      {isActive && (
        <div className="progress-bar" style={{ marginTop: 8 }}>
          <div
            className={`progress-fill ${job.status === 'failed' ? 'failed' : ''}`}
            style={{ width: `${job.progress}%` }}
          />
        </div>
      )}
      {job.progress > 0 && (
        <div className="progress-text" style={{ marginTop: 4 }}>
          <span>{job.progress}%</span>
        </div>
      )}
      {job.error && (
        <div className="job-error">{job.error}</div>
      )}
    </div>
  );
}
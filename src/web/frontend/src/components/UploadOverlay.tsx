import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';

interface UploadOverlayProps {
  jobId: string;
  onComplete: (bookId: string) => void;
}

export function UploadOverlay({ jobId, onComplete }: UploadOverlayProps) {
  const [message, setMessage] = useState('Uploading & parsing book…');

  const poll = useCallback(async () => {
    let attempts = 0;
    const check = async () => {
      attempts++;
      try {
        const job = await api.jobGet(jobId);
        if (job.message) setMessage(job.message);

        if (job.status === 'completed' || job.status === 'failed') {
          if (job.status === 'failed') {
            setMessage('Upload failed: ' + (job.error || 'Unknown error'));
            setTimeout(() => onComplete(''), 2000);
            return;
          }
          // Find the book
          const books = await api.bookList();
          const book = books.books.find((b) => b.filename === job.originalFilename);
          if (book) {
            onComplete(book.id);
          } else {
            onComplete('');
          }
          return;
        }
        if (attempts < 120) setTimeout(check, 1000);
      } catch {
        if (attempts < 120) setTimeout(check, 2000);
      }
    };
    setTimeout(check, 500);
  }, [jobId, onComplete]);

  useEffect(() => {
    poll();
  }, [poll]);

  return (
    <div className="overlay">
      <div className="overlay-card">
        <div className="icon"><span className="spinner-icon">⏳</span></div>
        <div className="text">{message}</div>
      </div>
    </div>
  );
}
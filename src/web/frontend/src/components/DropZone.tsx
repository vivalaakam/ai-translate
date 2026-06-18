import { useState, useCallback, useRef } from 'react';
import { api } from '../api';

interface DropZoneProps {
  onUploadStart: (jobId: string) => void;
  onUploadComplete: (bookId: string) => void;
}

export function DropZone({ onUploadStart, onUploadComplete }: DropZoneProps) {
  const [dragover, setDragover] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext !== 'epub' && ext !== 'fb2') {
      setError('Only .epub and .fb2 files are supported');
      return;
    }
    setError(null);
    setUploading(true);

    try {
      const result = await api.bookUpload(file);
      onUploadStart(result.jobId);
      pollJob(result.jobId, onUploadComplete);
    } catch (err: any) {
      setError(err.message || 'Upload failed');
      setUploading(false);
    }
  }, [onUploadStart, onUploadComplete]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragover(false);
    if (e.dataTransfer.files.length) {
      handleFile(e.dataTransfer.files[0]);
    }
  }, [handleFile]);

  const labelClick = !uploading ? 'Click to upload' : '';
  const labelDrag = !uploading ? ' or drag and drop your EPUB/FB2 file' : '';
  const labelText = uploading ? 'Uploading and parsing...' : '';

  return (
    <div>
      <div
        className={`drop-zone ${dragover ? 'dragover' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragover(true); }}
        onDragLeave={() => setDragover(false)}
        onDrop={handleDrop}
        onClick={() => { if (!uploading) fileInputRef.current?.click(); }}
      >
        <div className="icon">{uploading ? '⏳' : '📄'}</div>
        <div className="label">
          {uploading ? (
            labelText
          ) : (
            <span><strong>{labelClick}</strong>{labelDrag}</span>
          )}
        </div>
        <div className="hint">Supported formats: .epub, .fb2</div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".epub,.fb2"
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files && e.target.files.length) handleFile(e.target.files[0]);
          }}
        />
      </div>

      {error && (
        <div className="card" style={{ borderColor: 'var(--red)', marginTop: 16 }}>
          <p style={{ color: 'var(--red)', fontSize: 14 }}>{error}</p>
        </div>
      )}
    </div>
  );
}

async function pollJob(jobId: string, onComplete: (bookId: string) => void) {
  let attempts = 0;
  const poll = async () => {
    attempts++;
    try {
      const job = await api.jobGet(jobId);
      if (job.status === 'completed' || job.status === 'failed') {
        if (job.status === 'failed') return;
        const books = await api.bookList();
        const book = books.books.find((b) => b.filename === job.originalFilename);
        if (book) {
          onComplete(book.id);
        }
        return;
      }
      if (attempts < 120) {
        setTimeout(poll, 1000);
      }
    } catch {
      if (attempts < 120) {
        setTimeout(poll, 2000);
      }
    }
  };
  setTimeout(poll, 500);
}
import React from 'react';
import { CheckCircle2, Download, X } from 'lucide-react';
import type { ReadyMp4Download } from '../types';
import { apiUrl } from '../utils/api';

interface ReadyMp4BannerProps {
  readyDownload: ReadyMp4Download | null;
  onDismiss: () => void;
}

export const ReadyMp4Banner: React.FC<ReadyMp4BannerProps> = ({
  readyDownload,
  onDismiss,
}) => {
  if (!readyDownload) return null;

  const sizeLabel =
    readyDownload.fileSizeBytes && readyDownload.fileSizeBytes > 0
      ? `${(readyDownload.fileSizeBytes / (1024 * 1024)).toFixed(1)} MB`
      : null;

  return (
    <div
      role="status"
      className="flex flex-col gap-3 rounded-xl border border-emerald-500/40 bg-emerald-950/35 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-3 min-w-0">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-emerald-100">
            MP4 Ready to Save{sizeLabel ? ` · ${sizeLabel}` : ''}
          </p>
          <p className="mt-0.5 truncate font-mono text-xs text-emerald-200/90">
            {readyDownload.filename}
          </p>
          <p className="mt-1 text-xs text-emerald-200/80">
            Check your browser Downloads folder (Ctrl+J / Cmd+Shift+J). If the automatic save did
            not start inside the preview frame, click <span className="font-semibold text-white">Save MP4 File</span>.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <a
          href={apiUrl(readyDownload.url)}
          download={readyDownload.filename}
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-4 py-2 text-xs font-bold text-black transition-colors hover:bg-emerald-400 whitespace-nowrap"
        >
          <Download className="h-3.5 w-3.5" />
          <span>Save MP4 File</span>
        </a>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss MP4 ready notice"
          className="rounded-lg p-1.5 text-emerald-300 hover:bg-white/10 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};

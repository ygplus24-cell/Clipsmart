import React, { useRef, useState } from 'react';
import {
  Archive,
  Check,
  CheckCircle2,
  Copy,
  Download,
  FileText,
  Film,
  Loader2,
  Play,
  Send,
  ShieldCheck,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import type { ClipCandidate, Project } from '../types';
import { apiUrl, downloadFileFromUrl } from '../utils/api';
import { formatDurationLabel, formatTimecode } from '../utils/formatters';

interface ExportViewProps {
  project: Project | null;
  onRenderClip: (clipId: string) => Promise<void>;
  onRenderBatch: () => Promise<void>;
  onAttachVideo: (projectId: string, file: File) => Promise<void>;
  onOpenEditor: (clipId: string) => void;
  onToggleApprove?: (clipId: string, approved: boolean) => Promise<void>;
  onGoToPublish?: (clipId: string) => void;
  onCreateNew: () => void;
}

export const ExportView: React.FC<ExportViewProps> = ({
  project,
  onRenderClip,
  onRenderBatch,
  onAttachVideo,
  onOpenEditor,
  onToggleApprove,
  onGoToPublish,
  onCreateNew,
}) => {
  const [batchRendering, setBatchRendering] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [previewClip, setPreviewClip] = useState<ClipCandidate | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const handleDownload = async (key: string, url: string, filename: string) => {
    setDownloadingKey(key);
    setExportError(null);
    try {
      await downloadFileFromUrl(url, filename);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Download failed.');
    } finally {
      setDownloadingKey(null);
    }
  };

  if (!project) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/12 bg-[#12151C] px-6 py-16 text-center">
        <Film className="h-10 w-10 text-gray-500" />
        <h2 className="mt-4 text-lg font-semibold text-white">No Project Ready for Export</h2>
        <p className="mt-1.5 max-w-md text-sm text-gray-400">
          Analyze a video first, select your top viral clips, and render ready-to-post MP4 files
          and SRT subtitles here.
        </p>
        <button
          type="button"
          onClick={onCreateNew}
          className="mt-5 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500"
        >
          Start New Project
        </button>
      </div>
    );
  }

  const selectedClips = project.clips.filter((c) => c.selected);
  const displayClips = selectedClips.length > 0 ? selectedClips : project.clips;
  const renderedCount = displayClips.filter((c) => c.renderStatus === 'completed').length;

  const handleBatch = async () => {
    setBatchRendering(true);
    setExportError(null);
    try {
      await onRenderBatch();
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Batch render failed.');
    } finally {
      setBatchRendering(false);
    }
  };

  const handleAttach = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAttaching(true);
    setExportError(null);
    try {
      await onAttachVideo(project.id, file);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Failed to attach video.');
    } finally {
      setAttaching(false);
    }
  };

  const handleCopySocial = async (clip: ClipCandidate) => {
    const text = `${clip.title}\n\n${clip.socialCaption}\n\n${clip.hashtags.join(' ')}`;
    await navigator.clipboard.writeText(text);
    setCopiedId(clip.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 rounded-xl border border-white/8 bg-[#12151C] p-6 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-xs font-medium text-blue-400">FFmpeg Render & Batch Export</p>
          <h1 className="mt-1 text-xl font-bold text-white">{project.title}</h1>
          <p className="mt-1 text-xs text-gray-400 font-mono tabular-nums">
            {displayClips.length} clips queued · {renderedCount} MP4 files rendered
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          {project.localVideoUrl && (
            <button
              type="button"
              onClick={handleBatch}
              disabled={batchRendering || displayClips.length === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              {batchRendering ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Rendering Batch...</span>
                </>
              ) : (
                <span>Render All Selected MP4s</span>
              )}
            </button>
          )}

          <button
            type="button"
            disabled={downloadingKey === 'zip'}
            onClick={() =>
              handleDownload(
                'zip',
                `/api/projects/${project.id}/export-zip`,
                `${project.title
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, '-')
                  .slice(0, 40) || 'clipgenius'}-export.zip`
              )
            }
            className="inline-flex items-center gap-2 rounded-lg border border-white/12 bg-[#171B24] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#202634] disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            {downloadingKey === 'zip' ? (
              <Loader2 className="h-4 w-4 animate-spin text-amber-400" />
            ) : (
              <Archive className="h-4 w-4 text-amber-400" />
            )}
            <span>
              {downloadingKey === 'zip'
                ? 'Preparing ZIP...'
                : 'Download Package (.ZIP)'}
            </span>
          </button>
        </div>
      </div>

      {/* Attach Video Banner if YouTube-only */}
      {!project.localVideoUrl && (
        <div className="flex flex-col gap-4 rounded-xl border border-amber-500/25 bg-[#151820] p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-white">
              Attach Authorized Source Video for MP4 Rendering
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-gray-300">
              Your YouTube analysis, viral scores, social captions, and .SRT subtitles are ready to
              export in the ZIP package. To cut and burn animated captions into finished MP4 files
              with FFmpeg, attach your authorized video file below.
            </p>
          </div>
          <div className="shrink-0">
            <input
              ref={fileRef}
              type="file"
              accept="video/*"
              onChange={handleAttach}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={attaching}
              className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2.5 text-xs font-semibold text-black hover:bg-amber-400 whitespace-nowrap"
            >
              {attaching ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              <span>{attaching ? 'Uploading...' : 'Attach Video File'}</span>
            </button>
          </div>
        </div>
      )}

      {exportError && (
        <div
          role="alert"
          className="rounded-lg border border-rose-500/30 bg-rose-950/40 px-4 py-3 text-sm text-rose-200"
        >
          {exportError}
        </div>
      )}

      {/* Export Queue List */}
      <div className="divide-y divide-white/8 overflow-hidden rounded-xl border border-white/8 bg-[#12151C]">
        {displayClips.map((clip) => (
          <div
            key={clip.id}
            className="flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between"
          >
            <div className="flex items-center gap-4 min-w-0 flex-1">
              <div className="relative h-20 w-32 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-[#0B0D12]">
                {clip.thumbnailUrl ? (
                  <img
                    src={apiUrl(clip.thumbnailUrl)}
                    alt={clip.title}
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-gray-600">
                    <Film className="h-5 w-5" />
                  </div>
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
                  <span className="font-mono font-semibold text-gray-200 tabular-nums">
                    Clip {String(clip.index).padStart(2, '0')}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">{clip.outputFormat}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    {formatTimecode(clip.startSeconds)}–{formatTimecode(clip.endSeconds)} (
                    {formatDurationLabel(clip.durationSeconds)})
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono text-amber-400 tabular-nums">
                    {clip.score.total}/100
                  </span>
                </div>

                <h3 className="mt-1 truncate text-sm font-semibold text-white">
                  {clip.title}
                </h3>

                {/* Explicit Render Status */}
                <div className="mt-1.5 flex items-center gap-2 text-xs">
                  {clip.renderStatus === 'completed' && (
                    <span className="inline-flex items-center gap-1.5 text-emerald-400">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span>MP4 Ready for Download</span>
                    </span>
                  )}
                  {clip.renderStatus === 'rendering' && (
                    <span className="inline-flex items-center gap-1.5 text-blue-400">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Encoding H.264 + Burning Subtitles...</span>
                    </span>
                  )}
                  {clip.renderStatus === 'failed' && (
                    <span className="inline-flex items-center gap-1.5 text-rose-400">
                      <TriangleAlert className="h-3.5 w-3.5" />
                      <span>{clip.renderError || 'Render failed'}</span>
                    </span>
                  )}
                  {clip.renderStatus === 'idle' && (
                    <span className="text-gray-400">
                      {project.localVideoUrl
                        ? 'Ready to render MP4'
                        : 'SRT & Social Copy ready (attach video for MP4)'}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => handleCopySocial(clip)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#171B24] px-3 py-2 text-xs font-medium text-gray-200 hover:bg-[#202634] whitespace-nowrap"
              >
                {copiedId === clip.id ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                <span>{copiedId === clip.id ? 'Copied' : 'Copy Caption'}</span>
              </button>

              <button
                type="button"
                disabled={downloadingKey === `srt_${clip.id}`}
                onClick={() =>
                  handleDownload(
                    `srt_${clip.id}`,
                    `/api/projects/${project.id}/clips/${clip.id}/srt`,
                    `clip-${clip.index}-subtitles.srt`
                  )
                }
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#171B24] px-3 py-2 text-xs font-medium text-gray-200 hover:bg-[#202634] disabled:opacity-50 whitespace-nowrap"
              >
                <FileText className="h-3.5 w-3.5" />
                <span>.SRT</span>
              </button>

              <button
                type="button"
                onClick={() => onOpenEditor(clip.id)}
                className="rounded-lg border border-white/10 bg-[#171B24] px-3 py-2 text-xs font-medium text-gray-200 hover:bg-[#202634] whitespace-nowrap"
              >
                Edit
              </button>

              {project.localVideoUrl && (
                <button
                  type="button"
                  onClick={() => onRenderClip(clip.id)}
                  disabled={clip.renderStatus === 'rendering'}
                  className="rounded-lg bg-blue-600/20 px-3 py-2 text-xs font-semibold text-blue-300 hover:bg-blue-600/30 disabled:opacity-50 whitespace-nowrap"
                >
                  {clip.renderStatus === 'completed' ? 'Re-render MP4' : 'Render MP4'}
                </button>
              )}

              {clip.renderStatus === 'completed' && clip.renderedVideoUrl && (
                <>
                  <button
                    type="button"
                    onClick={() => setPreviewClip(clip)}
                    className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-[#1A1F2B] px-3 py-2 text-xs font-medium text-white hover:bg-[#242B3B] whitespace-nowrap"
                  >
                    <Play className="h-3.5 w-3.5" />
                    <span>Preview</span>
                  </button>
                  <button
                    type="button"
                    disabled={downloadingKey === `mp4_${clip.id}`}
                    onClick={() =>
                      handleDownload(
                        `mp4_${clip.id}`,
                        clip.renderedVideoUrl!,
                        `clip-${clip.index}.mp4`
                      )
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 whitespace-nowrap"
                  >
                    {downloadingKey === `mp4_${clip.id}` ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    <span>
                      {downloadingKey === `mp4_${clip.id}`
                        ? 'Downloading...'
                        : 'Download MP4'}
                    </span>
                  </button>
                </>
              )}

              {onToggleApprove && (
                <button
                  type="button"
                  onClick={() => onToggleApprove(clip.id, !clip.approved)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold whitespace-nowrap ${
                    clip.approved
                      ? 'border border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25'
                      : 'border border-white/12 bg-[#171B24] text-gray-200 hover:bg-[#222836]'
                  }`}
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  <span>{clip.approved ? 'Approved' : 'Approve'}</span>
                </button>
              )}

              {onGoToPublish && (
                <button
                  type="button"
                  onClick={() => onGoToPublish(clip.id)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-blue-500/40 bg-blue-500/15 px-3 py-2 text-xs font-semibold text-blue-200 hover:bg-blue-500/25 whitespace-nowrap"
                >
                  <Send className="h-3.5 w-3.5" />
                  <span>Publish</span>
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Rendered MP4 Preview Modal */}
      {previewClip && previewClip.renderedVideoUrl && (
        <div
          onClick={() => setPreviewClip(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-xl border border-white/15 bg-[#12151C] p-5 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="truncate text-sm font-semibold text-white">
                {previewClip.title}
              </h3>
              <button
                type="button"
                onClick={() => setPreviewClip(null)}
                className="text-xs text-gray-400 hover:text-white"
              >
                Close
              </button>
            </div>
            <video
              src={apiUrl(previewClip.renderedVideoUrl)}
              controls
              autoPlay
              className="mt-4 max-h-[70vh] w-full rounded-lg bg-black"
            />
          </div>
        </div>
      )}
    </div>
  );
};

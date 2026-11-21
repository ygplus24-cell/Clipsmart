import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Download,
  Film,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  Upload,
  Volume2,
  VolumeX,
  Wand2,
  Youtube,
} from 'lucide-react';
import type {
  AppSettings,
  AspectRatioFormat,
  ClipCandidate,
  ExportQualityMode,
  Project,
  ReadyMp4Download,
  SubtitleStylePreset,
  TargetPlatform,
} from '../types';
import {
  apiUrl,
  buildClipDownloadFilename,
  isClipRenderedForQuality,
} from '../utils/api';
import {
  formatDurationLabel,
  formatPlatformName,
  formatTimecode,
} from '../utils/formatters';
import { ReadyMp4Banner } from './ReadyMp4Banner';

interface ClipEditorViewProps {
  project: Project | null;
  activeClipId: string | null;
  appSettings: AppSettings;
  exportQuality: ExportQualityMode;
  readyMp4Download: ReadyMp4Download | null;
  isProjectSyncedOnServer: boolean;
  onDismissReadyMp4: () => void;
  onMarkDirectMp4Download: (clip: ClipCandidate, quality?: ExportQualityMode) => void;
  onChangeExportQuality: (quality: ExportQualityMode) => void;
  onSelectClip: (clipId: string) => void;
  onSaveClip: (clipId: string, patch: Partial<ClipCandidate>) => Promise<void>;
  onRenderClip: (clipId: string, quality?: ExportQualityMode) => Promise<void>;
  onDownloadClip: (clip: ClipCandidate, quality?: ExportQualityMode) => Promise<void>;
  onRegenerateCopy: (clipId: string) => Promise<void>;
  onAttachVideo: (projectId: string, file: File) => Promise<void>;
  onGoToExport: () => void;
  onGoToPublish?: (clipId: string) => void;
  onGoToNewProject: () => void;
}

export const ClipEditorView: React.FC<ClipEditorViewProps> = ({
  project,
  activeClipId,
  appSettings,
  exportQuality,
  readyMp4Download,
  isProjectSyncedOnServer,
  onDismissReadyMp4,
  onMarkDirectMp4Download,
  onChangeExportQuality,
  onSelectClip,
  onSaveClip,
  onRenderClip,
  onDownloadClip,
  onRegenerateCopy,
  onAttachVideo,
  onGoToExport,
  onGoToPublish,
  onGoToNewProject,
}) => {
  const activeClip = useMemo(() => {
    if (!project || project.clips.length === 0) return null;
    return (
      project.clips.find((c) => c.id === activeClipId) || project.clips[0]
    );
  }, [project, activeClipId]);

  const [draft, setDraft] = useState<ClipCandidate | null>(activeClip);
  const [captionPlatform, setCaptionPlatform] = useState<TargetPlatform>('tiktok');
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savedFlag, setSavedFlag] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [youtubeEmbedMode, setYoutubeEmbedMode] = useState(false);
  const [downloadingMp4, setDownloadingMp4] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const attachInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (activeClip) {
      setDraft(activeClip);
      setCurrentTime(activeClip.startSeconds);
      setIsPlaying(false);
      setYoutubeEmbedMode(false);
      setEditorError(null);
      if (videoRef.current) {
        videoRef.current.currentTime = activeClip.startSeconds;
      }
    }
  }, [activeClip?.id]);

  // Sync server-driven updates (regenerated AI copy & FFmpeg render status)
  useEffect(() => {
    if (!activeClip) return;
    setDraft((prev) => {
      if (!prev || prev.id !== activeClip.id) return activeClip;
      return {
        ...prev,
        title: activeClip.title,
        openingHook: activeClip.openingHook,
        socialCaption: activeClip.socialCaption,
        platformCaptions: activeClip.platformCaptions,
        hashtags: activeClip.hashtags,
        renderStatus: activeClip.renderStatus,
        renderedVideoUrl: activeClip.renderedVideoUrl,
        renderError: activeClip.renderError,
        approved: activeClip.approved,
        approvedAt: activeClip.approvedAt,
      };
    });
  }, [
    activeClip?.id,
    activeClip?.title,
    activeClip?.openingHook,
    activeClip?.renderStatus,
    activeClip?.renderedVideoUrl,
    activeClip?.renderError,
    activeClip?.approved,
    activeClip?.approvedAt,
  ]);

  // Simulated playback clock when previewing YouTube or without local <video>
  useEffect(() => {
    if (!draft || !isPlaying || project?.localVideoUrl) return;
    const interval = window.setInterval(() => {
      setCurrentTime((prev) => {
        const next = prev + 0.2;
        if (next >= draft.endSeconds) {
          return draft.startSeconds;
        }
        return next;
      });
    }, 200);
    return () => window.clearInterval(interval);
  }, [isPlaying, draft?.startSeconds, draft?.endSeconds, project?.localVideoUrl]);

  if (!project || !draft) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/12 bg-[#12151C] px-6 py-16 text-center">
        <Film className="h-10 w-10 text-gray-500" />
        <h2 className="mt-4 text-lg font-semibold text-white">No Clip Available to Edit</h2>
        <p className="mt-1.5 max-w-md text-sm text-gray-400">
          Analyze a YouTube link or upload a video first so detected viral clips appear in the
          studio editor.
        </p>
        <button
          type="button"
          onClick={onGoToNewProject}
          className="mt-5 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500"
        >
          Start New Project
        </button>
      </div>
    );
  }

  const maxTimeline = Math.max(
    project.videoDurationSeconds || draft.endSeconds + 15,
    draft.endSeconds + 5
  );

  const hasUnsavedRenderEdits = Boolean(
    activeClip &&
      (draft.startSeconds !== activeClip.startSeconds ||
        draft.endSeconds !== activeClip.endSeconds ||
        draft.speakerCenterX !== activeClip.speakerCenterX ||
        draft.outputFormat !== activeClip.outputFormat ||
        draft.subtitleStyle !== activeClip.subtitleStyle ||
        draft.showHookBanner !== activeClip.showHookBanner ||
        draft.addBackgroundMusic !== activeClip.addBackgroundMusic ||
        draft.openingHook !== activeClip.openingHook ||
        JSON.stringify(draft.segments) !== JSON.stringify(activeClip.segments))
  );

  const canDirectDownloadMp4 =
    !hasUnsavedRenderEdits &&
    isProjectSyncedOnServer &&
    isClipRenderedForQuality(draft, exportQuality);

  const activeSegment = draft.segments.find(
    (s) => currentTime >= s.startSeconds && currentTime <= s.endSeconds
  );

  const relativeClipTime = Math.max(0, currentTime - draft.startSeconds);
  const clipDuration = Math.max(3, draft.endSeconds - draft.startSeconds);
  const showHookNow = draft.showHookBanner && relativeClipTime <= 4.2;

  const togglePlay = () => {
    if (project.localVideoUrl && videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
        setIsPlaying(false);
      } else {
        if (
          videoRef.current.currentTime < draft.startSeconds ||
          videoRef.current.currentTime >= draft.endSeconds
        ) {
          videoRef.current.currentTime = draft.startSeconds;
        }
        videoRef.current.play().catch(() => {});
        setIsPlaying(true);
      }
    } else {
      setIsPlaying((prev) => !prev);
    }
  };

  const handleVideoTimeUpdate = () => {
    const el = videoRef.current;
    if (!el || !draft) return;
    if (el.currentTime >= draft.endSeconds) {
      el.currentTime = draft.startSeconds;
    }
    setCurrentTime(el.currentTime);
  };

  const handleScrub = (val: number) => {
    setCurrentTime(val);
    if (videoRef.current) {
      videoRef.current.currentTime = val;
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setEditorError(null);
    try {
      await onSaveClip(draft.id, {
        title: draft.title,
        openingHook: draft.openingHook,
        startSeconds: draft.startSeconds,
        endSeconds: draft.endSeconds,
        speakerCenterX: draft.speakerCenterX,
        outputFormat: draft.outputFormat,
        subtitleStyle: draft.subtitleStyle,
        showHookBanner: draft.showHookBanner,
        addBackgroundMusic: draft.addBackgroundMusic,
        socialCaption: draft.socialCaption,
        platformCaptions: draft.platformCaptions,
        hashtags: draft.hashtags,
        segments: draft.segments,
      });
      setSavedFlag(true);
      setTimeout(() => setSavedFlag(false), 2000);
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : 'Failed to save clip edits.');
    } finally {
      setSaving(false);
    }
  };

  const handleRegenerate = async () => {
    setRegenerating(true);
    setEditorError(null);
    try {
      await onRegenerateCopy(draft.id);
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : 'Failed to regenerate AI copy.');
    } finally {
      setRegenerating(false);
    }
  };

  const handleRenderNow = async () => {
    setEditorError(null);
    try {
      await onSaveClip(draft.id, {
        title: draft.title,
        openingHook: draft.openingHook,
        startSeconds: draft.startSeconds,
        endSeconds: draft.endSeconds,
        speakerCenterX: draft.speakerCenterX,
        outputFormat: draft.outputFormat,
        subtitleStyle: draft.subtitleStyle,
        showHookBanner: draft.showHookBanner,
        addBackgroundMusic: draft.addBackgroundMusic,
        segments: draft.segments,
      });
      await onRenderClip(draft.id, exportQuality);
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : 'Render failed.');
    }
  };

  const handleDownloadNow = async () => {
    setDownloadingMp4(true);
    setEditorError(null);
    try {
      await onSaveClip(draft.id, {
        title: draft.title,
        openingHook: draft.openingHook,
        startSeconds: draft.startSeconds,
        endSeconds: draft.endSeconds,
        speakerCenterX: draft.speakerCenterX,
        outputFormat: draft.outputFormat,
        subtitleStyle: draft.subtitleStyle,
        showHookBanner: draft.showHookBanner,
        addBackgroundMusic: draft.addBackgroundMusic,
        segments: draft.segments,
      });
      await onDownloadClip(draft, exportQuality);
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : 'MP4 download failed.');
    } finally {
      setDownloadingMp4(false);
    }
  };

  const handleAttachFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAttaching(true);
    setEditorError(null);
    try {
      await onAttachVideo(project.id, file);
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : 'Failed to attach video.');
    } finally {
      setAttaching(false);
    }
  };

  const renderAnimatedSubtitle = () => {
    if (!activeSegment) return null;
    const rawText = appSettings.subtitleUppercase
      ? activeSegment.text.toUpperCase()
      : activeSegment.text;
    const words = rawText.split(/\s+/).filter(Boolean);
    const highlights = new Set(
      activeSegment.highlightWords.map((w) =>
        w.toLowerCase().replace(/[^a-z0-9]/g, '')
      )
    );

    const accentColor =
      draft.subtitleStyle === 'kinetic_blue'
        ? '#3B82F6'
        : draft.subtitleStyle === 'karaoke_gold'
        ? '#FBBF24'
        : appSettings.subtitleAccentColor || '#F59E0B';

    return (
      <div
        className={`pointer-events-none absolute inset-x-4 flex justify-center text-center ${
          appSettings.subtitlePosition === 'center'
            ? 'top-1/2 -translate-y-1/2'
            : appSettings.subtitlePosition === 'bottom'
            ? 'bottom-5'
            : 'bottom-14'
        }`}
      >
        <div
          className={`max-w-[92%] px-3 py-1.5 leading-snug ${
            draft.subtitleStyle === 'clean_minimal'
              ? 'rounded-lg bg-black/75 text-white font-semibold text-sm backdrop-blur-sm'
              : 'font-display text-base font-extrabold tracking-tight text-white [text-shadow:0_2px_8px_rgba(0,0,0,0.95),0_0_2px_rgba(0,0,0,1)]'
          }`}
        >
          {words.map((word, idx) => {
            const clean = word.toLowerCase().replace(/[^a-z0-9]/g, '');
            const isHi = highlights.has(clean);
            return (
              <span
                key={`${activeSegment.id}_${idx}`}
                style={isHi ? { color: accentColor } : undefined}
                className={isHi ? 'inline-block scale-[1.04]' : undefined}
              >
                {word}{' '}
              </span>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-5">
      {/* Top Toolbar */}
      <div className="flex flex-col gap-3 rounded-xl border border-white/8 bg-[#12151C] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <span>Clip {String(draft.index).padStart(2, '0')}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono text-amber-400 tabular-nums">
              {draft.score.total}/100
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">
              {formatDurationLabel(clipDuration)}
            </span>
          </div>
          <h1 className="mt-0.5 truncate text-base font-semibold text-white">
            {draft.title}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <div className="flex items-center gap-1.5 rounded-lg border border-white/12 bg-[#0B0D12] px-2.5 py-1.5">
            <span className="text-[11px] text-gray-400">Quality</span>
            <select
              value={exportQuality}
              onChange={(e) => onChangeExportQuality(e.target.value as ExportQualityMode)}
              aria-label="Clip export quality"
              className="bg-transparent text-xs font-semibold text-emerald-300 focus:outline-none"
            >
              <option value="best" className="bg-[#12151C] text-white">
                Best (Max Res · CRF 15)
              </option>
              <option value="high_1080p" className="bg-[#12151C] text-white">
                1080p HD (CRF 18)
              </option>
            </select>
          </div>

          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 bg-[#171B24] px-3.5 py-2 text-xs font-medium text-gray-200 hover:bg-[#202634] whitespace-nowrap shrink-0"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : savedFlag ? (
              <Check className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            <span>{savedFlag ? 'Saved' : 'Save Edits'}</span>
          </button>

          {project.localVideoUrl ? (
            <button
              type="button"
              onClick={handleRenderNow}
              disabled={activeClip?.renderStatus === 'rendering' || downloadingMp4}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              {activeClip?.renderStatus === 'rendering' ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Rendering MP4...</span>
                </>
              ) : (
                <span>Render MP4</span>
              )}
            </button>
          ) : null}

          {canDirectDownloadMp4 ? (
            <a
              href={apiUrl(
                `/api/projects/${project.id}/clips/${draft.id}/download?quality=${encodeURIComponent(
                  exportQuality
                )}`
              )}
              download={buildClipDownloadFilename(draft)}
              rel="noopener noreferrer"
              onClick={() => onMarkDirectMp4Download(draft, exportQuality)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-500 whitespace-nowrap shrink-0"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Download MP4</span>
            </a>
          ) : (
            (project.localVideoUrl || activeClip?.renderStatus === 'completed') && (
              <button
                type="button"
                onClick={handleDownloadNow}
                disabled={downloadingMp4 || activeClip?.renderStatus === 'rendering'}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                {downloadingMp4 ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                <span>{downloadingMp4 ? 'Preparing MP4...' : 'Download MP4'}</span>
              </button>
            )
          )}

          <button
            type="button"
            onClick={() =>
              onSaveClip(draft.id, { approved: !draft.approved })
            }
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              draft.approved
                ? 'border border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25'
                : 'border border-white/12 bg-[#171B24] text-gray-200 hover:bg-[#202634]'
            }`}
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>{draft.approved ? 'Approved' : 'Approve Clip'}</span>
          </button>

          <button
            type="button"
            onClick={onGoToExport}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 bg-[#171B24] px-3.5 py-2 text-xs font-medium text-white hover:bg-[#202634] whitespace-nowrap shrink-0"
          >
            <span>Export Queue</span>
          </button>

          {onGoToPublish && (
            <button
              type="button"
              onClick={() => onGoToPublish(draft.id)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-blue-500/40 bg-blue-500/15 px-3.5 py-2 text-xs font-semibold text-blue-200 hover:bg-blue-500/25 whitespace-nowrap shrink-0"
            >
              <Send className="h-3.5 w-3.5" />
              <span>Publish</span>
            </button>
          )}
        </div>
      </div>

      <ReadyMp4Banner readyDownload={readyMp4Download} onDismiss={onDismissReadyMp4} />

      {editorError && (
        <div
          role="alert"
          className="rounded-lg border border-rose-500/30 bg-rose-950/40 px-4 py-3 text-sm text-rose-200"
        >
          {editorError}
        </div>
      )}

      {/* 3-Column Studio Workspace */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12 items-start">
        {/* Left Rail: Clip List */}
        <div className="xl:col-span-3 rounded-xl border border-white/8 bg-[#12151C] p-3 space-y-1.5 max-h-[680px] overflow-y-auto">
          <p className="px-2 py-1 text-xs font-medium text-gray-400">
            Detected Clips ({project.clips.length})
          </p>
          {project.clips.map((c) => {
            const isActive = c.id === draft.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => onSelectClip(c.id)}
                className={`w-full rounded-lg border p-2.5 text-left transition-colors ${
                  isActive
                    ? 'border-blue-500/60 bg-blue-500/10 text-white'
                    : 'border-transparent bg-transparent text-gray-300 hover:bg-white/[0.03]'
                }`}
              >
                <div className="flex items-center justify-between text-[11px] text-gray-400">
                  <span className="font-mono tabular-nums">
                    #{String(c.index).padStart(2, '0')} · {formatDurationLabel(c.durationSeconds)}
                  </span>
                  <span className="font-mono font-semibold text-amber-400 tabular-nums">
                    {c.score.total}/100
                  </span>
                </div>
                <p className="mt-1 truncate text-xs font-medium">{c.title}</p>
              </button>
            );
          })}
        </div>

        {/* Center Stage: Preview Canvas & Timeline */}
        <div className="xl:col-span-4 flex flex-col items-center rounded-xl border border-white/8 bg-[#12151C] p-5 space-y-4">
          {/* Aspect Ratio Canvas */}
          <div
            className={`relative overflow-hidden rounded-xl border border-white/15 bg-black shadow-2xl ${
              draft.outputFormat === '9:16'
                ? 'w-full max-w-[290px] aspect-[9/16]'
                : draft.outputFormat === '1:1'
                ? 'w-full max-w-[360px] aspect-square'
                : 'w-full aspect-video'
            }`}
          >
            {project.localVideoUrl ? (
              <video
                ref={videoRef}
                src={apiUrl(project.localVideoUrl)}
                muted={isMuted}
                playsInline
                onTimeUpdate={handleVideoTimeUpdate}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                style={{
                  objectPosition: `${draft.speakerCenterX * 100}% 50%`,
                }}
                className="h-full w-full object-cover"
              />
            ) : project.youtubeVideoId && youtubeEmbedMode ? (
              <iframe
                title={draft.title}
                src={`https://www.youtube.com/embed/${project.youtubeVideoId}?start=${Math.floor(
                  draft.startSeconds
                )}&end=${Math.ceil(draft.endSeconds)}&autoplay=1&rel=0`}
                allow="autoplay; encrypted-media"
                allowFullScreen
                className="h-full w-full border-0"
              />
            ) : project.youtubeVideoId ? (
              <div className="relative h-full w-full">
                {project.thumbnailUrl ? (
                  <img
                    src={apiUrl(project.thumbnailUrl)}
                    alt={draft.title}
                    referrerPolicy="no-referrer"
                    style={{
                      objectPosition: `${draft.speakerCenterX * 100}% 50%`,
                    }}
                    className="h-full w-full object-cover opacity-85"
                  />
                ) : null}
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/40" />
              </div>
            ) : null}

            {/* Opening Hook Banner Overlay */}
            {showHookNow && draft.openingHook.trim() && (
              <div className="pointer-events-none absolute inset-x-4 top-8 flex justify-center">
                <div className="rounded-md bg-white px-3 py-1.5 text-center text-xs font-bold text-black shadow-lg">
                  {draft.openingHook}
                </div>
              </div>
            )}

            {/* Brand Watermark Preview */}
            {appSettings.showWatermark && appSettings.brandWatermark.trim() && (
              <div className="pointer-events-none absolute right-3 top-3 text-[10px] font-medium text-white/60">
                {appSettings.brandWatermark}
              </div>
            )}

            {/* Live Animated Subtitle Overlay */}
            {renderAnimatedSubtitle()}
          </div>

          {/* Playback Controls & Scrubber */}
          <div className="w-full space-y-2.5 pt-1">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={togglePlay}
                aria-label={isPlaying ? 'Pause clip preview' : 'Play clip preview'}
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-white hover:bg-blue-500 shrink-0"
              >
                {isPlaying ? (
                  <Pause className="h-4 w-4" />
                ) : (
                  <Play className="h-4 w-4 ml-0.5" />
                )}
              </button>

              <input
                type="range"
                min={draft.startSeconds}
                max={draft.endSeconds}
                step={0.1}
                value={Math.min(draft.endSeconds, Math.max(draft.startSeconds, currentTime))}
                onChange={(e) => handleScrub(Number(e.target.value))}
                className="h-1.5 flex-1 cursor-pointer accent-blue-500"
              />

              <span className="font-mono text-xs text-gray-300 tabular-nums shrink-0">
                {formatTimecode(relativeClipTime)} / {formatTimecode(clipDuration)}
              </span>

              {project.localVideoUrl && (
                <button
                  type="button"
                  onClick={() => setIsMuted((m) => !m)}
                  aria-label={isMuted ? 'Unmute preview' : 'Mute preview'}
                  className="rounded-lg p-2 text-gray-400 hover:bg-white/5 hover:text-white shrink-0"
                >
                  {isMuted ? (
                    <VolumeX className="h-4 w-4" />
                  ) : (
                    <Volume2 className="h-4 w-4" />
                  )}
                </button>
              )}
            </div>

            {draft.renderStatus === 'completed' && draft.renderedVideoUrl && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-500/25 bg-emerald-950/25 px-3 py-2 text-xs">
                <span className="font-medium text-emerald-300">
                  Rendered MP4 ready
                </span>
                {canDirectDownloadMp4 ? (
                  <a
                    href={apiUrl(
                      `/api/projects/${project.id}/clips/${draft.id}/download?quality=${encodeURIComponent(
                        exportQuality
                      )}`
                    )}
                    download={buildClipDownloadFilename(draft)}
                    rel="noopener noreferrer"
                    onClick={() => onMarkDirectMp4Download(draft, exportQuality)}
                    className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-500 whitespace-nowrap"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Download MP4</span>
                  </a>
                ) : (
                  <button
                    type="button"
                    disabled={downloadingMp4}
                    onClick={handleDownloadNow}
                    className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 whitespace-nowrap"
                  >
                    {downloadingMp4 ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    <span>{downloadingMp4 ? 'Preparing...' : 'Download MP4'}</span>
                  </button>
                )}
              </div>
            )}

            {!project.localVideoUrl && (
              <div className="rounded-lg border border-white/10 bg-[#0B0D12] p-3 text-xs text-gray-300 space-y-2.5">
                <div>
                  <p className="font-medium text-white">
                    YouTube Preview Mode (Captions & Timing Active)
                  </p>
                  <p className="mt-1 text-gray-400">
                    Switch to the live YouTube segment player or attach your authorized source file
                    for FFmpeg MP4 export.
                  </p>
                </div>
                <input
                  ref={attachInputRef}
                  type="file"
                  accept="video/*"
                  onChange={handleAttachFile}
                  className="hidden"
                />
                <div className="flex flex-wrap gap-2">
                  {project.youtubeVideoId && (
                    <button
                      type="button"
                      onClick={() => setYoutubeEmbedMode((m) => !m)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-[#171B24] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#222836]"
                    >
                      <Youtube className="h-3.5 w-3.5 text-rose-400" />
                      <span>
                        {youtubeEmbedMode
                          ? 'Show Subtitle Overlay Preview'
                          : 'Play YouTube Segment'}
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={attaching}
                    onClick={() => attachInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-[#171B24] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#222836]"
                  >
                    {attaching ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Upload className="h-3.5 w-3.5 text-blue-400" />
                    )}
                    <span>{attaching ? 'Uploading...' : 'Attach Video File'}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Inspector: Trim, Reframe, Subtitles, AI Copy */}
        <div className="xl:col-span-5 space-y-5 rounded-xl border border-white/8 bg-[#12151C] p-5 max-h-[680px] overflow-y-auto">
          {/* Trim & Crop */}
          <div className="space-y-4">
            <h2 className="text-sm font-semibold text-white">
              Trim, Reframe & Format
            </h2>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-400">
                  Start Time (sec)
                </label>
                <input
                  type="number"
                  min={0}
                  max={Math.max(0, draft.endSeconds - 3)}
                  value={draft.startSeconds}
                  onChange={(e) => {
                    const nextStart = Math.max(
                      0,
                      Math.min(draft.endSeconds - 3, Number(e.target.value) || 0)
                    );
                    setDraft({
                      ...draft,
                      startSeconds: nextStart,
                      durationSeconds: draft.endSeconds - nextStart,
                    });
                  }}
                  className="mt-1 w-full rounded-lg border border-white/10 bg-[#0B0D12] px-3 py-2 font-mono text-xs text-white tabular-nums"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400">
                  End Time (sec)
                </label>
                <input
                  type="number"
                  min={draft.startSeconds + 3}
                  max={maxTimeline}
                  value={draft.endSeconds}
                  onChange={(e) => {
                    const nextEnd = Math.max(
                      draft.startSeconds + 3,
                      Math.min(maxTimeline, Number(e.target.value) || draft.startSeconds + 15)
                    );
                    setDraft({
                      ...draft,
                      endSeconds: nextEnd,
                      durationSeconds: nextEnd - draft.startSeconds,
                    });
                  }}
                  className="mt-1 w-full rounded-lg border border-white/10 bg-[#0B0D12] px-3 py-2 font-mono text-xs text-white tabular-nums"
                />
              </div>
            </div>

            {/* Speaker Center X Slider */}
            <div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-300">Speaker Center Focus (9:16 Crop)</span>
                <span className="font-mono text-gray-400 tabular-nums">
                  {Math.round(draft.speakerCenterX * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0.1}
                max={0.9}
                step={0.05}
                value={draft.speakerCenterX}
                onChange={(e) =>
                  setDraft({ ...draft, speakerCenterX: Number(e.target.value) })
                }
                className="mt-2 h-1.5 w-full cursor-pointer accent-blue-500"
              />
              <div className="mt-1.5 flex items-center justify-between text-[11px] text-gray-500">
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, speakerCenterX: 0.25 })}
                  className="hover:text-gray-300"
                >
                  Left Speaker (25%)
                </button>
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, speakerCenterX: 0.5 })}
                  className="hover:text-gray-300"
                >
                  Center (50%)
                </button>
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, speakerCenterX: 0.75 })}
                  className="hover:text-gray-300"
                >
                  Right Speaker (75%)
                </button>
              </div>
            </div>

            {/* Aspect Ratio & Subtitle Style */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-400">Aspect Ratio</label>
                <select
                  value={draft.outputFormat}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      outputFormat: e.target.value as AspectRatioFormat,
                    })
                  }
                  className="mt-1 w-full rounded-lg border border-white/10 bg-[#0B0D12] px-3 py-2 text-xs text-white"
                >
                  <option value="9:16">9:16 Vertical</option>
                  <option value="16:9">16:9 Landscape</option>
                  <option value="1:1">1:1 Square</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-400">Subtitle Style</label>
                <select
                  value={draft.subtitleStyle}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      subtitleStyle: e.target.value as SubtitleStylePreset,
                    })
                  }
                  className="mt-1 w-full rounded-lg border border-white/10 bg-[#0B0D12] px-3 py-2 text-xs text-white"
                >
                  <option value="bold_impact">Bold Impact</option>
                  <option value="karaoke_gold">Karaoke Gold</option>
                  <option value="kinetic_blue">Kinetic Blue</option>
                  <option value="clean_minimal">Clean Minimal</option>
                </select>
              </div>
            </div>

            <div className="flex flex-wrap gap-4 pt-1">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-gray-300">
                <input
                  type="checkbox"
                  checked={draft.showHookBanner}
                  onChange={(e) =>
                    setDraft({ ...draft, showHookBanner: e.target.checked })
                  }
                  className="h-4 w-4 accent-blue-600"
                />
                <span>Show opening hook banner</span>
              </label>

              <label className="flex cursor-pointer items-center gap-2 text-xs text-gray-300">
                <input
                  type="checkbox"
                  checked={draft.addBackgroundMusic}
                  onChange={(e) =>
                    setDraft({ ...draft, addBackgroundMusic: e.target.checked })
                  }
                  className="h-4 w-4 accent-blue-600"
                />
                <span>Subtle ambient music bed</span>
              </label>
            </div>
          </div>

          {/* AI Hook & Platform Captions */}
          <div className="space-y-3 border-t border-white/8 pt-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">
                Hook, Title & Platform Captions
              </h2>
              <button
                type="button"
                onClick={handleRegenerate}
                disabled={regenerating}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 bg-[#171B24] px-2.5 py-1.5 text-xs font-medium text-blue-400 hover:bg-[#1F2533] disabled:opacity-50 whitespace-nowrap"
              >
                {regenerating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                <span>Regenerate AI Copy</span>
              </button>
            </div>

            <div>
              <label className="block text-xs text-gray-400">Viral Title</label>
              <input
                type="text"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                className="mt-1 w-full rounded-lg border border-white/10 bg-[#0B0D12] px-3 py-2 text-xs text-white"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-400">
                Opening Hook Overlay (First 4s)
              </label>
              <input
                type="text"
                value={draft.openingHook}
                onChange={(e) =>
                  setDraft({ ...draft, openingHook: e.target.value })
                }
                className="mt-1 w-full rounded-lg border border-white/10 bg-[#0B0D12] px-3 py-2 text-xs text-white"
              />
            </div>

            {/* Platform Caption Tabs */}
            <div>
              <div className="flex items-center gap-1 rounded-lg border border-white/8 bg-[#0B0D12] p-1">
                {(
                  [
                    'tiktok',
                    'youtube_shorts',
                    'instagram_reels',
                    'facebook',
                  ] as TargetPlatform[]
                ).map((plat) => (
                  <button
                    key={plat}
                    type="button"
                    onClick={() => setCaptionPlatform(plat)}
                    className={`flex-1 rounded-md py-1.5 text-[11px] font-medium transition-colors whitespace-nowrap truncate px-1 ${
                      captionPlatform === plat
                        ? 'bg-[#1D222E] text-white'
                        : 'text-gray-400 hover:text-gray-200'
                    }`}
                  >
                    {formatPlatformName(plat)}
                  </button>
                ))}
              </div>

              <textarea
                rows={3}
                value={draft.platformCaptions[captionPlatform] || ''}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    platformCaptions: {
                      ...draft.platformCaptions,
                      [captionPlatform]: e.target.value,
                    },
                  })
                }
                className="mt-2 w-full rounded-lg border border-white/10 bg-[#0B0D12] p-3 text-xs leading-relaxed text-white"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-400">Hashtags</label>
              <input
                type="text"
                value={draft.hashtags.join(' ')}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    hashtags: e.target.value
                      .split(/\s+/)
                      .filter(Boolean)
                      .map((h) => (h.startsWith('#') ? h : `#${h}`)),
                  })
                }
                className="mt-1 w-full rounded-lg border border-white/10 bg-[#0B0D12] px-3 py-2 font-mono text-xs text-blue-300"
              />
            </div>
          </div>

          {/* Editable Subtitles */}
          <div className="space-y-3 border-t border-white/8 pt-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">
                Timed Subtitles ({draft.segments.length})
              </h2>
              <Wand2 className="h-3.5 w-3.5 text-gray-500" />
            </div>

            <div className="space-y-2">
              {draft.segments.map((seg, idx) => (
                <div
                  key={seg.id}
                  onClick={() => handleScrub(seg.startSeconds)}
                  className="rounded-lg border border-white/8 bg-[#0B0D12] p-2.5 cursor-pointer hover:border-white/15"
                >
                  <div className="flex items-center justify-between text-[11px] text-gray-400">
                    <span className="font-mono tabular-nums">
                      {formatTimecode(seg.startSeconds)} – {formatTimecode(seg.endSeconds)}
                    </span>
                    <span>{seg.speaker}</span>
                  </div>
                  <input
                    type="text"
                    value={seg.text}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const next = [...draft.segments];
                      next[idx] = { ...seg, text: e.target.value };
                      setDraft({ ...draft, segments: next });
                    }}
                    className="mt-1.5 w-full rounded border border-white/8 bg-[#12151C] px-2.5 py-1.5 text-xs text-white focus:border-blue-500 focus:outline-none"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

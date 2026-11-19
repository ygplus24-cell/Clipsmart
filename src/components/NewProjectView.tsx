import React, { useRef, useState } from 'react';
import {
  Check,
  Film,
  Info,
  Loader2,
  SlidersHorizontal,
  Upload,
  Youtube,
} from 'lucide-react';
import type {
  AppSettings,
  AspectRatioFormat,
  ClippingMode,
  DurationPreset,
  Project,
  ProjectSettings,
  SubtitleStylePreset,
  TargetPlatform,
} from '../types';
import { apiUrl, parseApiResponse, parseRawApiText } from '../utils/api';
import { formatPlatformName } from '../utils/formatters';

interface NewProjectViewProps {
  appSettings: AppSettings;
  onProjectCreated: (project: Project) => void;
}

export const NewProjectView: React.FC<NewProjectViewProps> = ({
  appSettings,
  onProjectCreated,
}) => {
  const [sourceMode, setSourceMode] = useState<'youtube' | 'upload'>('youtube');
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [customTitle, setCustomTitle] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [settings, setSettings] = useState<ProjectSettings>({
    durationPreset: appSettings.defaultDurationPreset,
    customMinSeconds: 20,
    customMaxSeconds: 45,
    outputFormat: appSettings.defaultOutputFormat,
    clippingMode: appSettings.defaultClippingMode,
    targetPlatforms: appSettings.defaultPlatforms,
    maxClips: 6,
    subtitleStyle: appSettings.defaultSubtitleStyle,
    autoFaceTrack: true,
    deduplicateClips: true,
    addHookOverlay: true,
    addBackgroundMusic: false,
  });

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const togglePlatform = (platform: TargetPlatform) => {
    setSettings((prev) => {
      const exists = prev.targetPlatforms.includes(platform);
      if (exists && prev.targetPlatforms.length === 1) return prev;
      return {
        ...prev,
        targetPlatforms: exists
          ? prev.targetPlatforms.filter((p) => p !== platform)
          : [...prev.targetPlatforms, platform],
      };
    });
  };

  const handleFilePicked = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('video/')) {
      setErrorMsg('Please select a valid video file (MP4, MOV, WebM, or MKV).');
      return;
    }
    setErrorMsg(null);
    setSelectedFile(file);
    if (!customTitle.trim()) {
      setCustomTitle(file.name.replace(/\.[^/.]+$/, ''));
    }
  };

  const handleAnalyzeYoutube = async () => {
    if (!youtubeUrl.trim()) {
      setErrorMsg('Paste a public YouTube video URL to continue.');
      return;
    }
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const res = await fetch(apiUrl('/api/projects/youtube'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ youtubeUrl: youtubeUrl.trim(), settings }),
      });
      const data = await parseApiResponse<{ project?: Project; error?: string }>(res);
      if (!res.ok || !data.project) {
        throw new Error(data.error || 'Failed to start YouTube analysis.');
      }
      onProjectCreated(data.project);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Request failed.');
      setSubmitting(false);
    }
  };

  const handleAnalyzeUpload = async () => {
    if (!selectedFile) {
      setErrorMsg('Choose or drop a video file before starting analysis.');
      return;
    }
    setSubmitting(true);
    setUploadPercent(0);
    setErrorMsg(null);

    try {
      const formData = new FormData();
      formData.append('video', selectedFile);
      formData.append('title', customTitle.trim() || selectedFile.name);
      formData.append('settings', JSON.stringify(settings));

      const project = await new Promise<Project>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', apiUrl('/api/projects/upload'));
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) {
            setUploadPercent(Math.round((ev.loaded / ev.total) * 100));
          }
        };
        xhr.onload = () => {
          try {
            const parsed = parseRawApiText<{
              project?: Project;
              error?: string;
            }>(xhr.responseText, xhr.status);
            if (xhr.status >= 200 && xhr.status < 300 && parsed.project) {
              resolve(parsed.project);
            } else {
              reject(new Error(parsed.error || 'Upload failed.'));
            }
          } catch (err) {
            reject(
              err instanceof Error
                ? err
                : new Error('Invalid server response during upload.')
            );
          }
        };
        xhr.onerror = () => reject(new Error('Network error while uploading video.'));
        xhr.send(formData);
      });

      onProjectCreated(project);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Upload failed.');
      setSubmitting(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (sourceMode === 'youtube') {
      handleAnalyzeYoutube();
    } else {
      handleAnalyzeUpload();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white">
          Start a New Clipping Project
        </h1>
        <p className="mt-1.5 text-sm text-gray-400">
          Choose your video source and configure duration, aspect ratio, and viral clipping rules.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
        {/* Left: Video Source Input */}
        <div className="lg:col-span-7 space-y-6 rounded-xl border border-white/8 bg-[#12151C] p-6">
          {/* Segmented Source Selector */}
          <div className="grid grid-cols-2 gap-2 rounded-lg border border-white/8 bg-[#0B0D12] p-1">
            <button
              type="button"
              onClick={() => {
                setSourceMode('youtube');
                setErrorMsg(null);
              }}
              className={`flex items-center justify-center gap-2 rounded-md py-2.5 text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
                sourceMode === 'youtube'
                  ? 'bg-[#1A1F2B] text-white'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              <Youtube className="h-4 w-4 text-rose-400" />
              <span>YouTube URL</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setSourceMode('upload');
                setErrorMsg(null);
              }}
              className={`flex items-center justify-center gap-2 rounded-md py-2.5 text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
                sourceMode === 'upload'
                  ? 'bg-[#1A1F2B] text-white'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              <Upload className="h-4 w-4 text-blue-400" />
              <span>Upload Original Video</span>
            </button>
          </div>

          {sourceMode === 'youtube' ? (
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="youtube-url-input"
                  className="block text-sm font-medium text-gray-200"
                >
                  Public YouTube Video Link
                </label>
                <div className="mt-2 relative">
                  <Youtube className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
                  <input
                    id="youtube-url-input"
                    type="text"
                    inputMode="url"
                    value={youtubeUrl}
                    onChange={(e) => setYoutubeUrl(e.target.value)}
                    placeholder="https://www.youtube.com/watch?v=..."
                    className="w-full rounded-lg border border-white/12 bg-[#0B0D12] py-3 pl-10 pr-4 text-sm text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
                  />
                </div>
              </div>

              <div className="flex items-start gap-3 rounded-lg border border-white/8 bg-[#0E1118] p-4 text-xs leading-relaxed text-gray-400">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" />
                <div>
                  <p className="font-medium text-gray-200">
                    Gemini Direct Video Understanding + Policy Compliance
                  </p>
                  <p className="mt-1">
                    Gemini inspects the public YouTube video directly to detect viral timestamps,
                    speaker turns, hooks, captions, and 7-factor scores. In accordance with YouTube
                    policies, you can attach your authorized source file later in the Editor or
                    Export tab whenever you want to render burned-in MP4 files via FFmpeg.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="project-title-input"
                  className="block text-sm font-medium text-gray-200"
                >
                  Project Title
                </label>
                <input
                  id="project-title-input"
                  type="text"
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                  placeholder="Podcast Episode #42 Highlights"
                  className="mt-2 w-full rounded-lg border border-white/12 bg-[#0B0D12] px-3.5 py-2.5 text-sm text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragging(false);
                  handleFilePicked(e.dataTransfer.files?.[0]);
                }}
                onClick={() => fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    fileInputRef.current?.click();
                  }
                }}
                className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-6 py-10 text-center transition-colors ${
                  isDragging
                    ? 'border-blue-500 bg-blue-500/10'
                    : 'border-white/15 bg-[#0B0D12] hover:border-white/30'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/*"
                  onChange={(e) => handleFilePicked(e.target.files?.[0])}
                  className="hidden"
                />
                <Film className="h-9 w-9 text-blue-400" />
                {selectedFile ? (
                  <div className="mt-3">
                    <p className="text-sm font-semibold text-white">
                      {selectedFile.name}
                    </p>
                    <p className="mt-1 font-mono text-xs text-gray-400 tabular-nums">
                      {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB · Ready for Gemini +
                      FFmpeg pipeline
                    </p>
                  </div>
                ) : (
                  <div className="mt-3">
                    <p className="text-sm font-medium text-white">
                      Drop your video file here, or click to browse
                    </p>
                    <p className="mt-1 text-xs text-gray-400">
                      MP4, MOV, WebM, MKV up to 500 MB · Full FFmpeg 9:16 crop & subtitle burn-in
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {errorMsg && (
            <div
              role="alert"
              className="rounded-lg border border-rose-500/30 bg-rose-950/40 px-4 py-3 text-sm text-rose-200"
            >
              {errorMsg}
            </div>
          )}

          {submitting && sourceMode === 'upload' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-gray-300">
                <span>Uploading source video to studio server...</span>
                <span className="font-mono tabular-nums">{uploadPercent}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full bg-blue-500 transition-all duration-150"
                  style={{ width: `${uploadPercent}%` }}
                />
              </div>
            </div>
          )}

          <div className="flex items-center justify-end pt-2">
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Starting Analysis...</span>
                </>
              ) : (
                <span>Analyze Video</span>
              )}
            </button>
          </div>
        </div>

        {/* Right: Project Settings */}
        <div className="lg:col-span-5 space-y-6 rounded-xl border border-white/8 bg-[#12151C] p-6">
          <div className="flex items-center gap-2 border-b border-white/8 pb-4">
            <SlidersHorizontal className="h-4 w-4 text-blue-400" />
            <h2 className="text-base font-semibold text-white">Project Settings</h2>
          </div>

          {/* Clip Duration */}
          <div>
            <label className="block text-xs font-medium text-gray-300">
              Clip Duration
            </label>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {(
                [
                  { id: '15-30', label: '15–30 sec' },
                  { id: '30-60', label: '30–60 sec' },
                  { id: '60-90', label: '60–90 sec' },
                  { id: 'auto', label: 'AI Auto' },
                  { id: 'custom', label: 'Custom' },
                ] as Array<{ id: DurationPreset; label: string }>
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() =>
                    setSettings((prev) => ({ ...prev, durationPreset: opt.id }))
                  }
                  className={`rounded-lg border px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    settings.durationPreset === opt.id
                      ? 'border-blue-500 bg-blue-500/15 text-white'
                      : 'border-white/10 bg-[#0B0D12] text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {settings.durationPreset === 'custom' && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-400">Min (sec)</label>
                  <input
                    type="number"
                    min={8}
                    max={120}
                    value={settings.customMinSeconds}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        customMinSeconds: Number(e.target.value) || 15,
                      }))
                    }
                    className="mt-1 w-full rounded-lg border border-white/10 bg-[#0B0D12] px-3 py-1.5 font-mono text-sm text-white tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-400">Max (sec)</label>
                  <input
                    type="number"
                    min={15}
                    max={180}
                    value={settings.customMaxSeconds}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        customMaxSeconds: Number(e.target.value) || 45,
                      }))
                    }
                    className="mt-1 w-full rounded-lg border border-white/10 bg-[#0B0D12] px-3 py-1.5 font-mono text-sm text-white tabular-nums"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Output Format */}
          <div>
            <label className="block text-xs font-medium text-gray-300">
              Output Format
            </label>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {(
                [
                  { id: '9:16', title: '9:16 Vertical', sub: 'Reels / Shorts / TikTok' },
                  { id: '16:9', title: '16:9 Landscape', sub: 'YouTube / Facebook' },
                  { id: '1:1', title: '1:1 Square', sub: 'Feed / LinkedIn' },
                ] as Array<{ id: AspectRatioFormat; title: string; sub: string }>
              ).map((fmt) => (
                <button
                  key={fmt.id}
                  type="button"
                  onClick={() =>
                    setSettings((prev) => ({ ...prev, outputFormat: fmt.id }))
                  }
                  className={`rounded-lg border p-2.5 text-left transition-colors ${
                    settings.outputFormat === fmt.id
                      ? 'border-blue-500 bg-blue-500/15 text-white'
                      : 'border-white/10 bg-[#0B0D12] text-gray-400 hover:text-gray-200'
                  }`}
                >
                  <div className="text-xs font-semibold">{fmt.title}</div>
                  <div className="mt-0.5 text-[11px] text-gray-400 truncate">
                    {fmt.sub}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Clipping Style */}
          <div>
            <label className="block text-xs font-medium text-gray-300">
              Clipping Workflow
            </label>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(
                [
                  { id: 'auto', label: 'Automatic Top Clips' },
                  { id: 'manual', label: 'AI Suggestions + Manual' },
                ] as Array<{ id: ClippingMode; label: string }>
              ).map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() =>
                    setSettings((prev) => ({ ...prev, clippingMode: mode.id }))
                  }
                  className={`rounded-lg border px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    settings.clippingMode === mode.id
                      ? 'border-blue-500 bg-blue-500/15 text-white'
                      : 'border-white/10 bg-[#0B0D12] text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </div>

          {/* Target Platforms */}
          <div>
            <label className="block text-xs font-medium text-gray-300">
              Target Platforms
            </label>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(
                [
                  'tiktok',
                  'youtube_shorts',
                  'instagram_reels',
                  'facebook',
                ] as TargetPlatform[]
              ).map((plat) => {
                const active = settings.targetPlatforms.includes(plat);
                return (
                  <button
                    key={plat}
                    type="button"
                    onClick={() => togglePlatform(plat)}
                    className={`flex items-center justify-between rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                      active
                        ? 'border-blue-500/60 bg-blue-500/10 text-white'
                        : 'border-white/10 bg-[#0B0D12] text-gray-400 hover:text-gray-200'
                    }`}
                  >
                    <span className="truncate">{formatPlatformName(plat)}</span>
                    {active && <Check className="h-3.5 w-3.5 text-blue-400 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Max Clips & Subtitle Style */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-300">
                Max Clips
              </label>
              <select
                value={settings.maxClips}
                onChange={(e) =>
                  setSettings((prev) => ({
                    ...prev,
                    maxClips: Number(e.target.value),
                  }))
                }
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#0B0D12] px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none"
              >
                <option value={5}>5 clips</option>
                <option value={6}>6 clips</option>
                <option value={8}>8 clips</option>
                <option value={10}>10 clips</option>
                <option value={12}>12 clips</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-300">
                Caption Preset
              </label>
              <select
                value={settings.subtitleStyle}
                onChange={(e) =>
                  setSettings((prev) => ({
                    ...prev,
                    subtitleStyle: e.target.value as SubtitleStylePreset,
                  }))
                }
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#0B0D12] px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none"
              >
                <option value="bold_impact">Bold Impact</option>
                <option value="karaoke_gold">Karaoke Gold</option>
                <option value="kinetic_blue">Kinetic Blue</option>
                <option value="clean_minimal">Clean Minimal</option>
              </select>
            </div>
          </div>

          {/* Enhancement Toggles */}
          <div className="space-y-2.5 pt-2 border-t border-white/8">
            {(
              [
                { key: 'autoFaceTrack', label: 'Speaker tracking & 9:16 smart center' },
                { key: 'deduplicateClips', label: 'Filter repetitive / overlapping moments' },
                { key: 'addHookOverlay', label: 'Burn-in opening hook title banner' },
                { key: 'addBackgroundMusic', label: 'Add subtle ambient background audio' },
              ] as const
            ).map((item) => (
              <label
                key={item.key}
                className="flex cursor-pointer items-center justify-between gap-3 text-xs text-gray-300"
              >
                <span>{item.label}</span>
                <input
                  type="checkbox"
                  checked={settings[item.key]}
                  onChange={(e) =>
                    setSettings((prev) => ({
                      ...prev,
                      [item.key]: e.target.checked,
                    }))
                  }
                  className="h-4 w-4 rounded border-white/20 bg-[#0B0D12] accent-blue-600"
                />
              </label>
            ))}
          </div>
        </div>
      </div>
    </form>
  );
};

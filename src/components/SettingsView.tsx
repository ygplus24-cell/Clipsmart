import React, { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Download,
  KeyRound,
  Loader2,
  RefreshCw,
  Save,
  Smartphone,
} from 'lucide-react';
import type {
  AppSettings,
  AspectRatioFormat,
  ClippingMode,
  DurationPreset,
  SubtitleStylePreset,
  TargetPlatform,
} from '../types';
import { apiUrl, parseApiResponse } from '../utils/api';
import { formatPlatformName } from '../utils/formatters';
import { PWAInstallButton } from './PWAInstallButton';

interface SettingsViewProps {
  settings: AppSettings;
  onSaveSettings: (next: AppSettings) => Promise<void>;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  onSaveSettings,
}) => {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [checkingEnv, setCheckingEnv] = useState(false);
  const [envStatus, setEnvStatus] = useState<{
    geminiApiKey: boolean;
    appUrl: boolean;
    youtubeOAuth: boolean;
    tiktokOAuth: boolean;
    instagramOAuth: boolean;
    allowedOrigins: boolean;
  } | null>(null);

  const fetchEnvStatus = useCallback(async () => {
    setCheckingEnv(true);
    try {
      const res = await fetch(apiUrl('/api/health'));
      if (res.ok) {
        const data = await parseApiResponse<{
          envStatus?: {
            geminiApiKey: boolean;
            appUrl: boolean;
            youtubeOAuth: boolean;
            tiktokOAuth: boolean;
            instagramOAuth: boolean;
            allowedOrigins: boolean;
          };
        }>(res);
        if (data.envStatus) {
          setEnvStatus(data.envStatus);
        }
      }
    } catch {
      // Ignore transient check failure
    } finally {
      setCheckingEnv(false);
    }
  }, []);

  useEffect(() => {
    fetchEnvStatus();
  }, [fetchEnvStatus]);

  const toggleDefaultPlatform = (platform: TargetPlatform) => {
    setDraft((prev) => {
      const exists = prev.defaultPlatforms.includes(platform);
      if (exists && prev.defaultPlatforms.length === 1) return prev;
      return {
        ...prev,
        defaultPlatforms: exists
          ? prev.defaultPlatforms.filter((p) => p !== platform)
          : [...prev.defaultPlatforms, platform],
      };
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    try {
      await onSaveSettings(draft);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save preferences.');
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadProjectZip = async () => {
    setDownloadingZip(true);
    setSaveError(null);
    try {
      const response = await fetch(apiUrl('/api/project/download-zip'), {
        credentials: 'same-origin',
      });
      if (!response.ok) {
        throw new Error(`Download failed (HTTP ${response.status}).`);
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = 'clipgenius-ai-full-project.zip';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : 'Failed to download project archive.'
      );
    } finally {
      setDownloadingZip(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-4xl space-y-6">
      {saveError && (
        <div
          role="alert"
          className="rounded-lg border border-rose-500/30 bg-rose-950/40 px-4 py-3 text-sm text-rose-200"
        >
          {saveError}
        </div>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Studio Settings
          </h1>
          <p className="mt-1 text-sm text-gray-400">
            Configure default clipping parameters, subtitle typography, branding, and AI model
            preferences.
          </p>
        </div>

        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50 whitespace-nowrap shrink-0"
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : saved ? (
            <Check className="h-4 w-4 text-emerald-300" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          <span>{saved ? 'Settings Saved' : 'Save Preferences'}</span>
        </button>
      </div>

      {/* AI & Default Clipping Behavior */}
      <section className="rounded-xl border border-white/8 bg-[#12151C] p-6 space-y-5">
        <h2 className="text-base font-semibold text-white border-b border-white/8 pb-3">
          AI Analysis & Clipping Defaults
        </h2>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-gray-300">
              Gemini Video Understanding Model
            </label>
            <select
              value={draft.geminiModel}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  geminiModel: e.target.value as AppSettings['geminiModel'],
                })
              }
              className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#0B0D12] px-3 py-2.5 text-sm text-white"
            >
              <option value="gemini-4-hydrogen">Gemini 4 Hydrogen (Recommended)</option>
              <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash Lite (Fastest)</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-300">
              Default Clipping Mode
            </label>
            <select
              value={draft.defaultClippingMode}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  defaultClippingMode: e.target.value as ClippingMode,
                })
              }
              className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#0B0D12] px-3 py-2.5 text-sm text-white"
            >
              <option value="auto">Fully Automatic Top Clips</option>
              <option value="manual">AI Suggestions + Manual Selection</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-300">
              Default Clip Duration
            </label>
            <select
              value={draft.defaultDurationPreset}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  defaultDurationPreset: e.target.value as DurationPreset,
                })
              }
              className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#0B0D12] px-3 py-2.5 text-sm text-white"
            >
              <option value="15-30">15–30 seconds</option>
              <option value="30-60">30–60 seconds</option>
              <option value="60-90">60–90 seconds</option>
              <option value="auto">AI Chooses Best Duration</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-300">
              Default Output Aspect Ratio
            </label>
            <select
              value={draft.defaultOutputFormat}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  defaultOutputFormat: e.target.value as AspectRatioFormat,
                })
              }
              className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#0B0D12] px-3 py-2.5 text-sm text-white"
            >
              <option value="9:16">9:16 Vertical (Reels / Shorts / TikTok)</option>
              <option value="16:9">16:9 Landscape (YouTube)</option>
              <option value="1:1">1:1 Square</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-300">
            Default Target Platforms
          </label>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(
              [
                'tiktok',
                'youtube_shorts',
                'instagram_reels',
                'facebook',
              ] as TargetPlatform[]
            ).map((plat) => {
              const active = draft.defaultPlatforms.includes(plat);
              return (
                <button
                  key={plat}
                  type="button"
                  onClick={() => toggleDefaultPlatform(plat)}
                  className={`flex items-center justify-between rounded-lg border px-3 py-2 text-xs font-medium ${
                    active
                      ? 'border-blue-500/60 bg-blue-500/10 text-white'
                      : 'border-white/10 bg-[#0B0D12] text-gray-400'
                  }`}
                >
                  <span className="truncate">{formatPlatformName(plat)}</span>
                  {active && <Check className="h-3.5 w-3.5 text-blue-400 shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* Subtitle & Branding */}
      <section className="rounded-xl border border-white/8 bg-[#12151C] p-6 space-y-5">
        <h2 className="text-base font-semibold text-white border-b border-white/8 pb-3">
          Subtitle Styling & Watermark Branding
        </h2>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label className="block text-xs font-medium text-gray-300">
              Default Caption Preset
            </label>
            <select
              value={draft.defaultSubtitleStyle}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  defaultSubtitleStyle: e.target.value as SubtitleStylePreset,
                })
              }
              className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#0B0D12] px-3 py-2 text-sm text-white"
            >
              <option value="bold_impact">Bold Impact</option>
              <option value="karaoke_gold">Karaoke Gold</option>
              <option value="kinetic_blue">Kinetic Blue</option>
              <option value="clean_minimal">Clean Minimal</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-300">
              Subtitle Position
            </label>
            <select
              value={draft.subtitlePosition}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  subtitlePosition: e.target.value as AppSettings['subtitlePosition'],
                })
              }
              className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#0B0D12] px-3 py-2 text-sm text-white"
            >
              <option value="lower_third">Lower Third (Recommended)</option>
              <option value="bottom">Bottom Safe Zone</option>
              <option value="center">Center Screen</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-300">
              Font Size ({draft.subtitleFontSize}px)
            </label>
            <input
              type="range"
              min={34}
              max={76}
              value={draft.subtitleFontSize}
              onChange={(e) =>
                setDraft({ ...draft, subtitleFontSize: Number(e.target.value) })
              }
              className="mt-3 h-1.5 w-full cursor-pointer accent-blue-500"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 items-center">
          <div>
            <label className="block text-xs font-medium text-gray-300">
              Highlight Accent Color
            </label>
            <div className="mt-1.5 flex items-center gap-3">
              <input
                type="color"
                value={draft.subtitleAccentColor}
                onChange={(e) =>
                  setDraft({ ...draft, subtitleAccentColor: e.target.value })
                }
                className="h-9 w-14 cursor-pointer rounded border border-white/15 bg-transparent"
              />
              <span className="font-mono text-xs text-gray-300">
                {draft.subtitleAccentColor.toUpperCase()}
              </span>
            </div>
          </div>

          <label className="flex cursor-pointer items-center gap-2.5 text-sm text-gray-200 pt-4 sm:pt-0">
            <input
              type="checkbox"
              checked={draft.subtitleUppercase}
              onChange={(e) =>
                setDraft({ ...draft, subtitleUppercase: e.target.checked })
              }
              className="h-4 w-4 accent-blue-600"
            />
            <span>Render captions in uppercase</span>
          </label>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 items-center pt-2 border-t border-white/8">
          <div>
            <label className="block text-xs font-medium text-gray-300">
              Channel Watermark Text
            </label>
            <input
              type="text"
              value={draft.brandWatermark}
              onChange={(e) =>
                setDraft({ ...draft, brandWatermark: e.target.value })
              }
              placeholder="@YourChannel"
              className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#0B0D12] px-3 py-2 text-sm text-white"
            />
          </div>

          <label className="flex cursor-pointer items-center gap-2.5 text-sm text-gray-200 pt-4 sm:pt-0">
            <input
              type="checkbox"
              checked={draft.showWatermark}
              onChange={(e) =>
                setDraft({ ...draft, showWatermark: e.target.checked })
              }
              className="h-4 w-4 accent-blue-600"
            />
            <span>Burn-in watermark on exported MP4s</span>
          </label>
        </div>
      </section>

      {/* PWA Installable App Section */}
      <section className="flex flex-col gap-4 rounded-xl border border-white/8 bg-[#12151C] p-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <Smartphone className="mt-0.5 h-5 w-5 text-blue-400 shrink-0" />
          <div>
            <h2 className="text-sm font-semibold text-white">
              Progressive Web App (PWA) Installation
            </h2>
            <p className="mt-1 text-xs text-gray-400">
              Install ClipGenius AI to your desktop or mobile home screen for standalone window mode
              and offline UI shell caching.
            </p>
          </div>
        </div>
        <div className="shrink-0">
          <PWAInstallButton />
        </div>
      </section>

      {/* Full Project Source ZIP Download */}
      <section className="flex flex-col gap-4 rounded-xl border border-white/8 bg-[#12151C] p-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <Download className="mt-0.5 h-5 w-5 text-emerald-400 shrink-0" />
          <div>
            <h2 className="text-sm font-semibold text-white">
              Download Full Source Project (.zip)
            </h2>
            <p className="mt-1 text-xs text-gray-400">
              Export the complete ClipGenius AI codebase (frontend, Express + FFmpeg backend,
              PWA assets, Dockerfile, and Netlify config) ready for deployment.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleDownloadProjectZip}
          disabled={downloadingZip}
          className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-4 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50 whitespace-nowrap shrink-0"
        >
          {downloadingZip ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          <span>{downloadingZip ? 'Preparing ZIP...' : 'Download Project ZIP'}</span>
        </button>
      </section>

      {/* Server Environment Variables Status (Read-Only) */}
      <section className="rounded-xl border border-white/8 bg-[#12151C] p-6 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-white/8 pb-3">
          <div className="flex items-center gap-2.5">
            <KeyRound className="h-4 w-4 text-blue-400 shrink-0" />
            <div>
              <h2 className="text-sm font-semibold text-white">
                Server Environment Variables Status
              </h2>
              <p className="mt-0.5 text-xs text-gray-400">
                Add OAuth secrets in the AI Studio Secrets panel (or Cloud Run env vars), then
                click Re-check to verify server connection.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={fetchEnvStatus}
            disabled={checkingEnv}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 bg-[#171B24] px-3 py-1.5 text-xs font-medium text-gray-200 hover:bg-[#222836] whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${checkingEnv ? 'animate-spin' : ''}`} />
            <span>Re-check Env</span>
          </button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[
            {
              label: 'Gemini AI Video Analysis',
              vars: 'GEMINI_API_KEY',
              connected: envStatus?.geminiApiKey ?? false,
            },
            {
              label: 'Hosted App URL',
              vars: 'APP_URL',
              connected: envStatus?.appUrl ?? false,
            },
            {
              label: 'YouTube Shorts OAuth',
              vars: 'GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET',
              connected: envStatus?.youtubeOAuth ?? false,
            },
            {
              label: 'TikTok Posting OAuth',
              vars: 'TIKTOK_CLIENT_KEY + TIKTOK_CLIENT_SECRET',
              connected: envStatus?.tiktokOAuth ?? false,
            },
            {
              label: 'Instagram Reels OAuth',
              vars: 'META_APP_ID + META_APP_SECRET',
              connected: envStatus?.instagramOAuth ?? false,
            },
            {
              label: 'CORS Allowed Origins (Optional)',
              vars: 'ALLOWED_ORIGINS',
              connected: envStatus?.allowedOrigins ?? false,
            },
          ].map((item) => (
            <div
              key={item.label}
              className="flex items-center justify-between gap-3 rounded-lg border border-white/8 bg-[#0B0D12] px-3.5 py-2.5"
            >
              <div className="min-w-0">
                <p className="text-xs font-medium text-white">{item.label}</p>
                <p className="mt-0.5 truncate font-mono text-[11px] text-gray-400">
                  {item.vars}
                </p>
              </div>
              <span
                className={`rounded px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap shrink-0 ${
                  item.connected
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : 'bg-amber-500/15 text-amber-300'
                }`}
              >
                {item.connected ? 'Connected' : 'Not Set'}
              </span>
            </div>
          ))}
        </div>
      </section>
    </form>
  );
};

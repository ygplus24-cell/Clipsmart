import React, { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Cloud,
  Copy,
  Download,
  KeyRound,
  Loader2,
  LogOut,
  RefreshCw,
  Save,
  Smartphone,
} from 'lucide-react';
import { useFirebase } from '../context/FirebaseContext';
import type {
  AppSettings,
  AspectRatioFormat,
  ClippingMode,
  DurationPreset,
  SubtitleStylePreset,
  TargetPlatform,
} from '../types';
import {
  API_BASE_URL,
  downloadFileFromUrl,
  fetchApiWithWarmupRetry,
  parseRawApiText,
} from '../utils/api';
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
  const {
    user,
    firestoreConnected,
    firestoreOffline,
    projectId: firebaseProjectId,
    databaseId: firebaseDatabaseId,
    signingIn,
    signInWithGoogle,
    signOutUser,
  } = useFirebase();
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [checkingEnv, setCheckingEnv] = useState(false);
  const [envError, setEnvError] = useState<string | null>(null);
  const [envNotice, setEnvNotice] = useState<string | null>(null);
  const [copiedUri, setCopiedUri] = useState<string | null>(null);
  const [resolvedAppUrl, setResolvedAppUrl] = useState<string | null>(null);
  const [appUrlSource, setAppUrlSource] = useState<string | null>(null);
  const [allowedOriginsList, setAllowedOriginsList] = useState<string[]>([]);
  const [oauthCallbacks, setOauthCallbacks] = useState<{
    youtube: string;
    tiktok: string;
    instagram: string;
  } | null>(null);
  const [envStatus, setEnvStatus] = useState<{
    geminiApiKey: boolean;
    appUrl: boolean;
    firebaseConfig?: boolean;
    youtubeOAuth: boolean;
    youtubePartial?: 'missing_secret' | 'missing_id';
    tiktokOAuth: boolean;
    tiktokPartial?: 'missing_secret' | 'missing_id';
    instagramOAuth: boolean;
    instagramPartial?: 'missing_secret' | 'missing_id';
    allowedOrigins: boolean;
    allowedOriginsMode?: 'explicit' | 'auto';
  } | null>(null);

  const fetchEnvStatus = useCallback(async (autoConnect = false) => {
    setCheckingEnv(true);
    setEnvError(null);
    if (autoConnect) setEnvNotice(null);
    try {
      const { res, rawText } = await fetchApiWithWarmupRetry(
        '/api/env/auto-connect',
        autoConnect ? { method: 'POST' } : undefined
      );
      const data = parseRawApiText<{
        error?: string;
        resolvedAppUrl?: string;
        appUrlSource?: string;
        allowedOriginsList?: string[];
        oauthCallbacks?: {
          youtube: string;
          tiktok: string;
          instagram: string;
        };
        envStatus?: {
          geminiApiKey: boolean;
          appUrl: boolean;
          firebaseConfig?: boolean;
          youtubeOAuth: boolean;
          youtubePartial?: 'missing_secret' | 'missing_id';
          tiktokOAuth: boolean;
          tiktokPartial?: 'missing_secret' | 'missing_id';
          instagramOAuth: boolean;
          instagramPartial?: 'missing_secret' | 'missing_id';
          allowedOrigins: boolean;
          allowedOriginsMode?: 'explicit' | 'auto';
        };
      }>(rawText, res.status, res.ok);
      if (!res.ok) {
        throw new Error(data.error || `Backend health check failed (HTTP ${res.status}).`);
      }
      if (data.envStatus) {
        setEnvStatus(data.envStatus);
      }
      if (data.resolvedAppUrl) {
        setResolvedAppUrl(data.resolvedAppUrl);
      }
      if (data.appUrlSource) {
        setAppUrlSource(data.appUrlSource);
      }
      if (Array.isArray(data.allowedOriginsList)) {
        setAllowedOriginsList(data.allowedOriginsList);
      }
      if (data.oauthCallbacks) {
        setOauthCallbacks(data.oauthCallbacks);
      }
      if (autoConnect && data.envStatus) {
        const connectedCount = [
          data.envStatus.geminiApiKey,
          data.envStatus.appUrl,
          data.envStatus.firebaseConfig ?? firestoreConnected,
          data.envStatus.allowedOrigins,
          data.envStatus.youtubeOAuth,
          data.envStatus.tiktokOAuth,
          data.envStatus.instagramOAuth,
        ].filter(Boolean).length;
        setEnvNotice(
          `Auto-connect completed: ${connectedCount}/7 environment services verified and bound.`
        );
      }
    } catch (err) {
      setEnvStatus(null);
      setEnvError(
        err instanceof Error
          ? err.message
          : 'Could not reach the Express backend server.'
      );
    } finally {
      setCheckingEnv(false);
    }
  }, [firestoreConnected]);

  const handleCopyText = async (value: string) => {
    await navigator.clipboard.writeText(value);
    setCopiedUri(value);
    setTimeout(() => setCopiedUri(null), 2000);
  };

  useEffect(() => {
    fetchEnvStatus(false);
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
      await downloadFileFromUrl(
        '/api/project/download-zip',
        'clipgenius-ai-full-project.zip'
      );
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

      {/* Firebase Cloud Sync & Authentication */}
      <section className="rounded-xl border border-white/8 bg-[#12151C] p-6 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-white/8 pb-3">
          <div className="flex items-start gap-3">
            <Cloud className="mt-0.5 h-5 w-5 text-blue-400 shrink-0" />
            <div>
              <h2 className="text-sm font-semibold text-white">
                Firebase Cloud Sync &amp; Google Authentication
              </h2>
              <p className="mt-0.5 text-xs text-gray-400">
                Sign in with Google to persist projects, clips, studio preferences, and publishing
                history to Cloud Firestore across sessions.
              </p>
            </div>
          </div>

          {user ? (
            <button
              type="button"
              onClick={() => signOutUser()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 bg-[#171B24] px-3.5 py-2 text-xs font-medium text-gray-200 hover:bg-[#222836] whitespace-nowrap shrink-0"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>Sign Out</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => signInWithGoogle()}
              disabled={signingIn}
              className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-xs font-semibold text-gray-900 hover:bg-gray-100 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              {signingIn ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-700" />
              ) : null}
              <span>{signingIn ? 'Signing in...' : 'Sign in with Google'}</span>
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-white/8 bg-[#0B0D12] px-3.5 py-2.5">
            <p className="text-[11px] text-gray-400">Firestore Connection</p>
            <p
              className={`mt-1 text-xs font-semibold ${
                firestoreOffline
                  ? 'text-rose-300'
                  : firestoreConnected
                  ? 'text-emerald-300'
                  : 'text-amber-300'
              }`}
            >
              {firestoreOffline
                ? 'Offline'
                : firestoreConnected
                ? 'Connected'
                : 'Checking...'}
            </p>
          </div>
          <div className="rounded-lg border border-white/8 bg-[#0B0D12] px-3.5 py-2.5">
            <p className="text-[11px] text-gray-400">Signed-In Account</p>
            <p className="mt-1 truncate text-xs font-medium text-white">
              {user ? user.email || user.displayName || 'Google User' : 'Not signed in'}
            </p>
          </div>
          <div className="rounded-lg border border-white/8 bg-[#0B0D12] px-3.5 py-2.5">
            <p className="text-[11px] text-gray-400">Firebase Project / DB</p>
            <p className="mt-1 truncate font-mono text-[11px] text-gray-300">
              {firebaseProjectId} · {firebaseDatabaseId}
            </p>
          </div>
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

      {/* Server Environment Variables & Auto-Connect */}
      <section className="rounded-xl border border-white/8 bg-[#12151C] p-6 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-white/8 pb-3">
          <div className="flex items-center gap-2.5">
            <KeyRound className="h-4 w-4 text-blue-400 shrink-0" />
            <div>
              <h2 className="text-sm font-semibold text-white">
                Environment Variables &amp; Auto-Connect
              </h2>
              <p className="mt-0.5 text-xs text-gray-400">
                Automatically binds runtime URLs, CORS origins, Firebase config, and `.env` /
                AI Studio Secrets aliases. Add OAuth secrets in AI Studio Secrets, then click
                Auto-Connect Env.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => fetchEnvStatus(true)}
            disabled={checkingEnv}
            className="inline-flex items-center gap-1.5 rounded-lg border border-blue-500/40 bg-blue-600/15 px-3.5 py-1.5 text-xs font-semibold text-blue-200 hover:bg-blue-600/25 whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${checkingEnv ? 'animate-spin' : ''}`} />
            <span>{checkingEnv ? 'Connecting...' : 'Auto-Connect Env'}</span>
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/8 bg-[#0B0D12] px-3.5 py-2.5 text-xs">
          <span className="text-gray-400">
            Backend API Target (<span className="font-mono text-gray-300">VITE_API_BASE_URL</span>):
          </span>
          <span className="font-mono text-emerald-300">
            {API_BASE_URL ||
              (typeof window !== 'undefined'
                ? `${window.location.origin} (Leave blank in AI Studio — auto same-origin)`
                : 'Same-origin (/api)')}
          </span>
        </div>

        {envNotice && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/35 px-4 py-2.5 text-xs text-emerald-200">
            {envNotice}
          </div>
        )}

        {envError && (
          <div
            role="alert"
            className="rounded-lg border border-rose-500/30 bg-rose-950/40 px-4 py-3 text-xs leading-relaxed text-rose-200"
          >
            {envError}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[
            {
              label: 'Gemini AI Video Analysis',
              vars: 'GEMINI_API_KEY',
              connected: envStatus?.geminiApiKey ?? false,
              badgeOverride: envStatus?.geminiApiKey ? 'Connected' : undefined,
              partial: undefined,
              callbackUri: undefined,
              envTemplate: undefined,
              copyValue: undefined,
              copyLabel: undefined,
            },
            {
              label: 'Hosted App URL',
              vars: resolvedAppUrl ? `APP_URL (${resolvedAppUrl})` : 'APP_URL',
              connected: envStatus?.appUrl ?? false,
              badgeOverride: envStatus?.appUrl
                ? appUrlSource === 'env'
                  ? 'Connected'
                  : 'Auto-Connected'
                : undefined,
              partial: undefined,
              callbackUri: undefined,
              envTemplate: undefined,
              copyValue: undefined,
              copyLabel: undefined,
            },
            {
              label: 'Firebase & Cloud Firestore',
              vars: `${firebaseProjectId} · ${firebaseDatabaseId}`,
              connected: envStatus?.firebaseConfig ?? firestoreConnected,
              badgeOverride:
                (envStatus?.firebaseConfig ?? firestoreConnected)
                  ? 'Auto-Connected'
                  : undefined,
              partial: undefined,
              callbackUri: undefined,
              envTemplate: undefined,
              copyValue: undefined,
              copyLabel: undefined,
            },
            {
              label: 'CORS Allowed Origins',
              vars:
                envStatus?.allowedOriginsMode === 'explicit'
                  ? 'ALLOWED_ORIGINS (Explicit)'
                  : `Auto-resolved (${allowedOriginsList.length || 2} origins · optional)`,
              connected: envStatus?.allowedOrigins ?? false,
              badgeOverride: envStatus?.allowedOrigins
                ? envStatus?.allowedOriginsMode === 'explicit'
                  ? 'Connected'
                  : 'Auto-Connected'
                : undefined,
              partial: undefined,
              callbackUri: undefined,
              envTemplate: undefined,
              copyValue:
                allowedOriginsList.length > 0
                  ? allowedOriginsList.filter((o) => o.startsWith('https://')).join(',') ||
                    allowedOriginsList.join(',')
                  : undefined,
              copyLabel: 'Copy Value',
            },
            {
              label: 'YouTube Shorts OAuth',
              vars: 'GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET',
              connected: envStatus?.youtubeOAuth ?? false,
              badgeOverride: undefined,
              partial: envStatus?.youtubePartial,
              callbackUri: oauthCallbacks?.youtube,
              envTemplate: 'GOOGLE_CLIENT_ID=\nGOOGLE_CLIENT_SECRET=',
              copyValue: undefined,
              copyLabel: undefined,
            },
            {
              label: 'TikTok Posting OAuth',
              vars: 'TIKTOK_CLIENT_KEY + TIKTOK_CLIENT_SECRET',
              connected: envStatus?.tiktokOAuth ?? false,
              badgeOverride: undefined,
              partial: envStatus?.tiktokPartial,
              callbackUri: oauthCallbacks?.tiktok,
              envTemplate: 'TIKTOK_CLIENT_KEY=\nTIKTOK_CLIENT_SECRET=',
              copyValue: undefined,
              copyLabel: undefined,
            },
            {
              label: 'Instagram Reels OAuth',
              vars: 'META_APP_ID + META_APP_SECRET',
              connected: envStatus?.instagramOAuth ?? false,
              badgeOverride: undefined,
              partial: envStatus?.instagramPartial,
              callbackUri: oauthCallbacks?.instagram,
              envTemplate: 'META_APP_ID=\nMETA_APP_SECRET=',
              copyValue: undefined,
              copyLabel: undefined,
            },
          ].map((item) => {
            const statusText = item.connected
              ? item.badgeOverride || 'Connected'
              : item.partial === 'missing_secret'
              ? 'Missing Secret'
              : item.partial === 'missing_id'
              ? 'Missing ID'
              : 'Not Set';
            return (
              <div
                key={item.label}
                className="rounded-lg border border-white/8 bg-[#0B0D12] px-3.5 py-2.5 space-y-2"
              >
                <div className="flex items-center justify-between gap-3">
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
                        : item.partial
                        ? 'bg-rose-500/15 text-rose-300'
                        : 'bg-amber-500/15 text-amber-300'
                    }`}
                  >
                    {statusText}
                  </span>
                </div>
                {(item.callbackUri || item.envTemplate || item.copyValue) && (
                  <div className="flex items-center justify-between gap-2 border-t border-white/6 pt-1.5">
                    <span className="truncate font-mono text-[10px] text-gray-400">
                      {item.callbackUri || item.copyValue}
                    </span>
                    <div className="flex items-center gap-2.5 shrink-0">
                      {!item.connected && item.envTemplate && (
                        <button
                          type="button"
                          onClick={() => handleCopyText(item.envTemplate!)}
                          className="inline-flex items-center gap-1 text-[10px] font-medium text-gray-300 hover:text-white"
                        >
                          {copiedUri === item.envTemplate ? (
                            <Check className="h-3 w-3 text-emerald-400" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                          <span>
                            {copiedUri === item.envTemplate ? 'Copied' : 'Copy Keys'}
                          </span>
                        </button>
                      )}
                      {item.copyValue && (
                        <button
                          type="button"
                          onClick={() => handleCopyText(item.copyValue!)}
                          className="inline-flex items-center gap-1 text-[10px] font-medium text-blue-400 hover:text-blue-300"
                        >
                          {copiedUri === item.copyValue ? (
                            <Check className="h-3 w-3 text-emerald-400" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                          <span>
                            {copiedUri === item.copyValue
                              ? 'Copied'
                              : item.copyLabel || 'Copy'}
                          </span>
                        </button>
                      )}
                      {item.callbackUri && (
                        <button
                          type="button"
                          onClick={() => handleCopyText(item.callbackUri!)}
                          className="inline-flex items-center gap-1 text-[10px] font-medium text-blue-400 hover:text-blue-300"
                        >
                          {copiedUri === item.callbackUri ? (
                            <Check className="h-3 w-3 text-emerald-400" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                          <span>
                            {copiedUri === item.callbackUri ? 'Copied' : 'Copy URI'}
                          </span>
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </form>
  );
};

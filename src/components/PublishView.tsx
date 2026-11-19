import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  CalendarClock,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Film,
  Instagram,
  Link2,
  Loader2,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  Unlink,
  Youtube,
} from 'lucide-react';
import type {
  ClipCandidate,
  PlatformConnectionInfo,
  Project,
  PublishJob,
  PublishNotification,
  PublishPlatform,
  PublishPrivacy,
} from '../types';
import { apiUrl, parseApiResponse } from '../utils/api';

interface PublishViewProps {
  projects: Project[];
  activeProject: Project | null;
  initialClipId?: string | null;
  connections: PlatformConnectionInfo[];
  jobs: PublishJob[];
  notifications: PublishNotification[];
  onRefreshPublishState: () => Promise<void>;
  onApproveClip: (
    projectId: string,
    clipId: string,
    approved: boolean
  ) => Promise<void>;
  onGoToEditor: (project: Project, clipId: string) => void;
  onGoToExport: (project: Project) => void;
}

interface TargetDraft {
  enabled: boolean;
  title: string;
  caption: string;
  hashtagsText: string;
  privacy: PublishPrivacy;
  scheduleMode: 'now' | 'scheduled';
  scheduledLocal: string;
}

const PLATFORM_META: Record<
  PublishPlatform,
  {
    name: string;
    short: string;
    accentBorder: string;
    accentText: string;
    oauthSlug: string;
    envVars: string;
  }
> = {
  youtube_shorts: {
    name: 'YouTube Shorts',
    short: 'YouTube',
    accentBorder: 'border-rose-500/40',
    accentText: 'text-rose-400',
    oauthSlug: 'youtube',
    envVars: 'GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET',
  },
  tiktok: {
    name: 'TikTok',
    short: 'TikTok',
    accentBorder: 'border-cyan-500/40',
    accentText: 'text-cyan-400',
    oauthSlug: 'tiktok',
    envVars: 'TIKTOK_CLIENT_KEY + TIKTOK_CLIENT_SECRET',
  },
  instagram_reels: {
    name: 'Instagram Reels',
    short: 'Instagram',
    accentBorder: 'border-fuchsia-500/40',
    accentText: 'text-fuchsia-400',
    oauthSlug: 'instagram',
    envVars: 'META_APP_ID + META_APP_SECRET',
  },
};

function defaultScheduleInput(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function buildInitialDrafts(clip: ClipCandidate | null): Record<PublishPlatform, TargetDraft> {
  const defaultSched = defaultScheduleInput();
  const tags = (clip?.hashtags || ['#shorts', '#viral']).join(' ');
  return {
    youtube_shorts: {
      enabled: true,
      title: clip?.title || '',
      caption: clip?.platformCaptions.youtube_shorts || clip?.socialCaption || '',
      hashtagsText: tags,
      privacy: 'public',
      scheduleMode: 'now',
      scheduledLocal: defaultSched,
    },
    tiktok: {
      enabled: true,
      title: clip?.title || '',
      caption: clip?.platformCaptions.tiktok || clip?.socialCaption || '',
      hashtagsText: tags,
      privacy: 'private',
      scheduleMode: 'now',
      scheduledLocal: defaultSched,
    },
    instagram_reels: {
      enabled: true,
      title: clip?.title || '',
      caption: clip?.platformCaptions.instagram_reels || clip?.socialCaption || '',
      hashtagsText: tags,
      privacy: 'public',
      scheduleMode: 'now',
      scheduledLocal: defaultSched,
    },
  };
}

export const PublishView: React.FC<PublishViewProps> = ({
  projects,
  activeProject,
  initialClipId,
  connections,
  jobs,
  notifications,
  onRefreshPublishState,
  onApproveClip,
  onGoToEditor,
  onGoToExport,
}) => {
  const allClipEntries = useMemo(() => {
    const items: Array<{ project: Project; clip: ClipCandidate }> = [];
    for (const proj of projects) {
      for (const clip of proj.clips) {
        items.push({ project: proj, clip });
      }
    }
    return items;
  }, [projects]);

  const initialSelection = useMemo(() => {
    if (initialClipId) {
      const found = allClipEntries.find((e) => e.clip.id === initialClipId);
      if (found) return found;
    }
    if (activeProject) {
      const preferred =
        activeProject.clips.find((c) => c.approved && c.renderStatus === 'completed') ||
        activeProject.clips.find((c) => c.renderStatus === 'completed') ||
        activeProject.clips[0];
      if (preferred) return { project: activeProject, clip: preferred };
    }
    return (
      allClipEntries.find((e) => e.clip.approved && e.clip.renderStatus === 'completed') ||
      allClipEntries.find((e) => e.clip.renderStatus === 'completed') ||
      allClipEntries[0] ||
      null
    );
  }, [allClipEntries, activeProject, initialClipId]);

  const [selectedClipKey, setSelectedClipKey] = useState<string>(
    initialSelection ? `${initialSelection.project.id}::${initialSelection.clip.id}` : ''
  );

  useEffect(() => {
    if (initialClipId) {
      const found = allClipEntries.find((e) => e.clip.id === initialClipId);
      if (found) {
        setSelectedClipKey(`${found.project.id}::${found.clip.id}`);
      }
    } else if (!selectedClipKey && initialSelection) {
      setSelectedClipKey(`${initialSelection.project.id}::${initialSelection.clip.id}`);
    }
  }, [initialClipId, initialSelection, allClipEntries, selectedClipKey]);

  const selectedEntry = useMemo(() => {
    const [pId, cId] = selectedClipKey.split('::');
    return (
      allClipEntries.find((e) => e.project.id === pId && e.clip.id === cId) ||
      initialSelection
    );
  }, [allClipEntries, selectedClipKey, initialSelection]);

  const [drafts, setDrafts] = useState<Record<PublishPlatform, TargetDraft>>(() =>
    buildInitialDrafts(selectedEntry?.clip || null)
  );
  const [activeComposerTab, setActiveComposerTab] =
    useState<PublishPlatform>('youtube_shorts');
  const [submitting, setSubmitting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [connectingPlatform, setConnectingPlatform] =
    useState<PublishPlatform | null>(null);
  const [copiedUri, setCopiedUri] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  useEffect(() => {
    if (selectedEntry?.clip) {
      setDrafts(buildInitialDrafts(selectedEntry.clip));
    }
  }, [selectedEntry?.clip?.id]);

  // Listen for OAuth popup completion messages
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const origin = event.origin || '';
      if (
        !origin.endsWith('.run.app') &&
        !origin.includes('localhost') &&
        origin !== window.location.origin
      ) {
        return;
      }
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        setConnectingPlatform(null);
        setActionError(null);
        setActionNotice('Platform account connected successfully.');
        onRefreshPublishState();
      } else if (event.data?.type === 'OAUTH_AUTH_ERROR') {
        setConnectingPlatform(null);
        setActionError(
          event.data?.error || 'OAuth authorization failed. Check your app settings.'
        );
        onRefreshPublishState();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onRefreshPublishState]);

  const hasActiveTargets = useMemo(
    () =>
      jobs.some((job) =>
        (['youtube_shorts', 'tiktok', 'instagram_reels'] as PublishPlatform[]).some(
          (p) => {
            const st = job.targets[p]?.status;
            return (
              job.targets[p]?.enabled &&
              (st === 'uploading' || st === 'processing' || st === 'scheduled')
            );
          }
        )
      ),
    [jobs]
  );

  useEffect(() => {
    if (!hasActiveTargets) return;
    const timer = window.setInterval(() => {
      onRefreshPublishState().catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [hasActiveTargets, onRefreshPublishState]);

  const handleConnect = async (platform: PublishPlatform) => {
    setConnectingPlatform(platform);
    setActionError(null);
    setActionNotice(null);
    try {
      const slug = PLATFORM_META[platform].oauthSlug;
      const res = await fetch(apiUrl(`/api/oauth/${slug}/url`));
      const data = await parseApiResponse<{ url?: string; error?: string }>(res);
      if (!res.ok || !data.url) {
        throw new Error(
          data.error || `Failed to initiate ${PLATFORM_META[platform].name} OAuth.`
        );
      }

      const authWin = window.open(
        data.url,
        'oauth_popup',
        'width=600,height=720,noopener=false'
      );
      if (!authWin) {
        throw new Error(
          'Popup blocked by your browser. Allow popups for this site to connect your account.'
        );
      }
    } catch (err) {
      setConnectingPlatform(null);
      setActionError(err instanceof Error ? err.message : 'OAuth connection error.');
    }
  };

  const handleDisconnect = async (platform: PublishPlatform) => {
    setActionError(null);
    try {
      const slug = PLATFORM_META[platform].oauthSlug;
      const res = await fetch(
        apiUrl(`/api/publish/connections/${slug}/disconnect`),
        { method: 'POST' }
      );
      await parseApiResponse(res);
      await onRefreshPublishState();
      setActionNotice(`${PLATFORM_META[platform].name} disconnected.`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Disconnect failed.');
    }
  };

  const handleCopyRedirectUri = async (uri: string) => {
    await navigator.clipboard.writeText(uri);
    setCopiedUri(uri);
    setTimeout(() => setCopiedUri(null), 2000);
  };

  const handleToggleApproveSelected = async () => {
    if (!selectedEntry) return;
    setApproving(true);
    setActionError(null);
    try {
      await onApproveClip(
        selectedEntry.project.id,
        selectedEntry.clip.id,
        !selectedEntry.clip.approved
      );
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Failed to update clip approval.'
      );
    } finally {
      setApproving(false);
    }
  };

  const handleQueuePublish = async () => {
    if (!selectedEntry) return;
    setSubmitting(true);
    setActionError(null);
    setActionNotice(null);

    try {
      const payloadTargets: Record<
        PublishPlatform,
        {
          enabled: boolean;
          title: string;
          caption: string;
          hashtags: string[];
          privacy: PublishPrivacy;
          scheduleMode: 'now' | 'scheduled';
          scheduledAt?: string;
        }
      > = {
        youtube_shorts: {
          enabled: drafts.youtube_shorts.enabled,
          title: drafts.youtube_shorts.title,
          caption: drafts.youtube_shorts.caption,
          hashtags: drafts.youtube_shorts.hashtagsText
            .split(/\s+/)
            .map((s) => s.trim())
            .filter(Boolean),
          privacy: drafts.youtube_shorts.privacy,
          scheduleMode: drafts.youtube_shorts.scheduleMode,
          scheduledAt:
            drafts.youtube_shorts.scheduleMode === 'scheduled'
              ? new Date(drafts.youtube_shorts.scheduledLocal).toISOString()
              : undefined,
        },
        tiktok: {
          enabled: drafts.tiktok.enabled,
          title: drafts.tiktok.title,
          caption: drafts.tiktok.caption,
          hashtags: drafts.tiktok.hashtagsText
            .split(/\s+/)
            .map((s) => s.trim())
            .filter(Boolean),
          privacy: drafts.tiktok.privacy,
          scheduleMode: drafts.tiktok.scheduleMode,
          scheduledAt:
            drafts.tiktok.scheduleMode === 'scheduled'
              ? new Date(drafts.tiktok.scheduledLocal).toISOString()
              : undefined,
        },
        instagram_reels: {
          enabled: drafts.instagram_reels.enabled,
          title: drafts.instagram_reels.title,
          caption: drafts.instagram_reels.caption,
          hashtags: drafts.instagram_reels.hashtagsText
            .split(/\s+/)
            .map((s) => s.trim())
            .filter(Boolean),
          privacy: drafts.instagram_reels.privacy,
          scheduleMode: drafts.instagram_reels.scheduleMode,
          scheduledAt:
            drafts.instagram_reels.scheduleMode === 'scheduled'
              ? new Date(drafts.instagram_reels.scheduledLocal).toISOString()
              : undefined,
        },
      };

      const res = await fetch(apiUrl('/api/publish/jobs'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: selectedEntry.project.id,
          clipId: selectedEntry.clip.id,
          targets: payloadTargets,
        }),
      });
      const data = await parseApiResponse<{ error?: string }>(res);
      if (!res.ok) {
        throw new Error(data.error || 'Failed to queue publishing job.');
      }

      await onRefreshPublishState();
      setActionNotice(
        'Queued in multi-platform publishing pipeline. Per-platform progress is tracked below.'
      );
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Failed to queue publishing job.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleRetryTarget = async (jobId: string, platform: PublishPlatform) => {
    setActionError(null);
    try {
      const slug = PLATFORM_META[platform].oauthSlug;
      const res = await fetch(
        apiUrl(`/api/publish/jobs/${jobId}/retry/${slug}`),
        { method: 'POST' }
      );
      const data = await parseApiResponse<{ error?: string }>(res);
      if (!res.ok) {
        throw new Error(data.error || 'Retry failed.');
      }
      await onRefreshPublishState();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Retry failed.');
    }
  };

  const handleDeleteJob = async (jobId: string) => {
    try {
      const res = await fetch(apiUrl(`/api/publish/jobs/${jobId}`), {
        method: 'DELETE',
      });
      await parseApiResponse(res);
      await onRefreshPublishState();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Delete failed.');
    }
  };

  const handleMarkNotificationsRead = async () => {
    await fetch(apiUrl('/api/publish/notifications/mark-read'), {
      method: 'POST',
    });
    await onRefreshPublishState();
  };

  const unreadAlerts = notifications.filter(
    (n) => !n.read && (n.type === 'auth_expired' || n.type === 'error')
  );

  const renderPlatformIcon = (platform: PublishPlatform, className = 'h-4 w-4') => {
    if (platform === 'youtube_shorts') {
      return <Youtube className={`${className} text-rose-400`} />;
    }
    if (platform === 'instagram_reels') {
      return <Instagram className={`${className} text-fuchsia-400`} />;
    }
    return <Film className={`${className} text-cyan-400`} />;
  };

  const activeDraft = drafts[activeComposerTab];
  const selectedClip = selectedEntry?.clip || null;
  const selectedProject = selectedEntry?.project || null;
  const canPublishClip = Boolean(
    selectedClip &&
      selectedClip.approved &&
      selectedClip.renderStatus === 'completed' &&
      selectedClip.renderedVideoUrl
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Multi-Platform Publishing
          </h1>
          <p className="mt-1 text-sm text-gray-400">
            Review-first approval, OAuth account connections, per-platform scheduling, and
            independent delivery tracking for YouTube Shorts, TikTok, and Instagram Reels.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onRefreshPublishState()}
          className="inline-flex items-center gap-2 rounded-lg border border-white/12 bg-[#171B24] px-3.5 py-2 text-xs font-medium text-gray-200 hover:bg-[#222836] whitespace-nowrap shrink-0"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          <span>Refresh Status</span>
        </button>
      </div>

      {/* Persistent Failure / Expired Connection Notifications */}
      {unreadAlerts.length > 0 && (
        <section
          role="alert"
          className="rounded-xl border border-rose-500/35 bg-rose-950/30 p-4 space-y-3"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-rose-200">
              <Bell className="h-4 w-4 text-rose-400 shrink-0" />
              <h2 className="text-sm font-semibold">
                Publishing Alerts ({unreadAlerts.length})
              </h2>
            </div>
            <button
              type="button"
              onClick={handleMarkNotificationsRead}
              className="text-xs font-medium text-rose-200/80 hover:text-white"
            >
              Acknowledge All
            </button>
          </div>
          <div className="space-y-2">
            {unreadAlerts.slice(0, 5).map((alert) => (
              <div
                key={alert.id}
                className="flex flex-col gap-2 rounded-lg border border-rose-500/20 bg-[#140E12] px-3.5 py-2.5 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-rose-200">{alert.title}</p>
                  <p className="mt-0.5 text-xs text-rose-200/80">{alert.message}</p>
                </div>
                {alert.type === 'auth_expired' && alert.platform && (
                  <button
                    type="button"
                    onClick={() => handleConnect(alert.platform!)}
                    className="rounded-md bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-500 whitespace-nowrap shrink-0"
                  >
                    Reconnect {PLATFORM_META[alert.platform].short}
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {actionError && (
        <div
          role="alert"
          className="rounded-lg border border-rose-500/30 bg-rose-950/40 px-4 py-3 text-sm text-rose-200"
        >
          {actionError}
        </div>
      )}

      {actionNotice && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-200">
          {actionNotice}
        </div>
      )}

      {/* Connected Accounts Grid */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {connections.map((conn) => {
          const meta = PLATFORM_META[conn.platform];
          const isConnected = conn.status === 'connected';
          const isExpired = conn.status === 'expired';
          const isError = conn.status === 'error';
          const isConnecting = connectingPlatform === conn.platform;

          return (
            <div
              key={conn.platform}
              className="flex flex-col justify-between rounded-xl border border-white/8 bg-[#12151C] p-5 space-y-4"
            >
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    {renderPlatformIcon(conn.platform, 'h-5 w-5')}
                    <div>
                      <h2 className="text-sm font-semibold text-white">{conn.label}</h2>
                      <p className="text-[11px] text-gray-400">
                        {conn.accountName
                          ? `${conn.accountName}${
                              conn.accountHandle ? ` (${conn.accountHandle})` : ''
                            }`
                          : conn.configured
                          ? 'Ready for OAuth sign-in'
                          : 'Server OAuth credentials not set'}
                      </p>
                    </div>
                  </div>

                  <span
                    className={`rounded px-2 py-0.5 text-[11px] font-semibold ${
                      isConnected
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : isExpired || isError
                        ? 'bg-rose-500/15 text-rose-300'
                        : conn.configured
                        ? 'bg-white/8 text-gray-300'
                        : 'bg-amber-500/15 text-amber-300'
                    }`}
                  >
                    {isConnected
                      ? 'Connected'
                      : isExpired
                      ? 'Expired'
                      : isError
                      ? 'Error'
                      : conn.configured
                      ? 'Disconnected'
                      : 'Setup Needed'}
                  </span>
                </div>

                {conn.lastError && (
                  <p className="rounded-lg border border-rose-500/25 bg-rose-950/30 px-2.5 py-2 text-xs text-rose-200">
                    {conn.lastError}
                  </p>
                )}

                <p className="text-xs leading-relaxed text-gray-400">
                  {conn.requirementsNote}
                </p>

                {!conn.configured && (
                  <div className="rounded-lg border border-amber-500/25 bg-amber-950/20 px-2.5 py-2">
                    <p className="text-[11px] font-medium text-amber-200">
                      Required Secrets:
                    </p>
                    <p className="mt-0.5 font-mono text-[11px] text-amber-300/90">
                      {meta.envVars}
                    </p>
                  </div>
                )}

                <div className="rounded-lg border border-white/8 bg-[#0B0D12] p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-gray-500">OAuth Callback URI</span>
                    <button
                      type="button"
                      onClick={() => handleCopyRedirectUri(conn.redirectUri)}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-400 hover:text-blue-300"
                    >
                      {copiedUri === conn.redirectUri ? (
                        <Check className="h-3 w-3 text-emerald-400" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      <span>{copiedUri === conn.redirectUri ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                  <p className="mt-1 truncate font-mono text-[11px] text-gray-300">
                    {conn.redirectUri}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => handleConnect(conn.platform)}
                  disabled={isConnecting}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
                >
                  {isConnecting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Link2 className="h-3.5 w-3.5" />
                  )}
                  <span>
                    {isConnected
                      ? `Reconnect ${meta.short}`
                      : isExpired
                      ? `Reconnect ${meta.short}`
                      : `Connect ${meta.short}`}
                  </span>
                </button>

                {isConnected && (
                  <button
                    type="button"
                    onClick={() => handleDisconnect(conn.platform)}
                    aria-label={`Disconnect ${conn.label}`}
                    className="inline-flex items-center justify-center rounded-lg border border-white/12 bg-[#171B24] p-2 text-gray-300 hover:bg-[#232938] hover:text-white"
                  >
                    <Unlink className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </section>

      {/* Review-First Unified Publishing Composer */}
      <section className="rounded-xl border border-white/8 bg-[#12151C] p-6 space-y-6">
        <div className="flex flex-col gap-3 border-b border-white/8 pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-white">
              Unified Publishing Queue Composer
            </h2>
            <p className="mt-0.5 text-xs text-gray-400">
              Select a rendered clip, approve it after previewing, customize captions and
              schedules per platform, and publish or schedule.
            </p>
          </div>
        </div>

        {allClipEntries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-white/12 bg-[#0B0D12] p-8 text-center">
            <p className="text-sm font-medium text-white">No Clips Available Yet</p>
            <p className="mt-1 text-xs text-gray-400">
              Analyze a video and render at least one MP4 clip before queuing multi-platform
              publishing.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            {/* Step 1 & 2: Clip Picker + Review Approval Gate */}
            <div className="lg:col-span-5 space-y-4">
              <div>
                <label
                  htmlFor="publish-clip-select"
                  className="block text-xs font-medium text-gray-300"
                >
                  1. Select Clip to Publish
                </label>
                <select
                  id="publish-clip-select"
                  value={selectedEntry ? `${selectedEntry.project.id}::${selectedEntry.clip.id}` : ''}
                  onChange={(e) => setSelectedClipKey(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-white/12 bg-[#0B0D12] px-3 py-2.5 text-sm text-white"
                >
                  {allClipEntries.map(({ project, clip }) => (
                    <option
                      key={`${project.id}::${clip.id}`}
                      value={`${project.id}::${clip.id}`}
                    >
                      [{clip.approved ? 'Approved' : 'Pending Review'} ·{' '}
                      {clip.renderStatus === 'completed' ? 'MP4 Ready' : 'Not Rendered'}] #
                      {clip.index} {clip.title} ({project.title})
                    </option>
                  ))}
                </select>
              </div>

              {selectedClip && selectedProject && (
                <div className="rounded-xl border border-white/10 bg-[#0B0D12] p-4 space-y-4">
                  <div className="flex items-start gap-3">
                    {selectedClip.thumbnailUrl ? (
                      <img
                        src={apiUrl(selectedClip.thumbnailUrl)}
                        alt={selectedClip.title}
                        referrerPolicy="no-referrer"
                        className="h-16 w-24 rounded-lg object-cover border border-white/10 shrink-0"
                      />
                    ) : (
                      <div className="flex h-16 w-24 items-center justify-center rounded-lg border border-white/10 bg-[#151923] shrink-0">
                        <Film className="h-5 w-5 text-gray-500" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-white">
                        {selectedClip.title}
                      </p>
                      <p className="mt-0.5 text-xs text-gray-400">
                        {selectedClip.outputFormat} · {selectedClip.durationSeconds}s · Score{' '}
                        {selectedClip.score.total}/100
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                        <span
                          className={`rounded px-2 py-0.5 font-medium ${
                            selectedClip.renderStatus === 'completed'
                              ? 'bg-emerald-500/15 text-emerald-300'
                              : 'bg-amber-500/15 text-amber-300'
                          }`}
                        >
                          {selectedClip.renderStatus === 'completed'
                            ? 'MP4 Rendered'
                            : 'MP4 Render Required'}
                        </span>
                        <span
                          className={`rounded px-2 py-0.5 font-medium ${
                            selectedClip.approved
                              ? 'bg-blue-500/15 text-blue-300'
                              : 'bg-white/10 text-gray-300'
                          }`}
                        >
                          {selectedClip.approved ? 'Approved' : 'Needs Approval'}
                        </span>
                      </div>
                    </div>
                  </div>

                  {selectedClip.renderedVideoUrl && (
                    <video
                      src={apiUrl(selectedClip.renderedVideoUrl)}
                      controls
                      className="max-h-56 w-full rounded-lg bg-black"
                    />
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={handleToggleApproveSelected}
                      disabled={approving}
                      className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors ${
                        selectedClip.approved
                          ? 'border border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25'
                          : 'bg-blue-600 text-white hover:bg-blue-500'
                      }`}
                    >
                      {approving ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <ShieldCheck className="h-3.5 w-3.5" />
                      )}
                      <span>
                        {selectedClip.approved
                          ? 'Approved for Publishing'
                          : 'Approve Clip'}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => onGoToEditor(selectedProject, selectedClip.id)}
                      className="rounded-lg border border-white/12 bg-[#171B24] px-3 py-2 text-xs font-medium text-gray-200 hover:bg-[#222836]"
                    >
                      Edit Clip
                    </button>

                    {selectedClip.renderStatus !== 'completed' && (
                      <button
                        type="button"
                        onClick={() => onGoToExport(selectedProject)}
                        className="rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-500/25"
                      >
                        Render MP4 in Export
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Step 3 & 4: Per-Platform Targets, Captions & Independent Scheduling */}
            <div className="lg:col-span-7 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-300">
                  2. Target Platforms (Select One, Two, or All Three)
                </label>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {(['youtube_shorts', 'tiktok', 'instagram_reels'] as PublishPlatform[]).map(
                    (plat) => {
                      const d = drafts[plat];
                      const isTab = activeComposerTab === plat;
                      return (
                        <div
                          key={plat}
                          className={`flex items-center justify-between rounded-lg border px-3 py-2.5 transition-colors ${
                            isTab
                              ? 'border-blue-500 bg-blue-500/10'
                              : 'border-white/10 bg-[#0B0D12]'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => setActiveComposerTab(plat)}
                            className="flex items-center gap-2 text-left min-w-0 flex-1"
                          >
                            {renderPlatformIcon(plat)}
                            <span className="truncate text-xs font-semibold text-white">
                              {PLATFORM_META[plat].short}
                            </span>
                          </button>
                          <input
                            type="checkbox"
                            checked={d.enabled}
                            aria-label={`Include ${PLATFORM_META[plat].name}`}
                            onChange={(e) => {
                              setDrafts((prev) => ({
                                ...prev,
                                [plat]: { ...prev[plat], enabled: e.target.checked },
                              }));
                              setActiveComposerTab(plat);
                            }}
                            className="h-4 w-4 accent-blue-600 cursor-pointer"
                          />
                        </div>
                      );
                    }
                  )}
                </div>
              </div>

              {/* Active Platform Customization Panel */}
              <div className="rounded-xl border border-white/10 bg-[#0B0D12] p-4 space-y-4">
                <div className="flex items-center justify-between border-b border-white/8 pb-3">
                  <div className="flex items-center gap-2">
                    {renderPlatformIcon(activeComposerTab)}
                    <h3 className="text-sm font-semibold text-white">
                      {PLATFORM_META[activeComposerTab].name} Configuration
                    </h3>
                  </div>
                  <span className="text-xs text-gray-400">
                    {activeDraft.enabled ? 'Included in Queue' : 'Excluded'}
                  </span>
                </div>

                {activeComposerTab === 'youtube_shorts' && (
                  <div>
                    <label className="block text-xs font-medium text-gray-300">
                      Shorts Title
                    </label>
                    <input
                      type="text"
                      value={activeDraft.title}
                      onChange={(e) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [activeComposerTab]: {
                            ...prev[activeComposerTab],
                            title: e.target.value,
                          },
                        }))
                      }
                      className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#12151C] px-3 py-2 text-sm text-white"
                    />
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-gray-300">
                    Platform Caption
                  </label>
                  <textarea
                    rows={3}
                    value={activeDraft.caption}
                    onChange={(e) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [activeComposerTab]: {
                          ...prev[activeComposerTab],
                          caption: e.target.value,
                        },
                      }))
                    }
                    className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#12151C] px-3 py-2 text-sm text-white"
                  />
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs font-medium text-gray-300">
                      Hashtags
                    </label>
                    <input
                      type="text"
                      value={activeDraft.hashtagsText}
                      onChange={(e) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [activeComposerTab]: {
                            ...prev[activeComposerTab],
                            hashtagsText: e.target.value,
                          },
                        }))
                      }
                      placeholder="#shorts #viral #podcast"
                      className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#12151C] px-3 py-2 font-mono text-xs text-blue-300"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-300">
                      Visibility
                    </label>
                    <select
                      value={activeDraft.privacy}
                      onChange={(e) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [activeComposerTab]: {
                            ...prev[activeComposerTab],
                            privacy: e.target.value as PublishPrivacy,
                          },
                        }))
                      }
                      className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#12151C] px-3 py-2 text-xs text-white"
                    >
                      <option value="public">Public</option>
                      <option value="unlisted">Unlisted / Followers</option>
                      <option value="private">
                        Private {activeComposerTab === 'tiktok' ? '(Required if Unaudited)' : ''}
                      </option>
                    </select>
                  </div>
                </div>

                {/* Independent Per-Platform Schedule */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 pt-2 border-t border-white/8 items-end">
                  <div>
                    <label className="block text-xs font-medium text-gray-300">
                      Publishing Timing ({PLATFORM_META[activeComposerTab].short})
                    </label>
                    <div className="mt-1.5 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setDrafts((prev) => ({
                            ...prev,
                            [activeComposerTab]: {
                              ...prev[activeComposerTab],
                              scheduleMode: 'now',
                            },
                          }))
                        }
                        className={`rounded-lg border px-3 py-2 text-xs font-medium ${
                          activeDraft.scheduleMode === 'now'
                            ? 'border-blue-500 bg-blue-500/15 text-white'
                            : 'border-white/10 bg-[#12151C] text-gray-400'
                        }`}
                      >
                        Publish Now
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setDrafts((prev) => ({
                            ...prev,
                            [activeComposerTab]: {
                              ...prev[activeComposerTab],
                              scheduleMode: 'scheduled',
                            },
                          }))
                        }
                        className={`rounded-lg border px-3 py-2 text-xs font-medium ${
                          activeDraft.scheduleMode === 'scheduled'
                            ? 'border-blue-500 bg-blue-500/15 text-white'
                            : 'border-white/10 bg-[#12151C] text-gray-400'
                        }`}
                      >
                        Schedule
                      </button>
                    </div>
                  </div>

                  {activeDraft.scheduleMode === 'scheduled' && (
                    <div>
                      <label className="block text-xs font-medium text-gray-300">
                        Scheduled Date & Time
                      </label>
                      <input
                        type="datetime-local"
                        value={activeDraft.scheduledLocal}
                        onChange={(e) =>
                          setDrafts((prev) => ({
                            ...prev,
                            [activeComposerTab]: {
                              ...prev[activeComposerTab],
                              scheduledLocal: e.target.value,
                            },
                          }))
                        }
                        className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#12151C] px-3 py-2 font-mono text-xs text-white"
                      />
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between pt-1">
                <p className="text-xs text-gray-400">
                  {!selectedClip?.approved
                    ? 'Approve the clip on the left before publishing.'
                    : selectedClip?.renderStatus !== 'completed'
                    ? 'Render the clip to MP4 in Export before publishing.'
                    : 'Ready to dispatch to selected platforms.'}
                </p>

                <button
                  type="button"
                  onClick={handleQueuePublish}
                  disabled={submitting || !canPublishClip}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-45 whitespace-nowrap shrink-0"
                >
                  {submitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                  <span>
                    {submitting
                      ? 'Queuing...'
                      : 'Publish / Schedule Selected Platforms'}
                  </span>
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Unified Publishing Queue & History */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">
            Publishing Queue & History ({jobs.length})
          </h2>
        </div>

        {jobs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/12 bg-[#12151C] p-10 text-center">
            <CalendarClock className="mx-auto h-8 w-8 text-gray-500" />
            <p className="mt-3 text-sm font-medium text-white">
              No Publishing Jobs Queued Yet
            </p>
            <p className="mt-1 text-xs text-gray-400">
              Approve a rendered clip above to publish or schedule it independently across
              YouTube Shorts, TikTok, and Instagram Reels.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {jobs.map((job) => (
              <div
                key={job.id}
                className="rounded-xl border border-white/8 bg-[#12151C] p-5 space-y-4"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-white/8 pb-4">
                  <div className="flex items-center gap-3 min-w-0">
                    {job.clipThumbnailUrl ? (
                      <img
                        src={apiUrl(job.clipThumbnailUrl)}
                        alt={job.clipTitle}
                        referrerPolicy="no-referrer"
                        className="h-12 w-20 rounded-lg object-cover border border-white/10 shrink-0"
                      />
                    ) : (
                      <div className="flex h-12 w-20 items-center justify-center rounded-lg bg-[#0B0D12] border border-white/10 shrink-0">
                        <Film className="h-4 w-4 text-gray-500" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold text-white">
                        {job.clipTitle}
                      </h3>
                      <p className="mt-0.5 text-xs text-gray-400 truncate">
                        {job.projectTitle} · Approved{' '}
                        {new Date(job.approvedAt).toLocaleString()}
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleDeleteJob(job.id)}
                    aria-label={`Delete publishing job ${job.clipTitle}`}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#171B24] px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-rose-950/50 hover:text-rose-200 self-start sm:self-auto"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Remove</span>
                  </button>
                </div>

                {/* Independent Per-Platform Result Cards */}
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  {(['youtube_shorts', 'tiktok', 'instagram_reels'] as PublishPlatform[]).map(
                    (plat) => {
                      const target = job.targets[plat];
                      if (!target?.enabled) {
                        return (
                          <div
                            key={plat}
                            className="rounded-lg border border-white/6 bg-[#0B0D12]/60 p-3.5 opacity-60"
                          >
                            <div className="flex items-center gap-2 text-xs text-gray-400">
                              {renderPlatformIcon(plat)}
                              <span>{PLATFORM_META[plat].name}</span>
                            </div>
                            <p className="mt-2 text-xs text-gray-500">Not selected</p>
                          </div>
                        );
                      }

                      const isPublished = target.status === 'published';
                      const isAuthExpired = target.status === 'auth_expired';
                      const isFailed = target.status === 'failed';
                      const isScheduled = target.status === 'scheduled';
                      const isRunning =
                        target.status === 'uploading' || target.status === 'processing';

                      return (
                        <div
                          key={plat}
                          className="flex flex-col justify-between rounded-lg border border-white/10 bg-[#0B0D12] p-3.5 space-y-3"
                        >
                          <div className="space-y-2">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                {renderPlatformIcon(plat)}
                                <span className="text-xs font-semibold text-white">
                                  {PLATFORM_META[plat].name}
                                </span>
                              </div>
                              <span
                                className={`rounded px-2 py-0.5 text-[11px] font-semibold ${
                                  isPublished
                                    ? 'bg-emerald-500/15 text-emerald-300'
                                    : isAuthExpired || isFailed
                                    ? 'bg-rose-500/15 text-rose-300'
                                    : isScheduled
                                    ? 'bg-amber-500/15 text-amber-300'
                                    : 'bg-blue-500/15 text-blue-300'
                                }`}
                              >
                                {isPublished
                                  ? 'Published'
                                  : isAuthExpired
                                  ? 'Auth Expired'
                                  : isFailed
                                  ? 'Failed'
                                  : isScheduled
                                  ? 'Scheduled'
                                  : target.status === 'processing'
                                  ? 'Processing'
                                  : 'Uploading'}
                              </span>
                            </div>

                            {isScheduled && target.scheduledAt && (
                              <p className="flex items-center gap-1.5 text-xs text-amber-200">
                                <CalendarClock className="h-3.5 w-3.5 shrink-0" />
                                <span>
                                  {new Date(target.scheduledAt).toLocaleString()}
                                </span>
                              </p>
                            )}

                            {isRunning && (
                              <div className="space-y-1">
                                <div className="flex items-center justify-between text-[11px] text-blue-300">
                                  <span>
                                    {target.status === 'processing'
                                      ? 'Platform processing...'
                                      : 'Uploading MP4...'}
                                  </span>
                                  <span className="font-mono tabular-nums">
                                    {target.progress}%
                                  </span>
                                </div>
                                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                                  <div
                                    className="h-full bg-blue-500 transition-all"
                                    style={{ width: `${target.progress}%` }}
                                  />
                                </div>
                              </div>
                            )}

                            {(isFailed || isAuthExpired) && target.errorMessage && (
                              <div className="flex items-start gap-1.5 rounded border border-rose-500/25 bg-rose-950/30 p-2 text-[11px] text-rose-200">
                                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" />
                                <span>{target.errorMessage}</span>
                              </div>
                            )}

                            {isPublished && (
                              <div className="flex items-center gap-1.5 text-xs text-emerald-300">
                                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                                <span>Live on {PLATFORM_META[plat].short}</span>
                              </div>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            {target.publishedUrl && (
                              <a
                                href={target.publishedUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-200 hover:bg-emerald-500/25"
                              >
                                <ExternalLink className="h-3 w-3" />
                                <span>Open Post</span>
                              </a>
                            )}

                            {isAuthExpired && (
                              <button
                                type="button"
                                onClick={() => handleConnect(plat)}
                                className="rounded-md bg-rose-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-rose-500"
                              >
                                Reconnect
                              </button>
                            )}

                            {(isFailed || isAuthExpired) && (
                              <button
                                type="button"
                                onClick={() => handleRetryTarget(job.id, plat)}
                                className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-[#171B24] px-2.5 py-1 text-xs font-medium text-white hover:bg-[#222836]"
                              >
                                <RefreshCw className="h-3 w-3" />
                                <span>Retry</span>
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    }
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

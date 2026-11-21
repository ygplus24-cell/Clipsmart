import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Cloud,
  Download,
  Film,
  LayoutDashboard,
  Loader2,
  LogIn,
  LogOut,
  Menu,
  Plus,
  RefreshCw,
  Scissors,
  Send,
  Settings,
  User,
  X,
} from 'lucide-react';
import { AnalysisView } from './components/AnalysisView';
import { ClipEditorView } from './components/ClipEditorView';
import { DashboardView } from './components/DashboardView';
import { ExportView } from './components/ExportView';
import { NewProjectView } from './components/NewProjectView';
import { OfflineIndicator } from './components/OfflineIndicator';
import { PublishView } from './components/PublishView';
import { PWAInstallButton } from './components/PWAInstallButton';
import { SettingsView } from './components/SettingsView';
import { useFirebase } from './context/FirebaseContext';
import { usePWAInstall } from './hooks/usePWAInstall';
import type {
  AppSettings,
  AppView,
  ClipCandidate,
  ExportQualityMode,
  PlatformConnectionInfo,
  Project,
  PublishJob,
  PublishNotification,
  ReadyMp4Download,
} from './types';
import {
  apiUrl,
  buildClipDownloadFilename,
  fetchApiWithWarmupRetry,
  parseApiResponse,
  parseRawApiText,
  triggerNativeAnchorDownload,
} from './utils/api';
import {
  deleteProjectFromFirestore,
  loadPreferencesFromFirestore,
  savePreferencesToFirestore,
  subscribeUserProjects,
  subscribeUserPublishJobs,
  syncProjectAndClipsToFirestore,
  syncPublishJobToFirestore,
} from './utils/firestoreSync';

function formatFirestoreUiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/resource-exhausted|quota exceeded/i.test(raw)) {
    return 'Quota exceeded. Firestore usage limit reached — your studio changes remain saved locally.';
  }
  try {
    const parsed = JSON.parse(raw) as { error?: string; operationType?: string; path?: string };
    if (parsed && typeof parsed.error === 'string') {
      if (/resource-exhausted|quota exceeded/i.test(parsed.error)) {
        return 'Quota exceeded. Firestore usage limit reached — your studio changes remain saved locally.';
      }
      return `Firestore ${parsed.operationType || 'sync'} failed${parsed.path ? ` (${parsed.path})` : ''}: ${parsed.error}`;
    }
  } catch {
    // Not JSON
  }
  return raw;
}

function projectSyncSignature(p: Project): string {
  const clipSig = (p.clips || [])
    .map(
      (c) =>
        `${c.id}:${c.renderStatus}:${c.approved ? 1 : 0}:${c.selected ? 1 : 0}:${c.startSeconds}-${c.endSeconds}:${c.renderedVideoUrl || ''}:${c.title}`
    )
    .join(',');
  return `${p.updatedAt}|${p.status}|${p.analysisStage}|${p.clips?.length || 0}|${clipSig}`;
}

const DEFAULT_SETTINGS: AppSettings = {
  defaultDurationPreset: '30-60',
  defaultOutputFormat: '9:16',
  defaultClippingMode: 'auto',
  defaultPlatforms: ['tiktok', 'youtube_shorts', 'instagram_reels', 'facebook'],
  defaultSubtitleStyle: 'bold_impact',
  subtitleFontSize: 54,
  subtitleAccentColor: '#F59E0B',
  subtitlePosition: 'lower_third',
  subtitleUppercase: true,
  brandWatermark: 'ClipGenius AI',
  showWatermark: false,
  geminiModel: 'gemini-4-hydrogen',
};

const NAV_ITEMS: Array<{
  id: AppView;
  label: string;
  icon: React.FC<{ className?: string }>;
}> = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'new-project', label: 'New Project', icon: Plus },
  { id: 'analysis', label: 'AI Analysis', icon: Activity },
  { id: 'editor', label: 'Clip Editor', icon: Scissors },
  { id: 'export', label: 'Export', icon: Download },
  { id: 'publish', label: 'Publish', icon: Send },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export default function App() {
  const {
    user,
    authReady,
    firebaseError,
    signingIn,
    signInWithGoogle,
    signOutUser,
    clearFirebaseError,
  } = useFirebase();

  const [view, setView] = useState<AppView>('dashboard');
  const [expressProjects, setExpressProjects] = useState<Project[]>([]);
  const [cloudProjects, setCloudProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeClipId, setActiveClipId] = useState<string | null>(null);
  const [exportQuality, setExportQuality] = useState<ExportQualityMode>('best');
  const [readyMp4Download, setReadyMp4Download] = useState<ReadyMp4Download | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [publishConnections, setPublishConnections] = useState<PlatformConnectionInfo[]>([]);
  const [expressPublishJobs, setExpressPublishJobs] = useState<PublishJob[]>([]);
  const [cloudPublishJobs, setCloudPublishJobs] = useState<PublishJob[]>([]);
  const [publishNotifications, setPublishNotifications] = useState<PublishNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [quotaPaused, setQuotaPaused] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [avatarError, setAvatarError] = useState(false);
  const [dismissedMobileInstall, setDismissedMobileInstall] = useState(false);
  const { isInstalled } = usePWAInstall();

  const syncedProjectsRef = useRef<Map<string, string>>(new Map());
  const syncedJobsRef = useRef<Map<string, string>>(new Map());
  const deletedIdsRef = useRef<Set<string>>(new Set());
  const activeSyncProjectIdsRef = useRef<Set<string>>(new Set());
  const cloudProjectIdsRef = useRef<Set<string>>(new Set());
  const isSyncingRecordsRef = useRef(false);
  const syncRerunRequestedRef = useRef(false);

  const projects = useMemo(() => {
    const map = new Map<string, Project>();
    for (const cp of cloudProjects) {
      if (!deletedIdsRef.current.has(cp.id)) {
        map.set(cp.id, cp);
      }
    }
    for (const ep of expressProjects) {
      if (deletedIdsRef.current.has(ep.id)) continue;
      const existing = map.get(ep.id);
      if (!existing) {
        map.set(ep.id, ep);
      } else {
        const epTime = new Date(ep.updatedAt || ep.createdAt || 0).getTime();
        const cpTime = new Date(existing.updatedAt || existing.createdAt || 0).getTime();
        if (ep.status === 'processing' || epTime >= cpTime) {
          map.set(ep.id, ep);
        }
      }
    }
    return Array.from(map.values()).sort(
      (a, b) =>
        new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    );
  }, [cloudProjects, expressProjects]);

  const publishJobs = useMemo(() => {
    const map = new Map<string, PublishJob>();
    for (const cj of cloudPublishJobs) {
      map.set(cj.id, cj);
    }
    for (const ej of expressPublishJobs) {
      const existing = map.get(ej.id);
      if (!existing) {
        map.set(ej.id, ej);
      } else {
        const ejTime = new Date(ej.updatedAt || ej.createdAt || 0).getTime();
        const cjTime = new Date(existing.updatedAt || existing.createdAt || 0).getTime();
        if (ejTime >= cjTime) {
          map.set(ej.id, ej);
        }
      }
    }
    return Array.from(map.values()).sort(
      (a, b) =>
        new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    );
  }, [cloudPublishJobs, expressPublishJobs]);

  const loadPublishState = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/publish/state'));
      if (res.ok) {
        const data = await parseApiResponse<{
          connections: PlatformConnectionInfo[];
          jobs: PublishJob[];
          notifications: PublishNotification[];
        }>(res);
        setPublishConnections(data.connections || []);
        setExpressPublishJobs(data.jobs || []);
        setPublishNotifications(data.notifications || []);
      }
    } catch {
      // Ignore transient load error
    }
  }, []);

  const loadWorkspace = useCallback(async () => {
    setBackendError(null);
    setLoading(true);
    try {
      const [projResp, setResp] = await Promise.all([
        fetchApiWithWarmupRetry('/api/projects'),
        fetchApiWithWarmupRetry('/api/settings'),
        fetchApiWithWarmupRetry('/api/env/auto-connect', { method: 'POST' }).catch(
          () => null
        ),
      ]);
      const data = parseRawApiText<{ projects?: Project[]; error?: string }>(
        projResp.rawText,
        projResp.res.status,
        projResp.res.ok
      );
      if (!projResp.res.ok) {
        throw new Error(
          data.error || `Failed to reach backend API (HTTP ${projResp.res.status}).`
        );
      }
      setExpressProjects(data.projects || []);
      setActiveProjectId((prev) => prev || data.projects?.[0]?.id || null);

      if (setResp.res.ok) {
        const sData = parseRawApiText<{ settings?: AppSettings }>(
          setResp.rawText,
          setResp.res.status,
          setResp.res.ok
        );
        if (sData.settings) {
          setAppSettings(sData.settings);
        }
      }
      await loadPublishState();
    } catch (err) {
      setBackendError(
        err instanceof Error
          ? err.message
          : 'Could not connect to the Express backend server.'
      );
    } finally {
      setLoading(false);
    }
  }, [loadPublishState]);

  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);

  // Real-time Firestore listeners when authenticated with verified Google email
  useEffect(() => {
    if (!authReady) return;
    if (!user || !user.emailVerified) {
      setCloudProjects([]);
      setCloudPublishJobs([]);
      syncedProjectsRef.current.clear();
      syncedJobsRef.current.clear();
      return;
    }

    let active = true;
    setAvatarError(false);

    loadPreferencesFromFirestore(user.uid)
      .then((cloudPrefs) => {
        if (active && cloudPrefs) {
          setAppSettings(cloudPrefs);
        }
      })
      .catch((err) => {
        if (active) {
          const msg = formatFirestoreUiError(err);
          if (/Quota exceeded/i.test(msg)) setQuotaPaused(true);
          setSyncError(msg);
        }
      });

    const unsubProjects = subscribeUserProjects(
      user.uid,
      (nextCloudProjects) => {
        if (!active) return;
        cloudProjectIdsRef.current = new Set(nextCloudProjects.map((cp) => cp.id));
        for (const cp of nextCloudProjects) {
          if (!activeSyncProjectIdsRef.current.has(cp.id)) {
            syncedProjectsRef.current.set(cp.id, projectSyncSignature(cp));
          }
        }
        setCloudProjects(nextCloudProjects);
        setActiveProjectId((prev) => prev || nextCloudProjects[0]?.id || null);
      },
      (err) => {
        if (!active) return;
        const msg = formatFirestoreUiError(err);
        if (/Quota exceeded/i.test(msg)) setQuotaPaused(true);
        setSyncError(msg);
      }
    );

    const unsubJobs = subscribeUserPublishJobs(
      user.uid,
      (nextCloudJobs) => {
        if (!active) return;
        for (const cj of nextCloudJobs) {
          syncedJobsRef.current.set(cj.id, cj.updatedAt);
        }
        setCloudPublishJobs(nextCloudJobs);
      },
      (err) => {
        if (!active) return;
        const msg = formatFirestoreUiError(err);
        if (/Quota exceeded/i.test(msg)) setQuotaPaused(true);
        setSyncError(msg);
      }
    );

    return () => {
      active = false;
      unsubProjects();
      unsubJobs();
    };
  }, [authReady, user]);

  // Auto-sync Express project and publish job changes to Cloud Firestore (single-flight serialized)
  const latestExpressProjectsRef = useRef<Project[]>(expressProjects);
  const latestExpressJobsRef = useRef<PublishJob[]>(expressPublishJobs);
  latestExpressProjectsRef.current = expressProjects;
  latestExpressJobsRef.current = expressPublishJobs;

  useEffect(() => {
    if (!authReady || !user || !user.emailVerified || quotaPaused) return;
    let unmounted = false;

    const runSyncPass = async () => {
      if (isSyncingRecordsRef.current) {
        syncRerunRequestedRef.current = true;
        return;
      }
      isSyncingRecordsRef.current = true;
      try {
        do {
          syncRerunRequestedRef.current = false;
          const currentProjects = latestExpressProjectsRef.current;
          const currentJobs = latestExpressJobsRef.current;
          const syncedProjectIds = new Set<string>([
            ...cloudProjectIdsRef.current,
            ...syncedProjectsRef.current.keys(),
          ]);

          for (const proj of currentProjects) {
            if (unmounted) return;
            if (deletedIdsRef.current.has(proj.id)) continue;

            const sig = projectSyncSignature(proj);
            const prevSig = syncedProjectsRef.current.get(proj.id);

            // Avoid redundant mid-analysis writes every 2s poll; sync on initial creation & when settled/updated
            if (prevSig === sig) continue;
            if (proj.status === 'processing' && prevSig !== undefined) continue;

            activeSyncProjectIdsRef.current.add(proj.id);
            try {
              await syncProjectAndClipsToFirestore(user.uid, proj);
              syncedProjectsRef.current.set(proj.id, sig);
              syncedProjectIds.add(proj.id);
              setSyncError(null);
            } catch (err) {
              const msg = formatFirestoreUiError(err);
              if (/Quota exceeded/i.test(msg)) {
                setQuotaPaused(true);
              }
              setSyncError(msg);
              return;
            } finally {
              activeSyncProjectIdsRef.current.delete(proj.id);
            }
          }

          for (const job of currentJobs) {
            if (unmounted) return;
            const prevJobUpdated = syncedJobsRef.current.get(job.id);
            if (prevJobUpdated === job.updatedAt) continue;
            // Parent project must exist in Firestore to satisfy publishJobs create rule
            if (!syncedProjectIds.has(job.projectId)) continue;

            try {
              await syncPublishJobToFirestore(user.uid, job);
              syncedJobsRef.current.set(job.id, job.updatedAt);
              setSyncError(null);
            } catch (err) {
              const msg = formatFirestoreUiError(err);
              if (/Quota exceeded/i.test(msg)) {
                setQuotaPaused(true);
              }
              setSyncError(msg);
              return;
            }
          }
        } while (syncRerunRequestedRef.current && !unmounted);
      } finally {
        isSyncingRecordsRef.current = false;
      }
    };

    void runSyncPass();

    return () => {
      unmounted = true;
    };
  }, [authReady, user, quotaPaused, expressProjects, expressPublishJobs]);

  // Ensure Firestore-restored projects also exist in Express store for MP4/ZIP/SRT downloads
  const rehydratedIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (cloudProjects.length === 0) return;
    const expressIds = new Set(expressProjects.map((p) => p.id));
    const missing = cloudProjects.filter(
      (cp) =>
        !expressIds.has(cp.id) &&
        !deletedIdsRef.current.has(cp.id) &&
        !rehydratedIdsRef.current.has(cp.id)
    );
    if (missing.length === 0) return;

    let cancelled = false;
    const syncMissing = async () => {
      for (const cp of missing) {
        if (cancelled) return;
        rehydratedIdsRef.current.add(cp.id);
        try {
          const res = await fetch(apiUrl('/api/projects/sync'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project: cp }),
          });
          if (!res.ok) {
            rehydratedIdsRef.current.delete(cp.id);
            continue;
          }
          const data = await parseApiResponse<{ project?: Project }>(res);
          if (data.project && !cancelled) {
            syncedProjectsRef.current.set(
              data.project.id,
              projectSyncSignature(data.project)
            );
            setExpressProjects((prev) =>
              prev.some((p) => p.id === data.project!.id)
                ? prev
                : [...prev, data.project!]
            );
          }
        } catch {
          rehydratedIdsRef.current.delete(cp.id);
        }
      }
    };
    void syncMissing();
    return () => {
      cancelled = true;
    };
  }, [cloudProjects, expressProjects]);

  const hasProcessing = useMemo(
    () => expressProjects.some((p) => p.status === 'processing'),
    [expressProjects]
  );

  useEffect(() => {
    if (!hasProcessing) return;
    const timer = window.setInterval(async () => {
      try {
        const res = await fetch(apiUrl('/api/projects'));
        if (res.ok) {
          const data = await parseApiResponse<{ projects: Project[] }>(res);
          setExpressProjects(data.projects || []);
        }
      } catch {
        // Ignore transient poll errors
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [hasProcessing]);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) || null,
    [projects, activeProjectId]
  );

  const isActiveProjectSyncedOnExpress = useMemo(
    () =>
      Boolean(
        activeProject && expressProjects.some((p) => p.id === activeProject.id)
      ),
    [activeProject, expressProjects]
  );

  const handleProjectCreated = (project: Project) => {
    deletedIdsRef.current.delete(project.id);
    setExpressProjects((prev) => [project, ...prev.filter((p) => p.id !== project.id)]);
    setActiveProjectId(project.id);
    setActiveClipId(null);
    setReadyMp4Download(null);
    setView('analysis');
  };

  const handleSelectProject = (
    project: Project,
    targetView: 'analysis' | 'editor' | 'export' = 'analysis'
  ) => {
    setActiveProjectId(project.id);
    setActiveClipId(project.clips[0]?.id || null);
    setReadyMp4Download(null);
    setView(targetView);
  };

  const handleDeleteProject = async (projectId: string) => {
    deletedIdsRef.current.add(projectId);
    const res = await fetch(apiUrl(`/api/projects/${projectId}`), {
      method: 'DELETE',
    });

    if (res.ok || res.status === 404) {
      setExpressProjects((prev) => prev.filter((p) => p.id !== projectId));
      setCloudProjects((prev) => prev.filter((p) => p.id !== projectId));
      if (activeProjectId === projectId) {
        const remaining = projects.filter((p) => p.id !== projectId);
        setActiveProjectId(remaining[0]?.id || null);
        setActiveClipId(null);
      }

      if (user && user.emailVerified) {
        try {
          await deleteProjectFromFirestore(user.uid, projectId);
          syncedProjectsRef.current.delete(projectId);
        } catch (err) {
          setSyncError(formatFirestoreUiError(err));
        }
      }
    } else {
      deletedIdsRef.current.delete(projectId);
    }
  };

  const handleUpdateClip = async (
    clipId: string,
    patch: Partial<ClipCandidate>
  ) => {
    if (!activeProject) return;
    const res = await fetch(
      apiUrl(`/api/projects/${activeProject.id}/clips/${clipId}`),
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }
    );
    const data = await parseApiResponse<{ project?: Project; error?: string }>(res);
    if (!res.ok || !data.project) {
      throw new Error(data.error || 'Failed to update clip.');
    }
    setExpressProjects((prev) =>
      prev.map((p) => (p.id === data.project!.id ? data.project! : p))
    );
  };

  const handleApproveClip = async (
    projectId: string,
    clipId: string,
    approved: boolean
  ) => {
    const res = await fetch(apiUrl(`/api/projects/${projectId}/clips/${clipId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved }),
    });
    const data = await parseApiResponse<{ project?: Project; error?: string }>(res);
    if (!res.ok || !data.project) {
      throw new Error(data.error || 'Failed to update clip approval.');
    }
    setExpressProjects((prev) =>
      prev.map((p) => (p.id === data.project!.id ? data.project! : p))
    );
  };

  const handleSelectBatchPreset = async (mode: 'top5' | 'all' | 'none') => {
    if (!activeProject) return;
    const sorted = [...activeProject.clips].sort(
      (a, b) => b.score.total - a.score.total
    );
    const topIds = new Set(sorted.slice(0, 5).map((c) => c.id));

    await Promise.all(
      activeProject.clips.map((clip) => {
        const nextSelected =
          mode === 'all' ? true : mode === 'none' ? false : topIds.has(clip.id);
        if (clip.selected === nextSelected) return Promise.resolve();
        return handleUpdateClip(clip.id, { selected: nextSelected });
      })
    );
  };

  const handleRenderClip = async (
    clipId: string,
    quality: ExportQualityMode = exportQuality
  ) => {
    if (!activeProject) return;
    setExpressProjects((prev) =>
      prev.map((p) =>
        p.id === activeProject.id
          ? {
              ...p,
              clips: p.clips.map((c) =>
                c.id === clipId ? { ...c, renderStatus: 'rendering' } : c
              ),
            }
          : p
      )
    );

    const res = await fetch(
      apiUrl(
        `/api/projects/${activeProject.id}/clips/${clipId}/render?quality=${encodeURIComponent(
          quality
        )}`
      ),
      { method: 'POST' }
    );
    const data = await parseApiResponse<{ project?: Project; error?: string }>(res);
    if (data.project) {
      setExpressProjects((prev) =>
        prev.map((p) => (p.id === data.project!.id ? data.project! : p))
      );
    }
    if (!res.ok) {
      throw new Error(data.error || 'FFmpeg render failed.');
    }
  };

  const handleRenderBatch = async (quality: ExportQualityMode = exportQuality) => {
    if (!activeProject) return;
    const res = await fetch(
      apiUrl(
        `/api/projects/${activeProject.id}/render-batch?quality=${encodeURIComponent(
          quality
        )}`
      ),
      {
        method: 'POST',
      }
    );
    const data = await parseApiResponse<{ project?: Project; error?: string }>(res);
    if (data.project) {
      setExpressProjects((prev) =>
        prev.map((p) => (p.id === data.project!.id ? data.project! : p))
      );
    }
    if (!res.ok) {
      throw new Error(data.error || 'Batch render failed.');
    }
  };

  const handleMarkDirectMp4Download = (
    clip: ClipCandidate,
    quality: ExportQualityMode = exportQuality
  ) => {
    if (!activeProject) return;
    setReadyMp4Download({
      clipId: clip.id,
      clipTitle: clip.title,
      url: `/api/projects/${activeProject.id}/clips/${clip.id}/download?quality=${encodeURIComponent(
        quality
      )}`,
      filename: buildClipDownloadFilename(clip),
      quality,
    });
  };

  const handleDownloadClip = async (
    clip: ClipCandidate,
    quality: ExportQualityMode = exportQuality
  ) => {
    if (!activeProject) return;
    let currentProject = expressProjects.find((p) => p.id === activeProject.id);
    if (!currentProject) {
      const syncRes = await fetch(apiUrl('/api/projects/sync'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: activeProject }),
      });
      if (syncRes.ok) {
        const syncData = await parseApiResponse<{ project?: Project }>(syncRes);
        if (syncData.project) {
          currentProject = syncData.project;
          syncedProjectsRef.current.set(
            syncData.project.id,
            projectSyncSignature(syncData.project)
          );
          setExpressProjects((prev) =>
            prev.some((p) => p.id === syncData.project!.id)
              ? prev.map((p) => (p.id === syncData.project!.id ? syncData.project! : p))
              : [...prev, syncData.project!]
          );
        }
      }
    }

    const effectiveProject = currentProject || activeProject;
    if (!effectiveProject.localVideoUrl && clip.renderStatus !== 'completed') {
      throw new Error(
        'Attach your authorized source video file first so FFmpeg can cut and save this MP4 clip.'
      );
    }

    const renderRes = await fetch(
      apiUrl(
        `/api/projects/${effectiveProject.id}/clips/${clip.id}/render?quality=${encodeURIComponent(
          quality
        )}&skipIfExists=true`
      ),
      { method: 'POST' }
    );
    const renderData = await parseApiResponse<{
      project?: Project;
      clip?: ClipCandidate;
      downloadUrl?: string;
      filename?: string;
      fileSizeBytes?: number;
      error?: string;
    }>(renderRes);

    if (renderData.project) {
      setExpressProjects((prev) =>
        prev.map((p) => (p.id === renderData.project!.id ? renderData.project! : p))
      );
    }

    if (!renderRes.ok) {
      throw new Error(renderData.error || 'MP4 render failed.');
    }

    const resolvedClip = renderData.clip || clip;
    const downloadUrl =
      renderData.downloadUrl ||
      `/api/projects/${effectiveProject.id}/clips/${clip.id}/download?quality=${encodeURIComponent(
        quality
      )}`;
    const filename = renderData.filename || buildClipDownloadFilename(resolvedClip);

    const readyInfo: ReadyMp4Download = {
      clipId: resolvedClip.id,
      clipTitle: resolvedClip.title,
      url: downloadUrl,
      filename,
      fileSizeBytes: renderData.fileSizeBytes,
      quality,
    };
    setReadyMp4Download(readyInfo);
    triggerNativeAnchorDownload(readyInfo.url, readyInfo.filename);
  };

  const handleRegenerateCopy = async (clipId: string) => {
    if (!activeProject) return;
    const res = await fetch(
      apiUrl(`/api/projects/${activeProject.id}/clips/${clipId}/regenerate-copy`),
      { method: 'POST' }
    );
    const data = await parseApiResponse<{ project?: Project; error?: string }>(res);
    if (!res.ok || !data.project) {
      throw new Error(data.error || 'Failed to regenerate viral copy.');
    }
    setExpressProjects((prev) =>
      prev.map((p) => (p.id === data.project!.id ? data.project! : p))
    );
  };

  const handleAttachVideo = async (projectId: string, file: File) => {
    const formData = new FormData();
    formData.append('video', file);
    const res = await fetch(apiUrl(`/api/projects/${projectId}/attach-video`), {
      method: 'POST',
      body: formData,
    });
    const data = await parseApiResponse<{ project?: Project; error?: string }>(res);
    if (!res.ok || !data.project) {
      throw new Error(data.error || 'Failed to attach video file.');
    }
    setExpressProjects((prev) =>
      prev.map((p) => (p.id === data.project!.id ? data.project! : p))
    );
  };

  const handleRetryProject = async (projectId: string) => {
    const res = await fetch(apiUrl(`/api/projects/${projectId}/retry`), {
      method: 'POST',
    });
    const data = await parseApiResponse<{ project?: Project; error?: string }>(res);
    if (!res.ok || !data.project) {
      throw new Error(data.error || 'Failed to retry analysis.');
    }
    setExpressProjects((prev) =>
      prev.map((p) => (p.id === data.project!.id ? data.project! : p))
    );
  };

  const handleCreateManualClip = async (
    title: string,
    startSeconds: number,
    endSeconds: number
  ) => {
    if (!activeProject) return;
    const res = await fetch(apiUrl(`/api/projects/${activeProject.id}/clips`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, startSeconds, endSeconds }),
    });
    const data = await parseApiResponse<{
      project?: Project;
      clip?: ClipCandidate;
      error?: string;
    }>(res);
    if (!res.ok || !data.project) {
      throw new Error(data.error || 'Failed to add manual clip.');
    }
    setExpressProjects((prev) =>
      prev.map((p) => (p.id === data.project!.id ? data.project! : p))
    );
  };

  const handleSaveSettings = async (next: AppSettings) => {
    const res = await fetch(apiUrl('/api/settings'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    const data = await parseApiResponse<{ settings?: AppSettings; error?: string }>(res);
    if (!res.ok || !data.settings) {
      throw new Error(data.error || 'Failed to save studio preferences.');
    }
    setAppSettings(data.settings);
    if (user && user.emailVerified && !quotaPaused) {
      try {
        await savePreferencesToFirestore(user.uid, data.settings);
      } catch (err) {
        const msg = formatFirestoreUiError(err);
        if (/Quota exceeded/i.test(msg)) setQuotaPaused(true);
        setSyncError(msg);
      }
    }
  };

  const navigate = (target: AppView) => {
    setView(target);
    setMobileNavOpen(false);
  };

  return (
    <div className="min-h-screen bg-[#0B0D12] text-[#F3F4F6] flex">
      {/* Desktop Left Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 border-r border-white/8 bg-[#0E1017]">
        <div className="flex h-16 items-center px-6 border-b border-white/8">
          <button
            type="button"
            onClick={() => navigate('dashboard')}
            className="flex items-center gap-2.5 text-left whitespace-nowrap shrink-0"
          >
            <Film className="h-5 w-5 text-blue-500 shrink-0" />
            <span className="font-display text-base font-bold tracking-tight text-white">
              ClipGenius AI
            </span>
          </button>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-5">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = view === item.id;
            const alertCount =
              item.id === 'publish'
                ? publishNotifications.filter(
                    (n) => !n.read && (n.type === 'auth_expired' || n.type === 'error')
                  ).length
                : 0;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigate(item.id)}
                className={`flex w-full items-center justify-between gap-3 rounded-lg px-3.5 py-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-[#191E29] text-white'
                    : 'text-gray-400 hover:bg-white/[0.04] hover:text-gray-200'
                }`}
              >
                <span className="flex items-center gap-3">
                  <Icon
                    className={`h-4 w-4 shrink-0 ${
                      active ? 'text-blue-400' : 'text-gray-500'
                    }`}
                  />
                  <span>{item.label}</span>
                </span>
                {alertCount > 0 && (
                  <span className="rounded bg-rose-500/20 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-rose-300 tabular-nums">
                    {alertCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Active Project Quick Context */}
        {activeProject && (
          <div className="mx-3 mb-4 rounded-lg border border-white/8 bg-[#12151C] p-3">
            <p className="text-[11px] font-medium text-gray-500">Active Project</p>
            <p className="mt-1 truncate text-xs font-semibold text-gray-200">
              {activeProject.title}
            </p>
            <p className="mt-0.5 font-mono text-[11px] text-gray-400 tabular-nums">
              {activeProject.clips.length} clips
            </p>
          </div>
        )}

        {/* Sidebar Footer: PWA Install & Firebase Auth Profile */}
        <div className="space-y-3 border-t border-white/8 p-4">
          <PWAInstallButton compact />

          {user ? (
            <div className="flex items-center justify-between gap-2 pt-1">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="h-9 w-9 overflow-hidden rounded-full border border-emerald-500/30 bg-[#171B24] shrink-0">
                  {user.photoURL && !avatarError ? (
                    <img
                      src={user.photoURL}
                      alt={user.displayName || 'Creator avatar'}
                      referrerPolicy="no-referrer"
                      onError={() => setAvatarError(true)}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-emerald-400">
                      <User className="h-4 w-4" />
                    </div>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-white">
                    {user.displayName || 'Creator Studio'}
                  </p>
                  <p className="truncate text-[11px] text-emerald-400/90">
                    {user.email || 'Cloud Synced'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={signOutUser}
                title="Sign out"
                aria-label="Sign out of Google"
                className="rounded-lg border border-white/10 bg-[#171B24] p-2 text-gray-400 transition-colors hover:bg-white/10 hover:text-white shrink-0"
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div className="space-y-2 pt-1">
              <div className="flex items-center gap-3">
                <div className="h-8 w-8 overflow-hidden rounded-full border border-white/10 bg-[#171B24] shrink-0">
                  <div className="flex h-full w-full items-center justify-center text-gray-400">
                    <Cloud className="h-4 w-4" />
                  </div>
                </div>
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-white">Local Workspace</p>
                  <p className="truncate text-[11px] text-gray-500">Sign in to sync cloud</p>
                </div>
              </div>
              <button
                type="button"
                onClick={signInWithGoogle}
                disabled={signingIn || !authReady}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-blue-500/30 bg-blue-600/15 px-3 py-2 text-xs font-semibold text-blue-300 transition-colors hover:bg-blue-600/25 disabled:opacity-50"
              >
                {signingIn ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <LogIn className="h-3.5 w-3.5" />
                )}
                <span>{signingIn ? 'Signing in...' : 'Sign in with Google'}</span>
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Mobile Navigation Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div
            onClick={() => setMobileNavOpen(false)}
            className="fixed inset-0 bg-black/70"
          />
          <aside className="relative z-10 flex w-64 flex-col bg-[#0E1017] border-r border-white/10">
            <div className="flex h-16 items-center justify-between px-5 border-b border-white/8">
              <span className="font-display text-base font-bold text-white">
                ClipGenius AI
              </span>
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                aria-label="Close navigation"
                className="rounded-lg p-1.5 text-gray-400 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex-1 space-y-1 px-3 py-4">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = view === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigate(item.id)}
                    className={`flex w-full items-center gap-3 rounded-lg px-3.5 py-2.5 text-sm font-medium ${
                      active
                        ? 'bg-[#191E29] text-white'
                        : 'text-gray-400 hover:bg-white/[0.04]'
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="space-y-2.5 p-4 border-t border-white/8">
              <PWAInstallButton compact />
              {user ? (
                <div className="flex items-center justify-between gap-2 pt-1">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-white">
                      {user.displayName || 'Creator Studio'}
                    </p>
                    <p className="truncate text-[11px] text-emerald-400/90">{user.email}</p>
                  </div>
                  <button
                    type="button"
                    onClick={signOutUser}
                    className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-[#171B24] px-2.5 py-1.5 text-[11px] font-medium text-gray-300 hover:text-white shrink-0"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    <span>Sign Out</span>
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={signInWithGoogle}
                  disabled={signingIn || !authReady}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-blue-500/30 bg-blue-600/15 px-3 py-2 text-xs font-semibold text-blue-300 hover:bg-blue-600/25 disabled:opacity-50"
                >
                  <LogIn className="h-3.5 w-3.5" />
                  <span>{signingIn ? 'Signing in...' : 'Sign in with Google'}</span>
                </button>
              )}
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex flex-1 flex-col lg:pl-64 min-w-0">
        {/* Strict 3-Zone Top Bar */}
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-8 border-b border-white/8 bg-[#0B0D12]/90 px-4 sm:px-8 backdrop-blur">
          {/* Zone 1: Brand / Breadcrumb */}
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation menu"
              className="rounded-lg p-2 text-gray-400 hover:bg-white/5 hover:text-white lg:hidden shrink-0"
            >
              <Menu className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => navigate('dashboard')}
              className="font-display text-base font-bold tracking-tight text-white whitespace-nowrap shrink-0"
            >
              ClipGenius AI
            </button>
          </div>

          {/* Zone 2: Clean Single-Line Text Nav Links */}
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-gray-400">
            <button
              type="button"
              onClick={() => navigate('dashboard')}
              className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
                view === 'dashboard' ? 'text-white' : ''
              }`}
            >
              Dashboard
            </button>
            <button
              type="button"
              onClick={() => navigate('analysis')}
              className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
                view === 'analysis' ? 'text-white' : ''
              }`}
            >
              AI Analysis
            </button>
            <button
              type="button"
              onClick={() => navigate('editor')}
              className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
                view === 'editor' ? 'text-white' : ''
              }`}
            >
              Clip Editor
            </button>
            <button
              type="button"
              onClick={() => navigate('export')}
              className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
                view === 'export' ? 'text-white' : ''
              }`}
            >
              Export
            </button>
            <button
              type="button"
              onClick={() => navigate('publish')}
              className={`inline-flex items-center gap-1.5 hover:text-white transition-colors whitespace-nowrap shrink-0 ${
                view === 'publish' ? 'text-white' : ''
              }`}
            >
              <span>Publish</span>
              {publishNotifications.some(
                (n) => !n.read && (n.type === 'auth_expired' || n.type === 'error')
              ) && (
                <span className="h-2 w-2 rounded-full bg-rose-500" />
              )}
            </button>
            <button
              type="button"
              onClick={() => navigate('settings')}
              className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
                view === 'settings' ? 'text-white' : ''
              }`}
            >
              Settings
            </button>
          </nav>

          {/* Zone 3: 1 Primary Action */}
          <div className="shrink-0">
            <button
              type="button"
              onClick={() => navigate('new-project')}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500 whitespace-nowrap shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>New Project</span>
            </button>
          </div>
        </header>

        {/* Active Page Viewport */}
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-8 sm:py-8">
          {(syncError || firebaseError) && (
            <div
              role="alert"
              className="mb-5 flex items-start justify-between gap-3 rounded-xl border border-rose-500/35 bg-rose-950/35 px-4 py-3 text-xs leading-relaxed text-rose-100"
            >
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                <div>
                  <p className="font-semibold text-rose-200">
                    Firebase Cloud Sync Notice
                  </p>
                  <p className="mt-0.5 text-rose-200/85">
                    {syncError || firebaseError}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSyncError(null);
                  clearFirebaseError();
                }}
                aria-label="Dismiss Firebase sync notice"
                className="rounded-lg p-1 text-rose-300 hover:bg-white/5 hover:text-white shrink-0"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          {backendError && (
            <div
              role="alert"
              className="mb-5 flex items-start justify-between gap-3 rounded-xl border border-amber-500/35 bg-amber-950/35 px-4 py-3.5 text-xs leading-relaxed text-amber-100"
            >
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                <div>
                  <p className="font-semibold text-amber-200">{backendError}</p>
                  <p className="mt-1 text-amber-200/80">
                    If you deployed the frontend to a static host (such as Netlify), deploy the
                    included Dockerfile backend (Cloud Run / Railway / Render), set{' '}
                    <code className="font-mono text-white">VITE_API_BASE_URL</code> in your
                    frontend build environment variables, and redeploy. If running locally, start{' '}
                    <code className="font-mono text-white">npm run dev</code> (not{' '}
                    <code className="font-mono text-white">vite</code> alone).
                  </p>
                  <button
                    type="button"
                    onClick={loadWorkspace}
                    className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-amber-400/30 bg-amber-500/15 px-3 py-1 text-[11px] font-semibold text-amber-100 hover:bg-amber-500/25"
                  >
                    <RefreshCw className="h-3 w-3" />
                    <span>Retry Connection</span>
                  </button>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setBackendError(null)}
                aria-label="Dismiss backend warning"
                className="rounded-lg p-1 text-amber-300 hover:bg-white/5 hover:text-white shrink-0"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          {!isInstalled && !dismissedMobileInstall && (
            <div className="mb-5 flex items-center justify-between gap-3 rounded-xl border border-blue-500/25 bg-[#12151C] px-4 py-3 lg:hidden">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-white">
                  Install ClipGenius App
                </p>
                <p className="text-[11px] text-gray-400">
                  Add to your phone home screen
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <PWAInstallButton compact />
                <button
                  type="button"
                  onClick={() => setDismissedMobileInstall(true)}
                  aria-label="Dismiss install banner"
                  className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
          {view === 'dashboard' && (
            <DashboardView
              projects={projects}
              loading={loading}
              onCreateNew={() => navigate('new-project')}
              onSelectProject={handleSelectProject}
              onDeleteProject={handleDeleteProject}
            />
          )}

          {view === 'new-project' && (
            <NewProjectView
              appSettings={appSettings}
              onProjectCreated={handleProjectCreated}
            />
          )}

          {view === 'analysis' && (
            <AnalysisView
              project={activeProject}
              exportQuality={exportQuality}
              readyMp4Download={readyMp4Download}
              isProjectSyncedOnServer={isActiveProjectSyncedOnExpress}
              onDismissReadyMp4={() => setReadyMp4Download(null)}
              onMarkDirectMp4Download={handleMarkDirectMp4Download}
              onOpenEditor={(clipId) => {
                setActiveClipId(clipId);
                navigate('editor');
              }}
              onDownloadClip={handleDownloadClip}
              onGoToExport={() => navigate('export')}
              onCreateNew={() => navigate('new-project')}
              onRetryProject={handleRetryProject}
              onCreateManualClip={handleCreateManualClip}
              onToggleClipSelection={(clipId, selected) =>
                handleUpdateClip(clipId, { selected })
              }
              onSelectBatchPreset={handleSelectBatchPreset}
            />
          )}

          {view === 'editor' && (
            <ClipEditorView
              project={activeProject}
              activeClipId={activeClipId}
              appSettings={appSettings}
              exportQuality={exportQuality}
              readyMp4Download={readyMp4Download}
              isProjectSyncedOnServer={isActiveProjectSyncedOnExpress}
              onDismissReadyMp4={() => setReadyMp4Download(null)}
              onMarkDirectMp4Download={handleMarkDirectMp4Download}
              onChangeExportQuality={setExportQuality}
              onSelectClip={(clipId) => setActiveClipId(clipId)}
              onSaveClip={handleUpdateClip}
              onRenderClip={handleRenderClip}
              onDownloadClip={handleDownloadClip}
              onRegenerateCopy={handleRegenerateCopy}
              onAttachVideo={handleAttachVideo}
              onGoToExport={() => navigate('export')}
              onGoToPublish={(clipId) => {
                setActiveClipId(clipId);
                navigate('publish');
              }}
              onGoToNewProject={() => navigate('new-project')}
            />
          )}

          {view === 'export' && (
            <ExportView
              project={activeProject}
              exportQuality={exportQuality}
              readyMp4Download={readyMp4Download}
              isProjectSyncedOnServer={isActiveProjectSyncedOnExpress}
              onDismissReadyMp4={() => setReadyMp4Download(null)}
              onMarkDirectMp4Download={handleMarkDirectMp4Download}
              onChangeExportQuality={setExportQuality}
              onRenderClip={handleRenderClip}
              onRenderBatch={handleRenderBatch}
              onDownloadClip={handleDownloadClip}
              onAttachVideo={handleAttachVideo}
              onOpenEditor={(clipId) => {
                setActiveClipId(clipId);
                navigate('editor');
              }}
              onToggleApprove={(clipId, approved) =>
                activeProject
                  ? handleApproveClip(activeProject.id, clipId, approved)
                  : Promise.resolve()
              }
              onGoToPublish={(clipId) => {
                setActiveClipId(clipId);
                navigate('publish');
              }}
              onCreateNew={() => navigate('new-project')}
            />
          )}

          {view === 'publish' && (
            <PublishView
              projects={projects}
              activeProject={activeProject}
              initialClipId={activeClipId}
              connections={publishConnections}
              jobs={publishJobs}
              notifications={publishNotifications}
              onRefreshPublishState={loadPublishState}
              onApproveClip={handleApproveClip}
              onGoToEditor={(project, clipId) => {
                setActiveProjectId(project.id);
                setActiveClipId(clipId);
                navigate('editor');
              }}
              onGoToExport={(project) => {
                setActiveProjectId(project.id);
                navigate('export');
              }}
            />
          )}

          {view === 'settings' && (
            <SettingsView
              settings={appSettings}
              onSaveSettings={handleSaveSettings}
            />
          )}
        </main>
      </div>

      <OfflineIndicator />
    </div>
  );
}

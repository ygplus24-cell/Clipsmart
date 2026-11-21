import type { User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type {
  AppSettings,
  ClipCandidate,
  Project,
  ProjectSettings,
  PublishJob,
  PublishPlatform,
  PublishTargetSpec,
} from '../types';

const writeQueues = new Map<string, Promise<unknown>>();

function runSerialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tracked = next.finally(() => {
    if (writeQueues.get(key) === tracked) {
      writeQueues.delete(key);
    }
  });
  writeQueues.set(key, tracked);
  return next;
}

function clampStr(val: unknown, maxLen: number, fallback = ''): string {
  const s = typeof val === 'string' ? val : fallback;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function clampNum(val: unknown, min: number, max: number, fallback: number): number {
  const n = typeof val === 'number' && Number.isFinite(val) ? val : fallback;
  return Math.max(min, Math.min(max, n));
}

function sanitizeId(val: unknown, fallback: string): string {
  const cleaned = (typeof val === 'string' ? val : fallback)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 128);
  return cleaned || fallback;
}

function sanitizeStringList(
  arr: unknown,
  maxItems: number,
  maxItemLen: number
): string[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((item): item is string => typeof item === 'string')
    .slice(0, maxItems)
    .map((item) => clampStr(item, maxItemLen));
}

function sanitizeHexColor(hex: unknown): string {
  const s = typeof hex === 'string' ? hex.trim() : '';
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : '#F59E0B';
}

function sanitizeProjectSettings(s: ProjectSettings): ProjectSettings {
  return {
    durationPreset: ['15-30', '30-60', '60-90', 'auto', 'custom'].includes(s.durationPreset)
      ? s.durationPreset
      : '30-60',
    customMinSeconds: clampNum(s.customMinSeconds, 5, 300, 20),
    customMaxSeconds: clampNum(s.customMaxSeconds, 5, 600, 45),
    outputFormat: ['9:16', '16:9', '1:1'].includes(s.outputFormat)
      ? s.outputFormat
      : '9:16',
    clippingMode: ['auto', 'manual'].includes(s.clippingMode) ? s.clippingMode : 'auto',
    targetPlatforms: sanitizeStringList(s.targetPlatforms, 4, 32) as ProjectSettings['targetPlatforms'],
    maxClips: clampNum(s.maxClips, 1, 20, 6),
    subtitleStyle: ['bold_impact', 'clean_minimal', 'karaoke_gold', 'kinetic_blue'].includes(
      s.subtitleStyle
    )
      ? s.subtitleStyle
      : 'bold_impact',
    autoFaceTrack: Boolean(s.autoFaceTrack),
    deduplicateClips: Boolean(s.deduplicateClips),
    addHookOverlay: Boolean(s.addHookOverlay),
    addBackgroundMusic: Boolean(s.addBackgroundMusic),
  };
}

function sanitizeClipPayload(
  uid: string,
  projectId: string,
  clip: ClipCandidate,
  indexFallback: number
) {
  const clipId = sanitizeId(clip.id, `clip_${indexFallback}`);
  const startSeconds = clampNum(clip.startSeconds, 0, 86395, 0);
  const endSeconds = clampNum(clip.endSeconds, startSeconds + 1, 86400, startSeconds + 10);
  const durationSeconds = clampNum(
    clip.durationSeconds || endSeconds - startSeconds,
    1,
    1800,
    Math.max(1, endSeconds - startSeconds)
  );

  const payload: Record<string, unknown> = {
    ownerId: uid,
    projectId,
    id: clipId,
    index: clampNum(clip.index, 1, 200, indexFallback),
    title: clampStr(clip.title, 200, `Clip ${indexFallback}`) || `Clip ${indexFallback}`,
    categoryLabel: clampStr(clip.categoryLabel, 80, 'Viral Moment'),
    startSeconds,
    endSeconds,
    durationSeconds,
    score: {
      openingHook: clampNum(clip.score?.openingHook, 0, 20, 14),
      emotionalReaction: clampNum(clip.score?.emotionalReaction, 0, 20, 14),
      interestingConversation: clampNum(clip.score?.interestingConversation, 0, 15, 11),
      humorOrSurprise: clampNum(clip.score?.humorOrSurprise, 0, 15, 10),
      educationalValue: clampNum(clip.score?.educationalValue, 0, 10, 7),
      standaloneContext: clampNum(clip.score?.standaloneContext, 0, 10, 7),
      strongEnding: clampNum(clip.score?.strongEnding, 0, 10, 7),
      total: clampNum(clip.score?.total, 0, 100, 70),
    },
    whyInteresting: clampStr(clip.whyInteresting, 1000, ''),
    openingHook: clampStr(clip.openingHook, 300, ''),
    socialCaption: clampStr(clip.socialCaption, 2200, ''),
    platformCaptions: {
      tiktok: clampStr(clip.platformCaptions?.tiktok, 2200, ''),
      youtube_shorts: clampStr(clip.platformCaptions?.youtube_shorts, 2200, ''),
      instagram_reels: clampStr(clip.platformCaptions?.instagram_reels, 2200, ''),
      facebook: clampStr(clip.platformCaptions?.facebook, 2200, ''),
    },
    hashtags: sanitizeStringList(clip.hashtags, 25, 64),
    speakerCenterX: clampNum(clip.speakerCenterX, 0, 1, 0.5),
    primarySpeaker: clampStr(clip.primarySpeaker, 100, 'Speaker 1'),
    selected: Boolean(clip.selected),
    showHookBanner: Boolean(clip.showHookBanner),
    subtitleStyle: ['bold_impact', 'clean_minimal', 'karaoke_gold', 'kinetic_blue'].includes(
      clip.subtitleStyle
    )
      ? clip.subtitleStyle
      : 'bold_impact',
    outputFormat: ['9:16', '16:9', '1:1'].includes(clip.outputFormat)
      ? clip.outputFormat
      : '9:16',
    addBackgroundMusic: Boolean(clip.addBackgroundMusic),
    segments: (Array.isArray(clip.segments) ? clip.segments : []).slice(0, 120).map((seg, i) => ({
      id: sanitizeId(seg.id, `seg_${i + 1}`),
      startSeconds: clampNum(seg.startSeconds, 0, 86400, startSeconds),
      endSeconds: clampNum(seg.endSeconds, 0, 86400, startSeconds + 2),
      speaker: clampStr(seg.speaker, 100, 'Speaker 1'),
      text: clampStr(seg.text, 500, ''),
      highlightWords: sanitizeStringList(seg.highlightWords, 12, 64),
    })),
    renderStatus: ['idle', 'rendering', 'completed', 'failed'].includes(clip.renderStatus)
      ? clip.renderStatus
      : 'idle',
  };

  if (clip.thumbnailUrl) payload.thumbnailUrl = clampStr(clip.thumbnailUrl, 500);
  if (clip.renderedVideoUrl) payload.renderedVideoUrl = clampStr(clip.renderedVideoUrl, 500);
  if (clip.renderError) payload.renderError = clampStr(clip.renderError, 1000);
  if (typeof clip.approved === 'boolean') payload.approved = clip.approved;
  if (clip.approvedAt) payload.approvedAt = clampStr(clip.approvedAt, 64);

  return { clipId, payload };
}

export async function syncUserProfileToFirestore(user: User): Promise<void> {
  const uid = sanitizeId(user.uid, user.uid);
  return runSerialized(`user:${uid}`, async () => {
    const publicPath = `users/${uid}`;
    const privatePath = `users/${uid}/private/info`;

    const displayName = clampStr(
      user.displayName || user.email?.split('@')[0] || 'Creator Studio',
      120,
      'Creator Studio'
    );
    const photoURL = user.photoURL ? clampStr(user.photoURL, 500) : undefined;

    try {
      const publicRef = doc(db, 'users', uid);
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(publicRef);
        if (!snap.exists()) {
          tx.set(publicRef, {
            ownerId: uid,
            displayName,
            ...(photoURL ? { photoURL } : {}),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else {
          tx.update(publicRef, {
            displayName,
            ...(photoURL ? { photoURL } : {}),
            updatedAt: serverTimestamp(),
          });
        }
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, publicPath);
    }

    try {
      const privateRef = doc(db, 'users', uid, 'private', 'info');
      const email = clampStr(user.email || 'unknown@example.com', 254);
      await runTransaction(db, async (tx) => {
        const privSnap = await tx.get(privateRef);
        if (!privSnap.exists()) {
          tx.set(privateRef, {
            ownerId: uid,
            email,
            emailVerified: Boolean(user.emailVerified),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else {
          tx.update(privateRef, {
            email,
            emailVerified: Boolean(user.emailVerified),
            updatedAt: serverTimestamp(),
          });
        }
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, privatePath);
    }
  });
}

export async function savePreferencesToFirestore(
  uid: string,
  settings: AppSettings
): Promise<void> {
  const cleanUid = sanitizeId(uid, uid);
  return runSerialized(`prefs:${cleanUid}`, async () => {
    const path = `users/${cleanUid}/preferences/studio`;
    const prefRef = doc(db, 'users', cleanUid, 'preferences', 'studio');

    const body = {
      defaultDurationPreset: ['15-30', '30-60', '60-90', 'auto', 'custom'].includes(
        settings.defaultDurationPreset
      )
        ? settings.defaultDurationPreset
        : '30-60',
      defaultOutputFormat: ['9:16', '16:9', '1:1'].includes(settings.defaultOutputFormat)
        ? settings.defaultOutputFormat
        : '9:16',
      defaultClippingMode: ['auto', 'manual'].includes(settings.defaultClippingMode)
        ? settings.defaultClippingMode
        : 'auto',
      defaultPlatforms: sanitizeStringList(settings.defaultPlatforms, 4, 32),
      defaultSubtitleStyle: [
        'bold_impact',
        'clean_minimal',
        'karaoke_gold',
        'kinetic_blue',
      ].includes(settings.defaultSubtitleStyle)
        ? settings.defaultSubtitleStyle
        : 'bold_impact',
      subtitleFontSize: clampNum(settings.subtitleFontSize, 24, 96, 54),
      subtitleAccentColor: sanitizeHexColor(settings.subtitleAccentColor),
      subtitlePosition: ['bottom', 'center', 'lower_third'].includes(settings.subtitlePosition)
        ? settings.subtitlePosition
        : 'lower_third',
      subtitleUppercase: Boolean(settings.subtitleUppercase),
      brandWatermark: clampStr(settings.brandWatermark, 80, 'ClipGenius AI'),
      showWatermark: Boolean(settings.showWatermark),
      geminiModel: ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'].includes(settings.geminiModel)
        ? settings.geminiModel
        : 'gemini-4-hydrogen',
    };

    try {
      await runTransaction(db, async (tx) => {
        const existing = await tx.get(prefRef);
        if (!existing.exists()) {
          tx.set(prefRef, {
            ownerId: cleanUid,
            ...body,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else {
          tx.update(prefRef, {
            ...body,
            updatedAt: serverTimestamp(),
          });
        }
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, path);
    }
  });
}

export async function loadPreferencesFromFirestore(
  uid: string
): Promise<AppSettings | null> {
  const cleanUid = sanitizeId(uid, uid);
  const path = `users/${cleanUid}/preferences/studio`;
  try {
    const snap = await getDoc(doc(db, 'users', cleanUid, 'preferences', 'studio'));
    if (!snap.exists()) return null;
    const d = snap.data();
    return {
      defaultDurationPreset: d.defaultDurationPreset,
      defaultOutputFormat: d.defaultOutputFormat,
      defaultClippingMode: d.defaultClippingMode,
      defaultPlatforms: d.defaultPlatforms || ['tiktok', 'youtube_shorts'],
      defaultSubtitleStyle: d.defaultSubtitleStyle,
      subtitleFontSize: d.subtitleFontSize,
      subtitleAccentColor: d.subtitleAccentColor,
      subtitlePosition: d.subtitlePosition,
      subtitleUppercase: Boolean(d.subtitleUppercase),
      brandWatermark: d.brandWatermark || 'ClipGenius AI',
      showWatermark: Boolean(d.showWatermark),
      geminiModel: d.geminiModel || 'gemini-4-hydrogen',
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function syncProjectAndClipsToFirestore(
  uid: string,
  project: Project
): Promise<void> {
  const cleanUid = sanitizeId(uid, uid);
  const projectId = sanitizeId(project.id, project.id);

  return runSerialized(`project:${cleanUid}:${projectId}`, async () => {
    const projectPath = `users/${cleanUid}/projects/${projectId}`;
    const projectRef = doc(db, 'users', cleanUid, 'projects', projectId);

    const mutableFields: Record<string, unknown> = {
      title: clampStr(project.title, 200, 'Untitled Project') || 'Untitled Project',
      status: ['processing', 'completed', 'failed'].includes(project.status)
        ? project.status
        : 'processing',
      analysisStage: clampStr(project.analysisStage, 40, 'queued'),
      analysisProgress: clampNum(project.analysisProgress, 0, 100, 0),
      analysisMessage: clampStr(project.analysisMessage, 500, ''),
      settings: sanitizeProjectSettings(project.settings),
      clipCount: clampNum(project.clips?.length || 0, 0, 100, 0),
      sourceUpdatedAt: clampStr(project.updatedAt || new Date().toISOString(), 64),
    };

    if (project.channelOrAuthor) {
      mutableFields.channelOrAuthor = clampStr(project.channelOrAuthor, 150);
    }
    if (project.localVideoFilename) {
      mutableFields.localVideoFilename = clampStr(project.localVideoFilename, 256);
    }
    if (project.localVideoUrl) {
      mutableFields.localVideoUrl = clampStr(project.localVideoUrl, 500);
    }
    if (project.thumbnailUrl) {
      mutableFields.thumbnailUrl = clampStr(project.thumbnailUrl, 500);
    }
    if (typeof project.videoDurationSeconds === 'number') {
      mutableFields.videoDurationSeconds = clampNum(project.videoDurationSeconds, 0, 86400, 0);
    }
    if (typeof project.videoWidth === 'number') {
      mutableFields.videoWidth = clampNum(project.videoWidth, 0, 10000, 1920);
    }
    if (typeof project.videoHeight === 'number') {
      mutableFields.videoHeight = clampNum(project.videoHeight, 0, 10000, 1080);
    }
    if (typeof project.hasAudioStream === 'boolean') {
      mutableFields.hasAudioStream = project.hasAudioStream;
    }
    if (project.errorMessage) {
      mutableFields.errorMessage = clampStr(project.errorMessage, 1000);
    }
    if (project.summary) {
      mutableFields.summary = clampStr(project.summary, 2000);
    }
    if (Array.isArray(project.speakersDetected)) {
      mutableFields.speakersDetected = sanitizeStringList(project.speakersDetected, 20, 100);
    }

    try {
      const existing = await getDoc(projectRef);
      if (!existing.exists()) {
        const createDoc: Record<string, unknown> = {
          ownerId: cleanUid,
          id: projectId,
          sourceType: project.sourceType === 'upload' ? 'upload' : 'youtube',
          sourceCreatedAt: clampStr(project.createdAt || new Date().toISOString(), 64),
          ...mutableFields,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
        if (project.youtubeUrl) {
          createDoc.youtubeUrl = clampStr(project.youtubeUrl, 500);
        }
        if (project.youtubeVideoId) {
          createDoc.youtubeVideoId = clampStr(project.youtubeVideoId, 64);
        }
        await setDoc(projectRef, createDoc);
      } else {
        await updateDoc(projectRef, {
          ...mutableFields,
          updatedAt: serverTimestamp(),
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, projectPath);
    }

    // Sync clip subcollection atomically in one writeBatch after parent project exists (Master Gate)
    const clips = Array.isArray(project.clips) ? project.clips.slice(0, 100) : [];
    if (clips.length === 0) return;

    const clipsColPath = `users/${cleanUid}/projects/${projectId}/clips`;
    try {
      const existingClipsSnap = await getDocs(
        query(
          collection(db, 'users', cleanUid, 'projects', projectId, 'clips'),
          where('ownerId', '==', cleanUid),
          where('projectId', '==', projectId)
        )
      );
      const existingClipIds = new Set(existingClipsSnap.docs.map((d) => d.id));
      const seenClipIds = new Set<string>();
      const batch = writeBatch(db);

      for (let i = 0; i < clips.length; i++) {
        const { clipId, payload } = sanitizeClipPayload(cleanUid, projectId, clips[i], i + 1);
        if (seenClipIds.has(clipId)) continue;
        seenClipIds.add(clipId);
        const clipRef = doc(db, 'users', cleanUid, 'projects', projectId, 'clips', clipId);
        if (!existingClipIds.has(clipId)) {
          batch.set(clipRef, {
            ...payload,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else {
          const {
            ownerId: _o,
            projectId: _p,
            id: _i,
            ...mutableClipFields
          } = payload;
          batch.update(clipRef, {
            ...mutableClipFields,
            updatedAt: serverTimestamp(),
          });
        }
      }

      if (seenClipIds.size > 0) {
        await batch.commit();
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, clipsColPath);
    }
  });
}

export async function deleteProjectFromFirestore(
  uid: string,
  projectId: string
): Promise<void> {
  const cleanUid = sanitizeId(uid, uid);
  const cleanProjectId = sanitizeId(projectId, projectId);
  const clipsPath = `users/${cleanUid}/projects/${cleanProjectId}/clips`;
  const projectPath = `users/${cleanUid}/projects/${cleanProjectId}`;

  try {
    const clipsSnap = await getDocs(
      query(
        collection(db, 'users', cleanUid, 'projects', cleanProjectId, 'clips'),
        where('ownerId', '==', cleanUid),
        where('projectId', '==', cleanProjectId)
      )
    );
    for (const clipDoc of clipsSnap.docs) {
      await deleteDoc(clipDoc.ref);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, clipsPath);
  }

  try {
    const projRef = doc(db, 'users', cleanUid, 'projects', cleanProjectId);
    const projSnap = await getDoc(projRef);
    if (projSnap.exists()) {
      await deleteDoc(projRef);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, projectPath);
  }
}

function sanitizePublishTarget(t: PublishTargetSpec, plat: PublishPlatform) {
  const out: Record<string, unknown> = {
    platform: plat,
    enabled: Boolean(t?.enabled),
    title: clampStr(t?.title, 200, ''),
    caption: clampStr(t?.caption, 2200, ''),
    hashtags: sanitizeStringList(t?.hashtags, 25, 64),
    privacy: ['public', 'unlisted', 'private'].includes(t?.privacy)
      ? t.privacy
      : 'public',
    scheduleMode: t?.scheduleMode === 'scheduled' ? 'scheduled' : 'now',
    status: [
      'pending',
      'scheduled',
      'uploading',
      'processing',
      'published',
      'failed',
      'auth_expired',
    ].includes(t?.status)
      ? t.status
      : 'pending',
    progress: clampNum(t?.progress, 0, 100, 0),
    updatedAt: clampStr(t?.updatedAt || new Date().toISOString(), 64),
  };
  if (t?.scheduledAt) out.scheduledAt = clampStr(t.scheduledAt, 64);
  if (t?.publishedUrl) out.publishedUrl = clampStr(t.publishedUrl, 500);
  if (t?.remotePostId) out.remotePostId = clampStr(t.remotePostId, 200);
  if (t?.errorMessage) out.errorMessage = clampStr(t.errorMessage, 1000);
  return out;
}

export async function syncPublishJobToFirestore(
  uid: string,
  job: PublishJob
): Promise<void> {
  const cleanUid = sanitizeId(uid, uid);
  const jobId = sanitizeId(job.id, job.id);
  const projectId = sanitizeId(job.projectId, job.projectId);
  const clipId = sanitizeId(job.clipId, job.clipId);

  return runSerialized(`job:${cleanUid}:${jobId}`, async () => {
    const jobPath = `users/${cleanUid}/publishJobs/${jobId}`;
    const jobRef = doc(db, 'users', cleanUid, 'publishJobs', jobId);

    const targets = {
      youtube_shorts: sanitizePublishTarget(job.targets.youtube_shorts, 'youtube_shorts'),
      tiktok: sanitizePublishTarget(job.targets.tiktok, 'tiktok'),
      instagram_reels: sanitizePublishTarget(job.targets.instagram_reels, 'instagram_reels'),
    };

    try {
      const existing = await getDoc(jobRef);
      if (!existing.exists()) {
        const payload: Record<string, unknown> = {
          ownerId: cleanUid,
          id: jobId,
          projectId,
          projectTitle: clampStr(job.projectTitle, 200, 'Project'),
          clipId,
          clipTitle: clampStr(job.clipTitle, 200, 'Clip'),
          approvedAt: clampStr(job.approvedAt || new Date().toISOString(), 64),
          sourceCreatedAt: clampStr(job.createdAt || new Date().toISOString(), 64),
          sourceUpdatedAt: clampStr(job.updatedAt || new Date().toISOString(), 64),
          targets,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
        if (job.clipThumbnailUrl) {
          payload.clipThumbnailUrl = clampStr(job.clipThumbnailUrl, 500);
        }
        if (job.renderedVideoUrl) {
          payload.renderedVideoUrl = clampStr(job.renderedVideoUrl, 500);
        }
        await setDoc(jobRef, payload);
      } else {
        const updatePayload: Record<string, unknown> = {
          sourceUpdatedAt: clampStr(job.updatedAt || new Date().toISOString(), 64),
          targets,
          updatedAt: serverTimestamp(),
        };
        if (job.clipThumbnailUrl) {
          updatePayload.clipThumbnailUrl = clampStr(job.clipThumbnailUrl, 500);
        }
        if (job.renderedVideoUrl) {
          updatePayload.renderedVideoUrl = clampStr(job.renderedVideoUrl, 500);
        }
        await updateDoc(jobRef, updatePayload);
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, jobPath);
    }
  });
}

export function subscribeUserProjects(
  uid: string,
  onProjects: (projects: Project[]) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const cleanUid = sanitizeId(uid, uid);
  const path = `users/${cleanUid}/projects`;
  const q = query(
    collection(db, 'users', cleanUid, 'projects'),
    where('ownerId', '==', cleanUid)
  );

  return onSnapshot(
    q,
    async (snap) => {
      try {
        const hydrated = await Promise.all(
          snap.docs.map(async (projDoc) => {
            const d = projDoc.data();
            const clipsPath = `users/${cleanUid}/projects/${projDoc.id}/clips`;
            let clips: ClipCandidate[] = [];
            try {
              const clipsSnap = await getDocs(
                query(
                  collection(db, 'users', cleanUid, 'projects', projDoc.id, 'clips'),
                  where('ownerId', '==', cleanUid),
                  where('projectId', '==', projDoc.id)
                )
              );
              clips = clipsSnap.docs
                .map((cd) => cd.data() as unknown as ClipCandidate)
                .sort((a, b) => (a.index || 0) - (b.index || 0));
            } catch (err) {
              handleFirestoreError(err, OperationType.LIST, clipsPath);
            }

            const project: Project = {
              id: d.id,
              title: d.title,
              channelOrAuthor: d.channelOrAuthor,
              sourceType: d.sourceType,
              youtubeUrl: d.youtubeUrl,
              youtubeVideoId: d.youtubeVideoId,
              localVideoFilename: d.localVideoFilename,
              localVideoUrl: d.localVideoUrl,
              thumbnailUrl: d.thumbnailUrl,
              videoDurationSeconds: d.videoDurationSeconds,
              videoWidth: d.videoWidth,
              videoHeight: d.videoHeight,
              hasAudioStream: d.hasAudioStream,
              createdAt: d.sourceCreatedAt || new Date().toISOString(),
              updatedAt: d.sourceUpdatedAt || new Date().toISOString(),
              status: d.status,
              analysisStage: d.analysisStage,
              analysisProgress: d.analysisProgress,
              analysisMessage: d.analysisMessage,
              errorMessage: d.errorMessage,
              settings: d.settings,
              clips,
              summary: d.summary,
              speakersDetected: d.speakersDetected,
            };
            return project;
          })
        );
        hydrated.sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        onProjects(hydrated);
      } catch (err) {
        onError(err);
      }
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (err) {
        onError(err);
      }
    }
  );
}

export function subscribeUserPublishJobs(
  uid: string,
  onJobs: (jobs: PublishJob[]) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const cleanUid = sanitizeId(uid, uid);
  const path = `users/${cleanUid}/publishJobs`;
  const q = query(
    collection(db, 'users', cleanUid, 'publishJobs'),
    where('ownerId', '==', cleanUid)
  );

  return onSnapshot(
    q,
    (snap) => {
      const jobs: PublishJob[] = snap.docs.map((docSnap) => {
        const d = docSnap.data();
        return {
          id: d.id,
          projectId: d.projectId,
          projectTitle: d.projectTitle,
          clipId: d.clipId,
          clipTitle: d.clipTitle,
          clipThumbnailUrl: d.clipThumbnailUrl,
          renderedVideoUrl: d.renderedVideoUrl,
          approvedAt: d.approvedAt,
          createdAt: d.sourceCreatedAt || new Date().toISOString(),
          updatedAt: d.sourceUpdatedAt || new Date().toISOString(),
          targets: d.targets,
        };
      });
      jobs.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      onJobs(jobs);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (err) {
        onError(err);
      }
    }
  );
}

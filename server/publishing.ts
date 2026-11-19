import crypto from 'crypto';
import type { Express, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import type {
  ConnectionStatus,
  PlatformConnectionInfo,
  Project,
  PublishJob,
  PublishNotification,
  PublishPlatform,
  PublishPrivacy,
  PublishTargetSpec,
} from '../src/types.ts';

interface StoredTokenRecord {
  platform: PublishPlatform;
  status: ConnectionStatus;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  accountName?: string;
  accountHandle?: string;
  accountId?: string;
  connectedAt?: string;
  lastError?: string;
}

interface PublishingModuleDeps {
  dataDir: string;
  exportsDir: string;
  port: number;
  readProjects: () => Project[];
  updateProjectInStore: (
    projectId: string,
    updater: (project: Project) => Project
  ) => Project | null;
}

const PLATFORMS: PublishPlatform[] = [
  'youtube_shorts',
  'tiktok',
  'instagram_reels',
];

const PLATFORM_SLUGS: Record<PublishPlatform, string> = {
  youtube_shorts: 'youtube',
  tiktok: 'tiktok',
  instagram_reels: 'instagram',
};

const SLUG_TO_PLATFORM: Record<string, PublishPlatform> = {
  youtube: 'youtube_shorts',
  youtube_shorts: 'youtube_shorts',
  tiktok: 'tiktok',
  instagram: 'instagram_reels',
  instagram_reels: 'instagram_reels',
};

const PLATFORM_LABELS: Record<PublishPlatform, string> = {
  youtube_shorts: 'YouTube Shorts',
  tiktok: 'TikTok',
  instagram_reels: 'Instagram Reels',
};

const PLATFORM_NOTES: Record<PublishPlatform, string> = {
  youtube_shorts:
    'Requires Google OAuth consent and YouTube Data API v3 (youtube.upload + youtube.readonly).',
  tiktok:
    'Requires a registered TikTok Developer app with Content Posting API approval. Unaudited apps are restricted to Private (SELF_ONLY) visibility.',
  instagram_reels:
    'Requires an Instagram Professional (Business or Creator) account linked to a Facebook Page, instagram_content_publish permission, and a public HTTPS server URL.',
};

export function registerPublishingRoutes(
  app: Express,
  deps: PublishingModuleDeps
): { stopScheduler: () => void } {
  const connectionsFile = path.join(deps.dataDir, 'connections.json');
  const jobsFile = path.join(deps.dataDir, 'publish_jobs.json');
  const notificationsFile = path.join(
    deps.dataDir,
    'publish_notifications.json'
  );

  const oauthStates = new Map<
    string,
    { platform: PublishPlatform; createdAt: number }
  >();
  const activeUploads = new Set<string>();

  const getBaseAppUrl = (): string => {
    const raw = (process.env.APP_URL || '').trim();
    if (raw && raw !== 'MY_APP_URL' && /^https?:\/\//i.test(raw)) {
      return raw.replace(/\/+$/, '');
    }
    return `http://localhost:${deps.port}`;
  };

  const getRedirectUri = (platform: PublishPlatform): string => {
    return `${getBaseAppUrl()}/api/oauth/${PLATFORM_SLUGS[platform]}/callback`;
  };

  const readEnvValue = (...keys: string[]): string => {
    for (const k of keys) {
      const val = (process.env[k] || '').trim();
      if (val && !val.startsWith('MY_')) {
        return val;
      }
    }
    return '';
  };

  const getOAuthCreds = (
    platform: PublishPlatform
  ): { clientId: string; clientSecret: string } => {
    if (platform === 'youtube_shorts') {
      return {
        clientId: readEnvValue(
          'GOOGLE_CLIENT_ID',
          'YOUTUBE_CLIENT_ID',
          'GOOGLE_OAUTH_CLIENT_ID'
        ),
        clientSecret: readEnvValue(
          'GOOGLE_CLIENT_SECRET',
          'YOUTUBE_CLIENT_SECRET',
          'GOOGLE_OAUTH_CLIENT_SECRET'
        ),
      };
    }
    if (platform === 'tiktok') {
      return {
        clientId: readEnvValue('TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_ID'),
        clientSecret: readEnvValue('TIKTOK_CLIENT_SECRET'),
      };
    }
    return {
      clientId: readEnvValue(
        'META_APP_ID',
        'INSTAGRAM_APP_ID',
        'FACEBOOK_APP_ID'
      ),
      clientSecret: readEnvValue(
        'META_APP_SECRET',
        'INSTAGRAM_APP_SECRET',
        'FACEBOOK_APP_SECRET'
      ),
    };
  };

  const isPlatformConfigured = (platform: PublishPlatform): boolean => {
    const { clientId, clientSecret } = getOAuthCreds(platform);
    return Boolean(clientId && clientSecret);
  };

  const readJsonFile = <T>(filePath: string, fallback: T): T => {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
      }
    } catch {
      // Ignore parse failures and fall back
    }
    return fallback;
  };

  const writeJsonFile = (filePath: string, value: unknown): void => {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
  };

  const readConnections = (): Record<PublishPlatform, StoredTokenRecord> => {
    const stored = readJsonFile<Partial<Record<PublishPlatform, StoredTokenRecord>>>(
      connectionsFile,
      {}
    );
    return {
      youtube_shorts: stored.youtube_shorts || {
        platform: 'youtube_shorts',
        status: 'disconnected',
      },
      tiktok: stored.tiktok || {
        platform: 'tiktok',
        status: 'disconnected',
      },
      instagram_reels: stored.instagram_reels || {
        platform: 'instagram_reels',
        status: 'disconnected',
      },
    };
  };

  const writeConnections = (
    data: Record<PublishPlatform, StoredTokenRecord>
  ): void => {
    writeJsonFile(connectionsFile, data);
  };

  const updateConnection = (
    platform: PublishPlatform,
    updater: (cur: StoredTokenRecord) => StoredTokenRecord
  ): StoredTokenRecord => {
    const all = readConnections();
    const next = updater(all[platform]);
    all[platform] = next;
    writeConnections(all);
    return next;
  };

  const readJobs = (): PublishJob[] => readJsonFile<PublishJob[]>(jobsFile, []);

  const writeJobs = (jobs: PublishJob[]): void => {
    writeJsonFile(jobsFile, jobs);
  };

  const updateJobTarget = (
    jobId: string,
    platform: PublishPlatform,
    patch: Partial<PublishTargetSpec>
  ): PublishJob | null => {
    const jobs = readJobs();
    const idx = jobs.findIndex((j) => j.id === jobId);
    if (idx === -1) return null;
    const now = new Date().toISOString();
    const existing = jobs[idx];
    const updated: PublishJob = {
      ...existing,
      updatedAt: now,
      targets: {
        ...existing.targets,
        [platform]: {
          ...existing.targets[platform],
          ...patch,
          updatedAt: now,
        },
      },
    };
    jobs[idx] = updated;
    writeJobs(jobs);
    return updated;
  };

  const readNotifications = (): PublishNotification[] =>
    readJsonFile<PublishNotification[]>(notificationsFile, []);

  const pushNotification = (
    item: Omit<PublishNotification, 'id' | 'createdAt' | 'read'>
  ): PublishNotification => {
    const notifications = readNotifications();
    const entry: PublishNotification = {
      id: `notif_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      createdAt: new Date().toISOString(),
      read: false,
      ...item,
    };
    writeJsonFile(notificationsFile, [entry, ...notifications].slice(0, 60));
    return entry;
  };

  const getPublicConnections = (): PlatformConnectionInfo[] => {
    const stored = readConnections();
    return PLATFORMS.map((platform) => {
      const rec = stored[platform];
      const configured = isPlatformConfigured(platform);
      let status: ConnectionStatus = rec.status;
      if (!configured && status !== 'connected' && status !== 'expired') {
        status = 'not_configured';
      } else if (
        status === 'connected' &&
        rec.expiresAt &&
        new Date(rec.expiresAt).getTime() <= Date.now() &&
        !rec.refreshToken
      ) {
        status = 'expired';
      }

      return {
        platform,
        label: PLATFORM_LABELS[platform],
        configured,
        status,
        accountName: rec.accountName,
        accountHandle: rec.accountHandle,
        accountId: rec.accountId,
        connectedAt: rec.connectedAt,
        expiresAt: rec.expiresAt,
        lastError: rec.lastError,
        redirectUri: getRedirectUri(platform),
        requirementsNote: PLATFORM_NOTES[platform],
      };
    });
  };

  const ensureValidToken = async (
    platform: PublishPlatform
  ): Promise<StoredTokenRecord> => {
    const all = readConnections();
    const rec = all[platform];
    if (!rec || rec.status === 'disconnected' || !rec.accessToken) {
      throw Object.assign(
        new Error(
          `${PLATFORM_LABELS[platform]} is not connected. Connect your account before publishing.`
        ),
        { code: 'AUTH_EXPIRED' }
      );
    }
    if (rec.status === 'expired') {
      throw Object.assign(
        new Error(
          `${PLATFORM_LABELS[platform]} authorization expired. Reconnect your account to retry.`
        ),
        { code: 'AUTH_EXPIRED' }
      );
    }

    const expiresMs = rec.expiresAt ? new Date(rec.expiresAt).getTime() : 0;
    const isNearExpiry = expiresMs > 0 && expiresMs - Date.now() < 120_000;
    if (!isNearExpiry) {
      return rec;
    }

    if (platform === 'youtube_shorts' && rec.refreshToken) {
      const { clientId, clientSecret } = getOAuthCreds('youtube_shorts');
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: rec.refreshToken,
          grant_type: 'refresh_token',
        }),
      });
      const json = (await res.json()) as {
        access_token?: string;
        expires_in?: number;
        error_description?: string;
        error?: string;
      };
      if (!res.ok || !json.access_token) {
        updateConnection(platform, (c) => ({
          ...c,
          status: 'expired',
          lastError: json.error_description || json.error || 'Token refresh failed.',
        }));
        throw Object.assign(
          new Error('YouTube OAuth session expired. Please reconnect Google OAuth.'),
          { code: 'AUTH_EXPIRED' }
        );
      }
      return updateConnection(platform, (c) => ({
        ...c,
        status: 'connected',
        accessToken: json.access_token,
        expiresAt: new Date(
          Date.now() + (json.expires_in || 3600) * 1000
        ).toISOString(),
        lastError: undefined,
      }));
    }

    if (platform === 'tiktok' && rec.refreshToken) {
      const { clientId, clientSecret } = getOAuthCreds('tiktok');
      const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_key: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token',
          refresh_token: rec.refreshToken,
        }),
      });
      const json = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error_description?: string;
        error?: string;
      };
      if (!res.ok || !json.access_token) {
        updateConnection(platform, (c) => ({
          ...c,
          status: 'expired',
          lastError: json.error_description || json.error || 'TikTok token refresh failed.',
        }));
        throw Object.assign(
          new Error('TikTok OAuth session expired. Please reconnect TikTok.'),
          { code: 'AUTH_EXPIRED' }
        );
      }
      return updateConnection(platform, (c) => ({
        ...c,
        status: 'connected',
        accessToken: json.access_token,
        refreshToken: json.refresh_token || c.refreshToken,
        expiresAt: new Date(
          Date.now() + (json.expires_in || 86400) * 1000
        ).toISOString(),
        lastError: undefined,
      }));
    }

    updateConnection(platform, (c) => ({
      ...c,
      status: 'expired',
      lastError: 'Access token expired and requires re-authorization.',
    }));
    throw Object.assign(
      new Error(`${PLATFORM_LABELS[platform]} token expired. Please reconnect.`),
      { code: 'AUTH_EXPIRED' }
    );
  };

  const publishToYoutube = async (
    job: PublishJob,
    target: PublishTargetSpec,
    videoPath: string
  ): Promise<void> => {
    const token = await ensureValidToken('youtube_shorts');
    const stat = fs.statSync(videoPath);
    const totalBytes = stat.size;

    updateJobTarget(job.id, 'youtube_shorts', {
      status: 'uploading',
      progress: 12,
      errorMessage: undefined,
    });

    const formattedTags = target.hashtags
      .map((h) => h.replace(/^#/, '').trim())
      .filter(Boolean);
    const hashtagLine = target.hashtags
      .map((h) => (h.startsWith('#') ? h : `#${h}`))
      .join(' ');
    const description = [target.caption.trim(), hashtagLine]
      .filter(Boolean)
      .join('\n\n');
    const titleWithShorts = target.title.includes('#Shorts')
      ? target.title.slice(0, 100)
      : `${target.title.slice(0, 92)} #Shorts`;

    const isNativeScheduled =
      target.scheduleMode === 'scheduled' &&
      target.scheduledAt &&
      new Date(target.scheduledAt).getTime() > Date.now() + 60_000;

    const metadata = {
      snippet: {
        title: titleWithShorts,
        description,
        tags: Array.from(new Set(['Shorts', ...formattedTags])).slice(0, 20),
        categoryId: '22',
      },
      status: {
        privacyStatus: isNativeScheduled ? 'private' : target.privacy,
        ...(isNativeScheduled ? { publishAt: target.scheduledAt } : {}),
        selfDeclaredMadeForKids: false,
      },
    };

    const initRes = await fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(totalBytes),
          'X-Upload-Content-Type': 'video/mp4',
        },
        body: JSON.stringify(metadata),
      }
    );

    if (initRes.status === 401) {
      updateConnection('youtube_shorts', (c) => ({
        ...c,
        status: 'expired',
        lastError: 'YouTube rejected the OAuth token (HTTP 401).',
      }));
      throw Object.assign(
        new Error('YouTube OAuth connection expired. Please reconnect your Google account.'),
        { code: 'AUTH_EXPIRED' }
      );
    }

    const uploadUrl = initRes.headers.get('location');
    if (!initRes.ok || !uploadUrl) {
      const errText = await initRes.text();
      throw new Error(
        `YouTube upload init failed (HTTP ${initRes.status}): ${errText.slice(0, 220)}`
      );
    }

    updateJobTarget(job.id, 'youtube_shorts', { progress: 45 });

    const fileBuffer = fs.readFileSync(videoPath);
    const putRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(totalBytes),
      },
      body: fileBuffer,
    });

    const putBody = (await putRes.json().catch(() => ({}))) as {
      id?: string;
      error?: { message?: string };
    };

    if (!putRes.ok || !putBody.id) {
      throw new Error(
        putBody.error?.message ||
          `YouTube upload failed (HTTP ${putRes.status}).`
      );
    }

    updateJobTarget(job.id, 'youtube_shorts', {
      status: 'published',
      progress: 100,
      remotePostId: putBody.id,
      publishedUrl: `https://youtube.com/shorts/${putBody.id}`,
      errorMessage: undefined,
    });
  };

  const publishToTiktok = async (
    job: PublishJob,
    target: PublishTargetSpec,
    videoPath: string
  ): Promise<void> => {
    const token = await ensureValidToken('tiktok');
    const fileBuffer = fs.readFileSync(videoPath);
    const totalBytes = fileBuffer.byteLength;

    updateJobTarget(job.id, 'tiktok', {
      status: 'uploading',
      progress: 15,
      errorMessage: undefined,
    });

    const privacyLevel =
      target.privacy === 'public'
        ? 'PUBLIC_TO_EVERYONE'
        : target.privacy === 'unlisted'
        ? 'MUTUAL_FOLLOW_FRIENDS'
        : 'SELF_ONLY';

    const hashtagLine = target.hashtags
      .map((h) => (h.startsWith('#') ? h : `#${h}`))
      .join(' ');
    const fullCaption = [target.caption.trim(), hashtagLine]
      .filter(Boolean)
      .join(' ')
      .slice(0, 2200);

    const initRes = await fetch(
      'https://open.tiktokapis.com/v2/post/publish/video/init/',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify({
          post_info: {
            title: fullCaption,
            privacy_level: privacyLevel,
            disable_duet: false,
            disable_comment: false,
            disable_stitch: false,
          },
          source_info: {
            source: 'FILE_UPLOAD',
            video_size: totalBytes,
            chunk_size: totalBytes,
            total_chunk_count: 1,
          },
        }),
      }
    );

    if (initRes.status === 401) {
      updateConnection('tiktok', (c) => ({
        ...c,
        status: 'expired',
        lastError: 'TikTok rejected the OAuth token (HTTP 401).',
      }));
      throw Object.assign(
        new Error('TikTok OAuth session expired. Reconnect your TikTok account.'),
        { code: 'AUTH_EXPIRED' }
      );
    }

    const initData = (await initRes.json().catch(() => ({}))) as {
      data?: { publish_id?: string; upload_url?: string };
      error?: { code?: string; message?: string };
    };

    if (!initRes.ok || !initData.data?.upload_url || !initData.data?.publish_id) {
      const code = initData.error?.code || '';
      const msg =
        initData.error?.message || `TikTok init failed (HTTP ${initRes.status}).`;
      if (/access_token_invalid|scope_not_authorized/i.test(code)) {
        updateConnection('tiktok', (c) => ({
          ...c,
          status: 'expired',
          lastError: msg,
        }));
        throw Object.assign(new Error(msg), { code: 'AUTH_EXPIRED' });
      }
      throw new Error(msg);
    }

    updateJobTarget(job.id, 'tiktok', { progress: 45 });

    const putRes = await fetch(initData.data.upload_url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(totalBytes),
        'Content-Range': `bytes 0-${totalBytes - 1}/${totalBytes}`,
      },
      body: fileBuffer,
    });

    if (!putRes.ok) {
      throw new Error(`TikTok media upload failed (HTTP ${putRes.status}).`);
    }

    updateJobTarget(job.id, 'tiktok', {
      status: 'processing',
      progress: 78,
      remotePostId: initData.data.publish_id,
    });

    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise((r) => setTimeout(r, 2500));
      const statusRes = await fetch(
        'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token.accessToken}`,
            'Content-Type': 'application/json; charset=UTF-8',
          },
          body: JSON.stringify({ publish_id: initData.data.publish_id }),
        }
      );
      const statusData = (await statusRes.json().catch(() => ({}))) as {
        data?: {
          status?: string;
          fail_reason?: string;
          publicaly_available_post_id?: string[];
        };
      };
      const st = statusData.data?.status;
      if (st === 'PUBLISH_COMPLETE') {
        const postId = statusData.data?.publicaly_available_post_id?.[0];
        const handle = token.accountHandle
          ? `@${token.accountHandle.replace(/^@/, '')}`
          : '';
        const publishedUrl =
          postId && handle
            ? `https://www.tiktok.com/${handle}/video/${postId}`
            : undefined;
        updateJobTarget(job.id, 'tiktok', {
          status: 'published',
          progress: 100,
          publishedUrl,
          errorMessage: undefined,
        });
        return;
      }
      if (st === 'FAILED') {
        throw new Error(
          statusData.data?.fail_reason || 'TikTok rejected the uploaded video.'
        );
      }
    }

    throw new Error(
      'TikTok processing timed out before confirmation. Check your TikTok Creator inbox.'
    );
  };

  const publishToInstagram = async (
    job: PublishJob,
    target: PublishTargetSpec
  ): Promise<void> => {
    const token = await ensureValidToken('instagram_reels');
    if (!token.accountId) {
      throw new Error(
        'No linked Instagram Business/Creator account ID found. Reconnect Meta OAuth and select a linked Instagram Professional account.'
      );
    }

    const baseUrl = getBaseAppUrl();
    if (!baseUrl.startsWith('https://')) {
      throw new Error(
        'Instagram Reels API requires a publicly reachable HTTPS video URL. Deploy the app or configure APP_URL with https://.'
      );
    }

    const publicVideoUrl = `${baseUrl}${job.renderedVideoUrl}`;
    const hashtagLine = target.hashtags
      .map((h) => (h.startsWith('#') ? h : `#${h}`))
      .join(' ');
    const caption = [target.caption.trim(), hashtagLine]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 2200);

    updateJobTarget(job.id, 'instagram_reels', {
      status: 'uploading',
      progress: 20,
      errorMessage: undefined,
    });

    const containerRes = await fetch(
      `https://graph.facebook.com/v21.0/${token.accountId}/media`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          media_type: 'REELS',
          video_url: publicVideoUrl,
          caption,
          share_to_feed: true,
          access_token: token.accessToken,
        }),
      }
    );

    const containerJson = (await containerRes.json().catch(() => ({}))) as {
      id?: string;
      error?: { message?: string; code?: number };
    };

    if (
      containerRes.status === 401 ||
      containerJson.error?.code === 190
    ) {
      updateConnection('instagram_reels', (c) => ({
        ...c,
        status: 'expired',
        lastError: containerJson.error?.message || 'Meta OAuth token expired.',
      }));
      throw Object.assign(
        new Error('Instagram / Meta authorization expired. Reconnect Meta OAuth.'),
        { code: 'AUTH_EXPIRED' }
      );
    }

    if (!containerRes.ok || !containerJson.id) {
      throw new Error(
        containerJson.error?.message ||
          `Instagram media container creation failed (HTTP ${containerRes.status}).`
      );
    }

    const creationId = containerJson.id;
    updateJobTarget(job.id, 'instagram_reels', {
      status: 'processing',
      progress: 55,
      remotePostId: creationId,
    });

    let finished = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((r) => setTimeout(r, 3000));
      const statusRes = await fetch(
        `https://graph.facebook.com/v21.0/${creationId}?fields=status_code,status&access_token=${encodeURIComponent(
          token.accessToken || ''
        )}`
      );
      const statusJson = (await statusRes.json().catch(() => ({}))) as {
        status_code?: string;
        status?: string;
      };
      if (statusJson.status_code === 'FINISHED') {
        finished = true;
        break;
      }
      if (statusJson.status_code === 'ERROR' || statusJson.status_code === 'EXPIRED') {
        throw new Error(
          `Instagram Reel processing failed (${statusJson.status_code}): ${
            statusJson.status || 'Unsupported media format.'
          }`
        );
      }
    }

    if (!finished) {
      throw new Error('Instagram Reel processing timed out.');
    }

    updateJobTarget(job.id, 'instagram_reels', { progress: 85 });

    const publishRes = await fetch(
      `https://graph.facebook.com/v21.0/${token.accountId}/media_publish`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          creation_id: creationId,
          access_token: token.accessToken,
        }),
      }
    );

    const publishJson = (await publishRes.json().catch(() => ({}))) as {
      id?: string;
      error?: { message?: string };
    };

    if (!publishRes.ok || !publishJson.id) {
      throw new Error(
        publishJson.error?.message || 'Failed to publish Instagram Reel.'
      );
    }

    let permalink: string | undefined;
    try {
      const linkRes = await fetch(
        `https://graph.facebook.com/v21.0/${publishJson.id}?fields=permalink&access_token=${encodeURIComponent(
          token.accessToken || ''
        )}`
      );
      const linkJson = (await linkRes.json()) as { permalink?: string };
      permalink = linkJson.permalink;
    } catch {
      // Optional permalink fetch
    }

    updateJobTarget(job.id, 'instagram_reels', {
      status: 'published',
      progress: 100,
      remotePostId: publishJson.id,
      publishedUrl: permalink,
      errorMessage: undefined,
    });
  };

  const executePlatformPublish = async (
    jobId: string,
    platform: PublishPlatform
  ): Promise<void> => {
    const lockKey = `${jobId}:${platform}`;
    if (activeUploads.has(lockKey)) return;
    activeUploads.add(lockKey);

    try {
      const job = readJobs().find((j) => j.id === jobId);
      if (!job) return;
      const target = job.targets[platform];
      if (!target || !target.enabled) return;

      const cleanFile = (job.renderedVideoUrl || '')
        .split('?')[0]
        .replace(/^\/exports\//, '');
      const videoPath = path.join(deps.exportsDir, cleanFile);
      if (!cleanFile || !fs.existsSync(videoPath)) {
        throw new Error(
          'Rendered MP4 video file not found on server. Re-render the clip before publishing.'
        );
      }

      if (platform === 'youtube_shorts') {
        await publishToYoutube(job, target, videoPath);
      } else if (platform === 'tiktok') {
        await publishToTiktok(job, target, videoPath);
      } else {
        await publishToInstagram(job, target);
      }

      pushNotification({
        type: 'success',
        platform,
        jobId,
        title: `Published to ${PLATFORM_LABELS[platform]}`,
        message: `"${job.clipTitle}" was published successfully.`,
      });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : `Failed to publish to ${PLATFORM_LABELS[platform]}.`;
      const isAuthError =
        (err as { code?: string })?.code === 'AUTH_EXPIRED' ||
        /expired|reconnect|401|oauth/i.test(message);

      updateJobTarget(jobId, platform, {
        status: isAuthError ? 'auth_expired' : 'failed',
        progress: 0,
        errorMessage: message,
      });

      pushNotification({
        type: isAuthError ? 'auth_expired' : 'error',
        platform,
        jobId,
        title: isAuthError
          ? `${PLATFORM_LABELS[platform]} connection expired`
          : `${PLATFORM_LABELS[platform]} upload failed`,
        message,
      });
    } finally {
      activeUploads.delete(lockKey);
    }
  };

  // Routes
  app.get('/api/publish/state', (_req, res) => {
    res.json({
      connections: getPublicConnections(),
      jobs: readJobs(),
      notifications: readNotifications(),
    });
  });

  app.get('/api/oauth/:platform/url', (req, res) => {
    const platform = SLUG_TO_PLATFORM[req.params.platform];
    if (!platform) {
      res.status(400).json({ error: 'Unsupported publishing platform.' });
      return;
    }

    const redirectUri = getRedirectUri(platform);
    if (!isPlatformConfigured(platform)) {
      res.status(400).json({
        error: `${PLATFORM_LABELS[platform]} OAuth credentials are not configured on the server. Add the required environment variables and callback URL (${redirectUri}) first.`,
        redirectUri,
      });
      return;
    }

    const state = crypto.randomBytes(16).toString('hex');
    oauthStates.set(state, { platform, createdAt: Date.now() });

    let authUrl = '';
    const { clientId } = getOAuthCreds(platform);
    if (platform === 'youtube_shorts') {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope:
          'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
        access_type: 'offline',
        prompt: 'consent',
        state,
      });
      authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    } else if (platform === 'tiktok') {
      const params = new URLSearchParams({
        client_key: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'user.info.basic,video.publish,video.upload',
        state,
      });
      authUrl = `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
    } else {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope:
          'instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement',
        state,
      });
      authUrl = `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`;
    }

    res.json({ url: authUrl, redirectUri });
  });

  const handleOAuthCallback = async (req: Request, res: Response) => {
    const platform = SLUG_TO_PLATFORM[req.params.platform];
    const renderPopupHtml = (ok: boolean, message: string) => {
      const payload = JSON.stringify(
        ok
          ? { type: 'OAUTH_AUTH_SUCCESS', platform }
          : { type: 'OAUTH_AUTH_ERROR', platform, error: message }
      );
      res.send(`<!doctype html>
<html>
  <body style="background:#0B0D12;color:#F3F4F6;font-family:system-ui,sans-serif;padding:24px;">
    <script>
      if (window.opener) {
        window.opener.postMessage(${payload}, '*');
        window.close();
      } else {
        window.location.href = '/';
      }
    </script>
    <p>${message}</p>
  </body>
</html>`);
    };

    if (!platform) {
      renderPopupHtml(false, 'Unsupported OAuth platform.');
      return;
    }

    const { code, state, error, error_description } = req.query as Record<
      string,
      string | undefined
    >;

    if (error) {
      renderPopupHtml(false, error_description || error);
      return;
    }

    if (!code || !state) {
      renderPopupHtml(false, 'Missing OAuth authorization code or state.');
      return;
    }

    const savedState = oauthStates.get(state);
    oauthStates.delete(state);
    if (!savedState || savedState.platform !== platform) {
      renderPopupHtml(false, 'Invalid or expired OAuth state parameter.');
      return;
    }

    const redirectUri = getRedirectUri(platform);

    try {
      if (platform === 'youtube_shorts') {
        const { clientId, clientSecret } = getOAuthCreds('youtube_shorts');
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
          }),
        });
        const tokenJson = (await tokenRes.json()) as {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          error_description?: string;
          error?: string;
        };
        if (!tokenRes.ok || !tokenJson.access_token) {
          throw new Error(
            tokenJson.error_description ||
              tokenJson.error ||
              'Failed to exchange Google OAuth code.'
          );
        }

        let accountName = 'YouTube Channel';
        let accountHandle = '';
        let accountId = '';
        const chRes = await fetch(
          'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
          {
            headers: { Authorization: `Bearer ${tokenJson.access_token}` },
          }
        );
        if (chRes.ok) {
          const chJson = (await chRes.json()) as {
            items?: Array<{
              id?: string;
              snippet?: { title?: string; customUrl?: string };
            }>;
          };
          const ch = chJson.items?.[0];
          if (ch) {
            accountId = ch.id || '';
            accountName = ch.snippet?.title || accountName;
            accountHandle = ch.snippet?.customUrl || '';
          }
        }

        updateConnection('youtube_shorts', (prev) => ({
          platform: 'youtube_shorts',
          status: 'connected',
          accessToken: tokenJson.access_token,
          refreshToken: tokenJson.refresh_token || prev.refreshToken,
          expiresAt: new Date(
            Date.now() + (tokenJson.expires_in || 3600) * 1000
          ).toISOString(),
          accountName,
          accountHandle,
          accountId,
          connectedAt: new Date().toISOString(),
          lastError: undefined,
        }));
      } else if (platform === 'tiktok') {
        const { clientId, clientSecret } = getOAuthCreds('tiktok');
        const tokenRes = await fetch(
          'https://open.tiktokapis.com/v2/oauth/token/',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_key: clientId,
              client_secret: clientSecret,
              code,
              grant_type: 'authorization_code',
              redirect_uri: redirectUri,
            }),
          }
        );
        const tokenJson = (await tokenRes.json()) as {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          open_id?: string;
          error_description?: string;
          error?: string;
        };
        if (!tokenRes.ok || !tokenJson.access_token) {
          throw new Error(
            tokenJson.error_description ||
              tokenJson.error ||
              'Failed to exchange TikTok OAuth code.'
          );
        }

        let accountName = 'TikTok Creator';
        let accountHandle = '';
        const profileRes = await fetch(
          'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,username',
          {
            headers: { Authorization: `Bearer ${tokenJson.access_token}` },
          }
        );
        if (profileRes.ok) {
          const profJson = (await profileRes.json()) as {
            data?: { user?: { display_name?: string; username?: string } };
          };
          accountName = profJson.data?.user?.display_name || accountName;
          accountHandle = profJson.data?.user?.username
            ? `@${profJson.data.user.username.replace(/^@/, '')}`
            : '';
        }

        updateConnection('tiktok', (prev) => ({
          platform: 'tiktok',
          status: 'connected',
          accessToken: tokenJson.access_token,
          refreshToken: tokenJson.refresh_token || prev.refreshToken,
          expiresAt: new Date(
            Date.now() + (tokenJson.expires_in || 86400) * 1000
          ).toISOString(),
          accountName,
          accountHandle,
          accountId: tokenJson.open_id,
          connectedAt: new Date().toISOString(),
          lastError: undefined,
        }));
      } else {
        const { clientId, clientSecret } = getOAuthCreds('instagram_reels');
        const tokenParams = new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          code,
        });
        const tokenRes = await fetch(
          `https://graph.facebook.com/v21.0/oauth/access_token?${tokenParams.toString()}`
        );
        const tokenJson = (await tokenRes.json()) as {
          access_token?: string;
          expires_in?: number;
          error?: { message?: string };
        };
        if (!tokenRes.ok || !tokenJson.access_token) {
          throw new Error(
            tokenJson.error?.message || 'Failed to exchange Meta OAuth code.'
          );
        }

        let accessToken = tokenJson.access_token;
        let expiresIn = tokenJson.expires_in || 3600;

        // Exchange for long-lived Meta token when available
        const llParams = new URLSearchParams({
          grant_type: 'fb_exchange_token',
          client_id: clientId,
          client_secret: clientSecret,
          fb_exchange_token: accessToken,
        });
        const llRes = await fetch(
          `https://graph.facebook.com/v21.0/oauth/access_token?${llParams.toString()}`
        );
        if (llRes.ok) {
          const llJson = (await llRes.json()) as {
            access_token?: string;
            expires_in?: number;
          };
          if (llJson.access_token) {
            accessToken = llJson.access_token;
            expiresIn = llJson.expires_in || 60 * 60 * 24 * 60;
          }
        }

        const acctRes = await fetch(
          `https://graph.facebook.com/v21.0/me/accounts?fields=instagram_business_account{id,username,name}&access_token=${encodeURIComponent(
            accessToken
          )}`
        );
        const acctJson = (await acctRes.json()) as {
          data?: Array<{
            instagram_business_account?: {
              id: string;
              username?: string;
              name?: string;
            };
          }>;
        };

        const igAccount = acctJson.data?.find(
          (page) => page.instagram_business_account?.id
        )?.instagram_business_account;

        if (!igAccount) {
          throw new Error(
            'No Instagram Professional (Business or Creator) account linked to your Facebook Pages was found.'
          );
        }

        updateConnection('instagram_reels', () => ({
          platform: 'instagram_reels',
          status: 'connected',
          accessToken,
          expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
          accountName: igAccount.name || igAccount.username || 'Instagram Reels',
          accountHandle: igAccount.username
            ? `@${igAccount.username.replace(/^@/, '')}`
            : '',
          accountId: igAccount.id,
          connectedAt: new Date().toISOString(),
          lastError: undefined,
        }));
      }

      renderPopupHtml(
        true,
        `${PLATFORM_LABELS[platform]} connected successfully. You can close this window.`
      );
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : `Failed to connect ${PLATFORM_LABELS[platform]}.`;
      updateConnection(platform, (prev) => ({
        ...prev,
        status: 'error',
        lastError: msg,
      }));
      pushNotification({
        type: 'error',
        platform,
        title: `${PLATFORM_LABELS[platform]} connection failed`,
        message: msg,
      });
      renderPopupHtml(false, msg);
    }
  };

  app.get(
    ['/api/oauth/:platform/callback', '/api/oauth/:platform/callback/'],
    handleOAuthCallback
  );

  app.post('/api/publish/connections/:platform/disconnect', (req, res) => {
    const platform = SLUG_TO_PLATFORM[req.params.platform];
    if (!platform) {
      res.status(400).json({ error: 'Unsupported publishing platform.' });
      return;
    }
    updateConnection(platform, () => ({
      platform,
      status: 'disconnected',
    }));
    res.json({ connections: getPublicConnections() });
  });

  app.post('/api/publish/jobs', (req, res) => {
    const { projectId, clipId, targets } = req.body as {
      projectId?: string;
      clipId?: string;
      targets?: Partial<
        Record<
          PublishPlatform,
          {
            enabled: boolean;
            title?: string;
            caption?: string;
            hashtags?: string[];
            privacy?: PublishPrivacy;
            scheduleMode?: 'now' | 'scheduled';
            scheduledAt?: string;
          }
        >
      >;
    };

    if (!projectId || !clipId || !targets) {
      res.status(400).json({
        error: 'projectId, clipId, and platform targets are required.',
      });
      return;
    }

    const project = deps.readProjects().find((p) => p.id === projectId);
    const clip = project?.clips.find((c) => c.id === clipId);
    if (!project || !clip) {
      res.status(404).json({ error: 'Project or clip not found.' });
      return;
    }

    if (!clip.approved) {
      res.status(400).json({
        error:
          'Review-first requirement: Please preview and approve this clip before queuing it for publishing.',
      });
      return;
    }

    if (clip.renderStatus !== 'completed' || !clip.renderedVideoUrl) {
      res.status(400).json({
        error:
          'Render this clip to MP4 via FFmpeg before publishing to social platforms.',
      });
      return;
    }

    const enabledPlatforms = PLATFORMS.filter((p) => targets[p]?.enabled);
    if (enabledPlatforms.length === 0) {
      res.status(400).json({
        error: 'Select at least one destination platform to publish or schedule.',
      });
      return;
    }

    for (const plat of enabledPlatforms) {
      const spec = targets[plat]!;
      if (spec.scheduleMode === 'scheduled') {
        if (!spec.scheduledAt || Number.isNaN(new Date(spec.scheduledAt).getTime())) {
          res.status(400).json({
            error: `Provide a valid schedule date & time for ${PLATFORM_LABELS[plat]}.`,
          });
          return;
        }
      }
    }

    const now = new Date().toISOString();
    const buildTarget = (plat: PublishPlatform): PublishTargetSpec => {
      const input = targets[plat];
      const enabled = Boolean(input?.enabled);
      const scheduleMode = input?.scheduleMode || 'now';
      return {
        platform: plat,
        enabled,
        title: (input?.title || clip.title).trim(),
        caption: (
          input?.caption ||
          clip.platformCaptions[plat] ||
          clip.socialCaption
        ).trim(),
        hashtags: Array.isArray(input?.hashtags)
          ? input!.hashtags
          : clip.hashtags,
        privacy: input?.privacy || 'public',
        scheduleMode,
        scheduledAt:
          enabled && scheduleMode === 'scheduled' ? input?.scheduledAt : undefined,
        status: !enabled
          ? 'pending'
          : scheduleMode === 'scheduled'
          ? 'scheduled'
          : 'uploading',
        progress: !enabled ? 0 : scheduleMode === 'scheduled' ? 0 : 5,
        updatedAt: now,
      };
    };

    const job: PublishJob = {
      id: `pub_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
      projectId: project.id,
      projectTitle: project.title,
      clipId: clip.id,
      clipTitle: clip.title,
      clipThumbnailUrl: clip.thumbnailUrl || project.thumbnailUrl,
      renderedVideoUrl: clip.renderedVideoUrl,
      approvedAt: clip.approvedAt || now,
      createdAt: now,
      updatedAt: now,
      targets: {
        youtube_shorts: buildTarget('youtube_shorts'),
        tiktok: buildTarget('tiktok'),
        instagram_reels: buildTarget('instagram_reels'),
      },
    };

    const jobs = readJobs();
    writeJobs([job, ...jobs]);

    for (const plat of enabledPlatforms) {
      if (job.targets[plat].scheduleMode === 'now') {
        executePlatformPublish(job.id, plat).catch((err) => {
          console.error(`Publish error (${plat}):`, err);
        });
      }
    }

    res.status(201).json({
      job,
      jobs: readJobs(),
      connections: getPublicConnections(),
      notifications: readNotifications(),
    });
  });

  app.post('/api/publish/jobs/:jobId/retry/:platform', (req, res) => {
    const platform = SLUG_TO_PLATFORM[req.params.platform];
    if (!platform) {
      res.status(400).json({ error: 'Unsupported publishing platform.' });
      return;
    }

    const jobs = readJobs();
    const job = jobs.find((j) => j.id === req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Publishing job not found.' });
      return;
    }

    const updated = updateJobTarget(job.id, platform, {
      enabled: true,
      status: 'uploading',
      progress: 5,
      errorMessage: undefined,
    });

    executePlatformPublish(job.id, platform).catch((err) => {
      console.error(`Retry publish error (${platform}):`, err);
    });

    res.json({
      job: updated,
      jobs: readJobs(),
      connections: getPublicConnections(),
      notifications: readNotifications(),
    });
  });

  app.delete('/api/publish/jobs/:jobId', (req, res) => {
    const jobs = readJobs();
    const next = jobs.filter((j) => j.id !== req.params.jobId);
    writeJobs(next);
    res.json({ jobs: next });
  });

  app.post('/api/publish/notifications/mark-read', (_req, res) => {
    const updated = readNotifications().map((n) => ({ ...n, read: true }));
    writeJsonFile(notificationsFile, updated);
    res.json({ notifications: updated });
  });

  app.delete('/api/publish/notifications', (_req, res) => {
    const unread = readNotifications().filter((n) => !n.read);
    writeJsonFile(notificationsFile, unread);
    res.json({ notifications: unread });
  });

  // Independent per-platform scheduler tick every 15 seconds
  const schedulerInterval = setInterval(() => {
    const now = Date.now();
    const jobs = readJobs();
    for (const job of jobs) {
      for (const plat of PLATFORMS) {
        const target = job.targets[plat];
        if (
          target?.enabled &&
          target.status === 'scheduled' &&
          target.scheduledAt &&
          new Date(target.scheduledAt).getTime() <= now
        ) {
          executePlatformPublish(job.id, plat).catch((err) => {
            console.error(`Scheduled publish error (${plat}):`, err);
          });
        }
      }
    }
  }, 15_000);

  return {
    stopScheduler: () => clearInterval(schedulerInterval),
  };
}

import dotenv from 'dotenv';
import type { Request } from 'express';
import fs from 'fs';
import path from 'path';

const ROOT_DIR = process.cwd();
const FIREBASE_CONFIG_PATH = path.join(ROOT_DIR, 'firebase-applet-config.json');

export interface AutoConnectEnvReport {
  resolvedAppUrl: string;
  appUrlSource: 'env' | 'platform_env' | 'request_headers' | 'localhost';
  allowedOriginsList: string[];
  allowedOriginsMode: 'explicit' | 'auto';
  oauthCallbacks: {
    youtube: string;
    tiktok: string;
    instagram: string;
  };
  firebase: {
    configured: boolean;
    projectId?: string;
    databaseId?: string;
    authDomain?: string;
  };
  envStatus: {
    geminiApiKey: boolean;
    appUrl: boolean;
    firebaseConfig: boolean;
    youtubeOAuth: boolean;
    youtubePartial?: 'missing_secret' | 'missing_id';
    tiktokOAuth: boolean;
    tiktokPartial?: 'missing_secret' | 'missing_id';
    instagramOAuth: boolean;
    instagramPartial?: 'missing_secret' | 'missing_id';
    allowedOrigins: boolean;
    allowedOriginsMode: 'explicit' | 'auto';
  };
}

export function isPlaceholderValue(val: string | undefined): boolean {
  const trimmed = (val || '').trim();
  if (!trimmed) return true;
  return (
    trimmed.startsWith('MY_') ||
    trimmed === 'remixed-project-id' ||
    trimmed === 'YOUR_API_KEY'
  );
}

export function readFirstRealEnv(...keys: string[]): string {
  for (const key of keys) {
    const val = (process.env[key] || '').trim();
    if (val && !isPlaceholderValue(val)) {
      return val;
    }
  }
  return '';
}

function loadEnvFileIntoProcess(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = dotenv.parse(raw);
    for (const [key, value] of Object.entries(parsed)) {
      const current = process.env[key];
      if (isPlaceholderValue(current) && !isPlaceholderValue(value)) {
        process.env[key] = value.trim();
      }
    }
  } catch {
    // Ignore malformed local env files
  }
}

export function loadEnvironmentFiles(): void {
  const mode = process.env.NODE_ENV || 'development';
  const candidates = [
    path.join(ROOT_DIR, `.env.${mode}.local`),
    path.join(ROOT_DIR, '.env.local'),
    path.join(ROOT_DIR, `.env.${mode}`),
    path.join(ROOT_DIR, '.env'),
  ];
  for (const filePath of candidates) {
    loadEnvFileIntoProcess(filePath);
  }
}

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed || isPlaceholderValue(trimmed)) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return null;
}

export function resolveAppUrl(
  req?: Request,
  fallbackPort = Number(process.env.PORT || 3000)
): {
  url: string;
  source: 'env' | 'platform_env' | 'request_headers' | 'localhost';
} {
  const explicitAppUrl = normalizeUrl(process.env.APP_URL || '');
  if (explicitAppUrl) {
    return { url: explicitAppUrl, source: 'env' };
  }

  const platformCandidates = [
    process.env.PUBLIC_URL,
    process.env.RENDER_EXTERNAL_URL,
    process.env.RAILWAY_PUBLIC_DOMAIN,
    process.env.VERCEL_URL,
    process.env.DEPLOY_PRIME_URL,
    process.env.URL,
  ];
  for (const candidate of platformCandidates) {
    const normalized = normalizeUrl(candidate || '');
    if (normalized) {
      return { url: normalized, source: 'platform_env' };
    }
  }

  if (req) {
    const forwardedHost = (req.headers['x-forwarded-host'] as string | undefined)
      ?.split(',')[0]
      ?.trim();
    const host = forwardedHost || req.get('host');
    if (host) {
      const forwardedProto = (req.headers['x-forwarded-proto'] as string | undefined)
        ?.split(',')[0]
        ?.trim();
      const proto =
        forwardedProto ||
        (host.includes('localhost') || host.startsWith('127.0.0.1')
          ? req.protocol || 'http'
          : 'https');
      return { url: `${proto}://${host}`.replace(/\/+$/, ''), source: 'request_headers' };
    }
  }

  return { url: `http://localhost:${fallbackPort}`, source: 'localhost' };
}

export function resolveAllowedOrigins(resolvedAppUrl: string): {
  origins: string[];
  mode: 'explicit' | 'auto';
} {
  const explicitRaw = readFirstRealEnv('ALLOWED_ORIGINS');
  if (explicitRaw) {
    const list = explicitRaw
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter(Boolean);
    if (list.length > 0) {
      return { origins: list, mode: 'explicit' };
    }
  }

  const autoSet = new Set<string>();
  const cleanBase = resolvedAppUrl.replace(/\/+$/, '');
  if (cleanBase) {
    autoSet.add(cleanBase);
    // Support both AI Studio dev and shared preview twin origins automatically
    if (cleanBase.includes('://ais-dev-')) {
      autoSet.add(cleanBase.replace('://ais-dev-', '://ais-pre-'));
    } else if (cleanBase.includes('://ais-pre-')) {
      autoSet.add(cleanBase.replace('://ais-pre-', '://ais-dev-'));
    }
  }
  const port = Number(process.env.PORT || 3000);
  autoSet.add(`http://localhost:${port}`);
  autoSet.add('http://localhost:3000');

  return { origins: Array.from(autoSet), mode: 'auto' };
}

export function readFirebaseAppletConfig(): {
  configured: boolean;
  projectId?: string;
  databaseId?: string;
  authDomain?: string;
} {
  try {
    if (!fs.existsSync(FIREBASE_CONFIG_PATH)) {
      return { configured: false };
    }
    const parsed = JSON.parse(fs.readFileSync(FIREBASE_CONFIG_PATH, 'utf-8')) as {
      projectId?: string;
      firestoreDatabaseId?: string;
      authDomain?: string;
      apiKey?: string;
    };
    const valid =
      Boolean(parsed.projectId) &&
      !isPlaceholderValue(parsed.projectId) &&
      Boolean(parsed.apiKey) &&
      !isPlaceholderValue(parsed.apiKey) &&
      Boolean(parsed.firestoreDatabaseId);
    return {
      configured: valid,
      projectId: parsed.projectId,
      databaseId: parsed.firestoreDatabaseId,
      authDomain: parsed.authDomain,
    };
  } catch {
    return { configured: false };
  }
}

export function bindCanonicalEnvAliases(req?: Request): void {
  loadEnvironmentFiles();

  // Bind Gemini key alias if provided under an alternative standard name
  if (isPlaceholderValue(process.env.GEMINI_API_KEY)) {
    const aliasKey = readFirstRealEnv(
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'GOOGLE_API_KEY',
      'API_KEY'
    );
    if (aliasKey) {
      process.env.GEMINI_API_KEY = aliasKey;
    }
  }

  // Bind APP_URL if resolved from hosting environment or live proxy headers
  if (isPlaceholderValue(process.env.APP_URL)) {
    const resolved = resolveAppUrl(req);
    if (resolved.source !== 'localhost') {
      process.env.APP_URL = resolved.url;
    }
  }

  // Bind OAuth aliases to canonical keys when found
  if (isPlaceholderValue(process.env.GOOGLE_CLIENT_ID)) {
    const ytId = readFirstRealEnv('YOUTUBE_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_ID');
    if (ytId) process.env.GOOGLE_CLIENT_ID = ytId;
  }
  if (isPlaceholderValue(process.env.GOOGLE_CLIENT_SECRET)) {
    const ytSecret = readFirstRealEnv('YOUTUBE_CLIENT_SECRET', 'GOOGLE_OAUTH_CLIENT_SECRET');
    if (ytSecret) process.env.GOOGLE_CLIENT_SECRET = ytSecret;
  }

  if (isPlaceholderValue(process.env.TIKTOK_CLIENT_KEY)) {
    const ttId = readFirstRealEnv('TIKTOK_CLIENT_ID');
    if (ttId) process.env.TIKTOK_CLIENT_KEY = ttId;
  }

  if (isPlaceholderValue(process.env.META_APP_ID)) {
    const igId = readFirstRealEnv(
      'INSTAGRAM_APP_ID',
      'FACEBOOK_APP_ID',
      'META_CLIENT_ID',
      'INSTAGRAM_CLIENT_ID',
      'FACEBOOK_CLIENT_ID'
    );
    if (igId) process.env.META_APP_ID = igId;
  }
  if (isPlaceholderValue(process.env.META_APP_SECRET)) {
    const igSecret = readFirstRealEnv(
      'INSTAGRAM_APP_SECRET',
      'FACEBOOK_APP_SECRET',
      'META_CLIENT_SECRET',
      'INSTAGRAM_CLIENT_SECRET',
      'FACEBOOK_CLIENT_SECRET'
    );
    if (igSecret) process.env.META_APP_SECRET = igSecret;
  }
}

export function autoConnectEnvironment(req?: Request): AutoConnectEnvReport {
  bindCanonicalEnvAliases(req);

  const { url: resolvedAppUrl, source: appUrlSource } = resolveAppUrl(req);
  const { origins: allowedOriginsList, mode: allowedOriginsMode } =
    resolveAllowedOrigins(resolvedAppUrl);
  const firebase = readFirebaseAppletConfig();

  const geminiApiKey = Boolean(
    readFirstRealEnv(
      'GEMINI_API_KEY',
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'GOOGLE_API_KEY',
      'API_KEY'
    )
  );

  const ytId = Boolean(
    readFirstRealEnv('GOOGLE_CLIENT_ID', 'YOUTUBE_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_ID')
  );
  const ytSecret = Boolean(
    readFirstRealEnv(
      'GOOGLE_CLIENT_SECRET',
      'YOUTUBE_CLIENT_SECRET',
      'GOOGLE_OAUTH_CLIENT_SECRET'
    )
  );
  const ttId = Boolean(readFirstRealEnv('TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_ID'));
  const ttSecret = Boolean(readFirstRealEnv('TIKTOK_CLIENT_SECRET'));
  const igId = Boolean(
    readFirstRealEnv(
      'META_APP_ID',
      'INSTAGRAM_APP_ID',
      'FACEBOOK_APP_ID',
      'META_CLIENT_ID',
      'INSTAGRAM_CLIENT_ID',
      'FACEBOOK_CLIENT_ID'
    )
  );
  const igSecret = Boolean(
    readFirstRealEnv(
      'META_APP_SECRET',
      'INSTAGRAM_APP_SECRET',
      'FACEBOOK_APP_SECRET',
      'META_CLIENT_SECRET',
      'INSTAGRAM_CLIENT_SECRET',
      'FACEBOOK_CLIENT_SECRET'
    )
  );

  return {
    resolvedAppUrl,
    appUrlSource,
    allowedOriginsList,
    allowedOriginsMode,
    oauthCallbacks: {
      youtube: `${resolvedAppUrl}/api/oauth/youtube/callback`,
      tiktok: `${resolvedAppUrl}/api/oauth/tiktok/callback`,
      instagram: `${resolvedAppUrl}/api/oauth/instagram/callback`,
    },
    firebase,
    envStatus: {
      geminiApiKey,
      appUrl: appUrlSource !== 'localhost' || Boolean(readFirstRealEnv('APP_URL')),
      firebaseConfig: firebase.configured,
      youtubeOAuth: ytId && ytSecret,
      youtubePartial: ytId !== ytSecret ? (ytId ? 'missing_secret' : 'missing_id') : undefined,
      tiktokOAuth: ttId && ttSecret,
      tiktokPartial: ttId !== ttSecret ? (ttId ? 'missing_secret' : 'missing_id') : undefined,
      instagramOAuth: igId && igSecret,
      instagramPartial: igId !== igSecret ? (igId ? 'missing_secret' : 'missing_id') : undefined,
      allowedOrigins: allowedOriginsList.length > 0,
      allowedOriginsMode,
    },
  };
}

import { GoogleGenAI, MediaResolution, Type } from '@google/genai';
import { ZipArchive } from 'archiver';
import { execFile } from 'child_process';
import express from 'express';
import fs from 'fs';
import http from 'http';
import multer from 'multer';
import path from 'path';
import { promisify } from 'util';
import type {
  AppSettings,
  AspectRatioFormat,
  ClipCandidate,
  Project,
  ProjectSettings,
  SubtitleStylePreset,
  TranscriptSegment,
} from './src/types.ts';
import {
  autoConnectEnvironment,
  bindCanonicalEnvAliases,
  readFirstRealEnv,
} from './server/env.ts';
import { registerPublishingRoutes } from './server/publishing.ts';

bindCanonicalEnvAliases();

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, 'data');
const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');
const EXPORTS_DIR = path.join(ROOT_DIR, 'exports');
const THUMBNAILS_DIR = path.join(DATA_DIR, 'thumbnails');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

for (const dir of [DATA_DIR, UPLOADS_DIR, EXPORTS_DIR, THUMBNAILS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const DEFAULT_APP_SETTINGS: AppSettings = {
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

function readSettings(): AppSettings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
      return { ...DEFAULT_APP_SETTINGS, ...parsed };
    }
  } catch {
    // Fallback to defaults if file is unreadable
  }
  return { ...DEFAULT_APP_SETTINGS };
}

function writeSettings(settings: AppSettings): void {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function readProjects(): Project[] {
  try {
    if (fs.existsSync(PROJECTS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8'));
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // Fallback to empty list
  }
  return [];
}

function writeProjects(projects: Project[]): void {
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
}

function recoverInterruptedProjects(): void {
  const projects = readProjects();
  let changed = false;
  const recovered = projects.map((p) => {
    if (p.status === 'processing') {
      changed = true;
      return {
        ...p,
        status: 'failed' as const,
        analysisStage: 'failed' as const,
        analysisMessage:
          'Analysis was interrupted by a server restart. Click Retry Analysis to run again.',
        errorMessage:
          'Analysis was interrupted by a server restart. Click Retry Analysis to run again.',
        updatedAt: new Date().toISOString(),
      };
    }
    return p;
  });
  if (changed) {
    writeProjects(recovered);
  }
}

function upsertProject(project: Project): void {
  const projects = readProjects();
  const idx = projects.findIndex((p) => p.id === project.id);
  if (idx >= 0) {
    projects[idx] = project;
  } else {
    projects.unshift(project);
  }
  writeProjects(projects);
}

function updateProjectInStore(
  projectId: string,
  updater: (p: Project) => Project
): Project | null {
  const projects = readProjects();
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx < 0) return null;
  const updated = updater({ ...projects[idx], updatedAt: new Date().toISOString() });
  projects[idx] = updated;
  writeProjects(projects);
  return updated;
}

function createGeminiClient(): GoogleGenAI {
  bindCanonicalEnvAliases();
  const apiKey = readFirstRealEnv(
    'GEMINI_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'GOOGLE_API_KEY',
    'API_KEY'
  );
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured. Please add your Gemini API key in Settings > Secrets.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function extractYoutubeId(rawUrl: string): string | null {
  try {
    const trimmed = rawUrl.trim();
    const withProtocol = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const u = new URL(withProtocol);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0];
      return id && id.length >= 6 ? id : null;
    }
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      const v = u.searchParams.get('v');
      if (v) return v;
      const parts = u.pathname.split('/').filter(Boolean);
      if (['shorts', 'live', 'embed', 'v'].includes(parts[0]) && parts[1]) {
        return parts[1];
      }
    }
  } catch {
    return null;
  }
  return null;
}

function parseModelJson<T>(rawText: string | undefined): T {
  const cleaned = (rawText || '{}')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  return JSON.parse(cleaned || '{}') as T;
}

async function generateContentWithFallback(
  ai: GoogleGenAI,
  preferredModel: string | undefined,
  request: Omit<Parameters<GoogleGenAI['models']['generateContent']>[0], 'model'>
) {
  const primary = preferredModel || 'gemini-4-hydrogen';
  const fallback =
    primary === 'gemini-3.1-flash-lite'
      ? 'gemini-4-hydrogen'
      : 'gemini-3.1-flash-lite';
  const candidates = [primary, primary, fallback];
  let lastError: unknown;

  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    try {
      return await ai.models.generateContent({
        model,
        ...request,
      });
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient =
        /503|429|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|overloaded|temporar/i.test(
          msg
        );
      if (!isTransient || i === candidates.length - 1) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
  throw lastError;
}

async function fetchYoutubeMetadata(
  canonicalUrl: string,
  videoId: string
): Promise<{ title: string; author: string; thumbnailUrl: string }> {
  const fallbackThumb = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      canonicalUrl
    )}&format=json`;
    const res = await fetch(oembedUrl);
    if (res.ok) {
      const data = (await res.json()) as {
        title?: string;
        author_name?: string;
        thumbnail_url?: string;
      };
      return {
        title: data.title || `YouTube Video (${videoId})`,
        author: data.author_name || 'YouTube Creator',
        thumbnailUrl: data.thumbnail_url || fallbackThumb,
      };
    }
  } catch {
    // Ignore oEmbed failure and use fallback metadata
  }
  return {
    title: `YouTube Video (${videoId})`,
    author: 'YouTube Creator',
    thumbnailUrl: fallbackThumb,
  };
}

async function probeMedia(filePath: string): Promise<{
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
}> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);
  const info = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
    }>;
  };
  const videoStream = info.streams?.find((s) => s.codec_type === 'video');
  const audioStream = info.streams?.find((s) => s.codec_type === 'audio');
  return {
    durationSeconds: Math.max(1, Math.round(Number(info.format?.duration || 0))),
    width: videoStream?.width || 1920,
    height: videoStream?.height || 1080,
    hasAudio: Boolean(audioStream),
  };
}

async function extractThumbnailFrame(
  videoPath: string,
  timestampSeconds: number,
  outFilename: string
): Promise<string | undefined> {
  const outPath = path.join(THUMBNAILS_DIR, outFilename);
  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-ss',
      String(Math.max(0, timestampSeconds)),
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-vf',
      'scale=1280:-2:flags=lanczos',
      '-q:v',
      '2',
      outPath,
    ]);
    if (fs.existsSync(outPath)) {
      return `/thumbnails/${outFilename}`;
    }
  } catch {
    // Fallback if seeking past end
  }
  return undefined;
}

function getDurationRangeText(settings: ProjectSettings): string {
  switch (settings.durationPreset) {
    case '15-30':
      return '15 to 30 seconds each';
    case '30-60':
      return '30 to 60 seconds each';
    case '60-90':
      return '60 to 90 seconds each';
    case 'custom':
      return `${settings.customMinSeconds} to ${settings.customMaxSeconds} seconds each`;
    case 'auto':
    default:
      return '15 to 60 seconds each, choosing the natural viral arc duration';
  }
}

function buildAnalysisPrompt(
  settings: ProjectSettings,
  durationHint?: number,
  windowInfo?: { startSeconds: number; endSeconds: number; clipCountOverride?: number }
): string {
  const targetCount = windowInfo?.clipCountOverride
    ? Math.max(2, windowInfo.clipCountOverride)
    : Math.min(12, Math.max(4, settings.maxClips));
  const minCount = windowInfo?.clipCountOverride ? 1 : Math.min(4, targetCount);

  let durationClause = 'Ensure all timestamps accurately reflect the actual video timeline.';
  if (windowInfo) {
    const windowDur = Math.max(10, windowInfo.endSeconds - windowInfo.startSeconds);
    durationClause = `You are inspecting a segment of the full video spanning ${windowDur} seconds (from ${windowInfo.startSeconds}s to ${windowInfo.endSeconds}s). Report all startSeconds and endSeconds RELATIVE to the start of this segment (between 0 and ${windowDur} seconds).`;
  } else if (durationHint) {
    durationClause = `The total video duration is approximately ${durationHint} seconds. Never output timestamps exceeding ${durationHint} seconds.`;
  }

  return `You are an expert short-form viral video producer and editor for TikTok, YouTube Shorts, Instagram Reels, and Facebook Reels.
Analyze the provided video carefully (visuals, facial expressions, emotional tone, speaker turns, speech content, humor, surprises, and educational insights).
${durationClause}

Select between ${minCount} and ${targetCount} distinct, non-overlapping high-retention viral moments.
Target clip length: ${getDurationRangeText(settings)}.
${settings.deduplicateClips ? 'Ensure zero duplicate or overlapping topics across clips.' : ''}

Evaluate EVERY clip strictly using this 100-point Viral Score Rubric:
- openingHook (0-20): Attention-grabbing first 3 seconds (pattern interrupt, bold claim, provocative question, or sudden reaction)
- emotionalReaction (0-20): Visible excitement, passion, vulnerability, shock, laughter, or intensity
- interestingConversation (0-15): Compelling back-and-forth, debate, storytelling, or tension
- humorOrSurprise (0-15): Unexpected twist, punchline, contradiction, or memorable surprise
- educationalValue (0-10): Actionable takeaway, clear insight, or "aha" lesson
- standaloneContext (0-10): Makes complete sense without watching the rest of the full video
- strongEnding (0-10): Lands on a punchy conclusion, cliffhanger, or memorable closing line

For each clip, also provide:
1. Accurate startSeconds and endSeconds (numbers in seconds).
2. A dense, accurate transcript broken into 2 to 4 second subtitle segments inside that clip (with segment startSeconds/endSeconds in absolute video seconds, speaker name/label, exact spoken text, and 1-3 highlightWords from that segment to emphasize in animated captions).
3. speakerCenterX (number between 0.15 and 0.85, where 0.5 is center, 0.25 is left speaker, 0.75 is right speaker) so a 9:16 vertical crop stays centered on the active speaker.
4. primarySpeaker label (e.g. "Host", "Guest", or speaker's name if mentioned).
5. Viral title, punchy openingHook overlay text (3-7 words), general socialCaption, tailored captions for tiktok, youtube_shorts, instagram_reels, and facebook, plus 4-6 relevant hashtags (without # prefix or with # prefix consistently).`;
}

const ANALYSIS_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: {
      type: Type.STRING,
      description: 'Concise 2-sentence overview of the source video.',
    },
    speakersDetected: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'List of speakers identified in the video.',
    },
    clips: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          categoryLabel: {
            type: Type.STRING,
            description:
              'Short 2-3 word label like Unexpected reaction, Funny conversation, Important lesson, Heated debate.',
          },
          startSeconds: { type: Type.NUMBER },
          endSeconds: { type: Type.NUMBER },
          openingHookScore: { type: Type.INTEGER },
          emotionalReactionScore: { type: Type.INTEGER },
          interestingConversationScore: { type: Type.INTEGER },
          humorOrSurpriseScore: { type: Type.INTEGER },
          educationalValueScore: { type: Type.INTEGER },
          standaloneContextScore: { type: Type.INTEGER },
          strongEndingScore: { type: Type.INTEGER },
          whyInteresting: { type: Type.STRING },
          openingHook: { type: Type.STRING },
          socialCaption: { type: Type.STRING },
          tiktokCaption: { type: Type.STRING },
          youtubeShortsCaption: { type: Type.STRING },
          instagramReelsCaption: { type: Type.STRING },
          facebookCaption: { type: Type.STRING },
          hashtags: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          speakerCenterX: { type: Type.NUMBER },
          primarySpeaker: { type: Type.STRING },
          segments: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                startSeconds: { type: Type.NUMBER },
                endSeconds: { type: Type.NUMBER },
                speaker: { type: Type.STRING },
                text: { type: Type.STRING },
                highlightWords: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
              },
              required: ['startSeconds', 'endSeconds', 'speaker', 'text', 'highlightWords'],
            },
          },
        },
        required: [
          'title',
          'categoryLabel',
          'startSeconds',
          'endSeconds',
          'openingHookScore',
          'emotionalReactionScore',
          'interestingConversationScore',
          'humorOrSurpriseScore',
          'educationalValueScore',
          'standaloneContextScore',
          'strongEndingScore',
          'whyInteresting',
          'openingHook',
          'socialCaption',
          'tiktokCaption',
          'youtubeShortsCaption',
          'instagramReelsCaption',
          'facebookCaption',
          'hashtags',
          'speakerCenterX',
          'primarySpeaker',
          'segments',
        ],
      },
    },
  },
  required: ['summary', 'speakersDetected', 'clips'],
};

interface RawAiClip {
  title: string;
  categoryLabel: string;
  startSeconds: number;
  endSeconds: number;
  openingHookScore: number;
  emotionalReactionScore: number;
  interestingConversationScore: number;
  humorOrSurpriseScore: number;
  educationalValueScore: number;
  standaloneContextScore: number;
  strongEndingScore: number;
  whyInteresting: string;
  openingHook: string;
  socialCaption: string;
  tiktokCaption: string;
  youtubeShortsCaption: string;
  instagramReelsCaption: string;
  facebookCaption: string;
  hashtags: string[];
  speakerCenterX: number;
  primarySpeaker: string;
  segments: Array<{
    startSeconds: number;
    endSeconds: number;
    speaker: string;
    text: string;
    highlightWords: string[];
  }>;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function normalizeClipsFromAi(
  rawClips: RawAiClip[],
  settings: ProjectSettings,
  maxDuration?: number
): ClipCandidate[] {
  const mapped = rawClips.map((raw, idx) => {
    const start = Math.max(0, Math.round(raw.startSeconds));
    let end = Math.max(start + 8, Math.round(raw.endSeconds));
    if (maxDuration && maxDuration > 10) {
      end = Math.min(maxDuration, end);
    }
    const duration = Math.max(5, end - start);

    const openingHook = clamp(Math.round(raw.openingHookScore || 14), 0, 20);
    const emotionalReaction = clamp(Math.round(raw.emotionalReactionScore || 14), 0, 20);
    const interestingConversation = clamp(
      Math.round(raw.interestingConversationScore || 11),
      0,
      15
    );
    const humorOrSurprise = clamp(Math.round(raw.humorOrSurpriseScore || 10), 0, 15);
    const educationalValue = clamp(Math.round(raw.educationalValueScore || 7), 0, 10);
    const standaloneContext = clamp(Math.round(raw.standaloneContextScore || 7), 0, 10);
    const strongEnding = clamp(Math.round(raw.strongEndingScore || 7), 0, 10);
    const total =
      openingHook +
      emotionalReaction +
      interestingConversation +
      humorOrSurprise +
      educationalValue +
      standaloneContext +
      strongEnding;

    const segments: TranscriptSegment[] = (raw.segments || []).map((seg, sIdx) => {
      const segStart = clamp(Number(seg.startSeconds) || start, start, end - 0.5);
      const segEnd = clamp(Number(seg.endSeconds) || segStart + 2.5, segStart + 0.4, end);
      return {
        id: `seg_${idx + 1}_${sIdx + 1}`,
        startSeconds: Number(segStart.toFixed(2)),
        endSeconds: Number(segEnd.toFixed(2)),
        speaker: seg.speaker || raw.primarySpeaker || 'Speaker 1',
        text: (seg.text || '').trim(),
        highlightWords: Array.isArray(seg.highlightWords) ? seg.highlightWords : [],
      };
    });

    return {
      id: `clip_${Date.now()}_${idx + 1}`,
      index: idx + 1,
      title: raw.title || `Viral Clip ${idx + 1}`,
      categoryLabel: raw.categoryLabel || 'Viral Moment',
      startSeconds: start,
      endSeconds: end,
      durationSeconds: duration,
      score: {
        openingHook,
        emotionalReaction,
        interestingConversation,
        humorOrSurprise,
        educationalValue,
        standaloneContext,
        strongEnding,
        total,
      },
      whyInteresting: raw.whyInteresting || 'High retention opening and strong payoff.',
      openingHook: raw.openingHook || raw.title || 'Watch what happens next',
      socialCaption: raw.socialCaption || raw.title,
      platformCaptions: {
        tiktok: raw.tiktokCaption || raw.socialCaption || raw.title,
        youtube_shorts: raw.youtubeShortsCaption || raw.socialCaption || raw.title,
        instagram_reels: raw.instagramReelsCaption || raw.socialCaption || raw.title,
        facebook: raw.facebookCaption || raw.socialCaption || raw.title,
      },
      hashtags: (raw.hashtags || ['shorts', 'viral', 'clips']).map((h) =>
        h.startsWith('#') ? h : `#${h.replace(/\s+/g, '')}`
      ),
      speakerCenterX: clamp(Number(raw.speakerCenterX ?? 0.5), 0.1, 0.9),
      primarySpeaker: raw.primarySpeaker || 'Speaker 1',
      selected: settings.clippingMode === 'auto' ? idx < Math.min(5, settings.maxClips) : idx < 3,
      showHookBanner: settings.addHookOverlay,
      subtitleStyle: settings.subtitleStyle,
      outputFormat: settings.outputFormat,
      addBackgroundMusic: settings.addBackgroundMusic,
      segments,
      renderStatus: 'idle' as const,
    };
  });

  mapped.sort((a, b) => b.score.total - a.score.total);
  return mapped.map((c, i) => ({ ...c, index: i + 1 }));
}

function parseTokenLimitError(err: unknown): {
  isTokenLimit: boolean;
  inputTokens?: number;
  maxTokens?: number;
} {
  const raw = err instanceof Error ? err.message : String(err);
  if (!/maximum number of tokens allowed|input token count/i.test(raw)) {
    return { isTokenLimit: false };
  }
  const maxMatch = raw.match(/tokens allowed \((\d+)\)/i);
  const inputMatch = raw.match(/input token count:\s*(\d+)/i);
  return {
    isTokenLimit: true,
    maxTokens: maxMatch ? Number(maxMatch[1]) : 1048576,
    inputTokens: inputMatch ? Number(inputMatch[1]) : undefined,
  };
}

function formatGeminiErrorMessage(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string; code?: number; status?: string };
    };
    if (parsed?.error?.message) {
      return parsed.error.message;
    }
  } catch {
    // Check if an embedded JSON error string exists inside the SDK message
    const jsonStart = raw.indexOf('{');
    if (jsonStart >= 0) {
      try {
        const parsed = JSON.parse(raw.slice(jsonStart)) as {
          error?: { message?: string };
        };
        if (parsed?.error?.message) {
          return parsed.error.message;
        }
      } catch {
        // Not valid JSON
      }
    }
  }
  return raw || fallback;
}

interface ParsedAnalysisResult {
  summary: string;
  speakersDetected: string[];
  clips: RawAiClip[];
}

function offsetWindowClips(
  clips: RawAiClip[],
  windowStart: number,
  windowEnd: number
): RawAiClip[] {
  const windowDur = Math.max(10, windowEnd - windowStart);
  return clips.map((clip) => {
    // If Gemini returned timestamps relative to the segment [0..windowDur], shift by windowStart
    const looksRelative =
      windowStart > 0 && clip.endSeconds <= windowDur + 15 && clip.startSeconds < windowStart;
    const shift = looksRelative ? windowStart : 0;
    return {
      ...clip,
      startSeconds: clip.startSeconds + shift,
      endSeconds: clip.endSeconds + shift,
      segments: (clip.segments || []).map((seg) => ({
        ...seg,
        startSeconds: seg.startSeconds + shift,
        endSeconds: seg.endSeconds + shift,
      })),
    };
  });
}

function rankRawClip(c: RawAiClip): number {
  return (
    (c.openingHookScore || 0) +
    (c.emotionalReactionScore || 0) +
    (c.interestingConversationScore || 0) +
    (c.humorOrSurpriseScore || 0) +
    (c.educationalValueScore || 0) +
    (c.standaloneContextScore || 0) +
    (c.strongEndingScore || 0)
  );
}

async function analyzeMediaWithTokenBudget(params: {
  ai: GoogleGenAI;
  model: string | undefined;
  fileUri: string;
  mimeType?: string;
  settings: ProjectSettings;
  durationSeconds?: number;
  onProgress: (stageMessage: string, progress?: number) => void;
}): Promise<ParsedAnalysisResult> {
  const { ai, model, fileUri, mimeType, settings, durationSeconds, onProgress } = params;

  const runWindow = async (opts: {
    lowRes: boolean;
    fps?: number;
    startSeconds?: number;
    endSeconds?: number;
    clipCountOverride?: number;
  }): Promise<ParsedAnalysisResult> => {
    const windowInfo =
      typeof opts.startSeconds === 'number' && typeof opts.endSeconds === 'number'
        ? {
            startSeconds: opts.startSeconds,
            endSeconds: opts.endSeconds,
            clipCountOverride: opts.clipCountOverride,
          }
        : undefined;

    const prompt = buildAnalysisPrompt(settings, durationSeconds, windowInfo);
    const videoMetadata: {
      startOffset?: string;
      endOffset?: string;
      fps?: number;
    } = {};

    if (typeof opts.fps === 'number') {
      videoMetadata.fps = opts.fps;
    }
    if (windowInfo) {
      videoMetadata.startOffset = `${Math.max(0, Math.floor(windowInfo.startSeconds))}s`;
      videoMetadata.endOffset = `${Math.max(
        Math.floor(windowInfo.startSeconds) + 10,
        Math.ceil(windowInfo.endSeconds)
      )}s`;
    }

    const filePart: {
      fileData: { fileUri: string; mimeType?: string };
      videoMetadata?: { startOffset?: string; endOffset?: string; fps?: number };
    } = {
      fileData: mimeType ? { fileUri, mimeType } : { fileUri },
    };
    if (Object.keys(videoMetadata).length > 0) {
      filePart.videoMetadata = videoMetadata;
    }

    const response = await generateContentWithFallback(ai, model, {
      contents: [filePart, { text: prompt }],
      config: {
        ...(opts.lowRes ? { mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW } : {}),
        responseMimeType: 'application/json',
        responseSchema: ANALYSIS_RESPONSE_SCHEMA,
      },
    });

    const parsed = parseModelJson<{
      summary?: string;
      speakersDetected?: string[];
      clips?: RawAiClip[];
    }>(response.text);

    const rawClips = Array.isArray(parsed.clips) ? parsed.clips : [];
    const adjustedClips = windowInfo
      ? offsetWindowClips(rawClips, windowInfo.startSeconds, windowInfo.endSeconds)
      : rawClips;

    return {
      summary: parsed.summary || 'Analysis complete.',
      speakersDetected: Array.isArray(parsed.speakersDetected)
        ? parsed.speakersDetected
        : ['Speaker 1'],
      clips: adjustedClips,
    };
  };

  const runChunkedAnalysis = async (totalDuration: number): Promise<ParsedAnalysisResult> => {
    // 40-minute windows at low resolution + 0.5 fps use ~150k tokens each, well within 1M cap
    const windowSize = 2400;
    const maxWindows = 6;
    const windows: Array<{ start: number; end: number }> = [];

    if (totalDuration <= windowSize * maxWindows) {
      for (let start = 0; start < totalDuration; start += windowSize) {
        const end = Math.min(totalDuration, start + windowSize);
        if (end - start >= 30 || windows.length === 0) {
          windows.push({ start, end });
        }
      }
    } else {
      const step = Math.floor(totalDuration / maxWindows);
      for (let i = 0; i < maxWindows; i++) {
        const start = i * step;
        const end = Math.min(totalDuration, start + windowSize);
        windows.push({ start, end });
      }
    }

    const perWindowClipTarget = Math.max(
      2,
      Math.ceil(Math.min(12, Math.max(4, settings.maxClips)) / windows.length) + 1
    );

    const summaries: string[] = [];
    const speakerSet = new Set<string>();
    const allClips: RawAiClip[] = [];
    let lastChunkError: unknown;

    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      const startMin = Math.round(w.start / 60);
      const endMin = Math.round(w.end / 60);
      onProgress(
        `Long-video mode: analyzing segment ${i + 1}/${windows.length} (${startMin}m–${endMin}m) within Gemini token budget...`,
        Math.min(82, 52 + Math.round(((i + 1) / windows.length) * 28))
      );

      try {
        const res = await runWindow({
          lowRes: true,
          fps: 0.5,
          startSeconds: w.start,
          endSeconds: w.end,
          clipCountOverride: perWindowClipTarget,
        });
        if (res.summary) summaries.push(res.summary);
        for (const sp of res.speakersDetected) speakerSet.add(sp);
        allClips.push(...res.clips);
      } catch (chunkErr) {
        lastChunkError = chunkErr;
        const tokenErr = parseTokenLimitError(chunkErr);
        if (tokenErr.isTokenLimit) {
          try {
            // Retry single window at even lower FPS (0.25 fps = 1 frame every 4s)
            const res = await runWindow({
              lowRes: true,
              fps: 0.25,
              startSeconds: w.start,
              endSeconds: w.end,
              clipCountOverride: perWindowClipTarget,
            });
            if (res.summary) summaries.push(res.summary);
            for (const sp of res.speakersDetected) speakerSet.add(sp);
            allClips.push(...res.clips);
          } catch (retryErr) {
            lastChunkError = retryErr;
            if (windows.length === 1) throw retryErr;
          }
        } else if (windows.length === 1) {
          throw chunkErr;
        }
      }
    }

    if (allClips.length === 0 && lastChunkError) {
      throw lastChunkError;
    }

    allClips.sort((a, b) => rankRawClip(b) - rankRawClip(a));
    const maxWanted = Math.min(12, Math.max(4, settings.maxClips));
    return {
      summary: summaries[0] || 'Long-form video analysis complete.',
      speakersDetected: speakerSet.size > 0 ? Array.from(speakerSet) : ['Speaker 1'],
      clips: allClips.slice(0, maxWanted),
    };
  };

  // Proactive budget choice when duration is already known (uploaded files)
  if (durationSeconds && durationSeconds > 7200) {
    return runChunkedAnalysis(durationSeconds);
  }
  if (durationSeconds && durationSeconds > 2400) {
    onProgress(
      'Long video detected (>40 min). Optimizing frame sampling to fit Gemini context window...',
      58
    );
    try {
      return await runWindow({ lowRes: true, fps: 0.5 });
    } catch (err) {
      if (parseTokenLimitError(err).isTokenLimit) {
        return runChunkedAnalysis(durationSeconds);
      }
      throw err;
    }
  }

  // Standard single-pass attempt (with automatic recovery on 1M token overflow)
  try {
    return await runWindow({ lowRes: false });
  } catch (err) {
    const tokenInfo = parseTokenLimitError(err);
    if (!tokenInfo.isTokenLimit) {
      throw err;
    }

    const tokenLabel = tokenInfo.inputTokens
      ? `${tokenInfo.inputTokens.toLocaleString()} tokens`
      : '>1M tokens';
    onProgress(
      `Video requires ${tokenLabel} at full resolution. Switching to token-optimized sampling...`,
      56
    );

    try {
      return await runWindow({ lowRes: true, fps: 0.5 });
    } catch (lowResErr) {
      const lowTokenInfo = parseTokenLimitError(lowResErr);
      if (!lowTokenInfo.isTokenLimit) {
        throw lowResErr;
      }

      // Ultra-long stream (>3.5+ hours): split into 40-minute windows
      const estimatedSeconds =
        durationSeconds ||
        (lowTokenInfo.inputTokens
          ? Math.max(7200, Math.round(lowTokenInfo.inputTokens / 60))
          : tokenInfo.inputTokens
          ? Math.max(7200, Math.round(tokenInfo.inputTokens / 290))
          : 10800);

      return runChunkedAnalysis(estimatedSeconds);
    }
  }
}

async function runYoutubeAnalysisPipeline(projectId: string): Promise<void> {
  const projects = readProjects();
  const project = projects.find((p) => p.id === projectId);
  if (!project || !project.youtubeUrl) return;

  const appSettings = readSettings();
  try {
    updateProjectInStore(projectId, (p) => ({
      ...p,
      analysisStage: 'analyzing_video',
      analysisProgress: 25,
      analysisMessage: 'Connecting YouTube video stream to Gemini multimodal understanding...',
    }));

    const ai = createGeminiClient();

    updateProjectInStore(projectId, (p) => ({
      ...p,
      analysisStage: 'transcribing_speech',
      analysisProgress: 52,
      analysisMessage: 'Detecting speakers, speech timestamps, hooks, and emotional peaks...',
    }));

    const parsed = await analyzeMediaWithTokenBudget({
      ai,
      model: appSettings.geminiModel,
      fileUri: project.youtubeUrl,
      settings: project.settings,
      onProgress: (msg, progress) => {
        updateProjectInStore(projectId, (p) => ({
          ...p,
          analysisProgress: progress ?? p.analysisProgress,
          analysisMessage: msg,
        }));
      },
    });

    updateProjectInStore(projectId, (p) => ({
      ...p,
      analysisStage: 'scoring_moments',
      analysisProgress: 84,
      analysisMessage: 'Scoring viral candidates across the 7-factor retention rubric...',
    }));

    const rawClips = Array.isArray(parsed.clips) ? parsed.clips : [];
    if (rawClips.length === 0) {
      throw new Error(
        'Gemini did not return any clip candidates for this YouTube URL. Ensure the video is public and has spoken audio.'
      );
    }

    const clips = normalizeClipsFromAi(rawClips, project.settings).map((clip) => ({
      ...clip,
      thumbnailUrl: project.thumbnailUrl,
    }));

    const maxEnd = Math.max(...clips.map((c) => c.endSeconds), 60);

    updateProjectInStore(projectId, (p) => ({
      ...p,
      status: 'completed',
      analysisStage: 'completed',
      analysisProgress: 100,
      analysisMessage: `Detected ${clips.length} viral clip candidates.`,
      summary: parsed.summary || 'Analysis complete.',
      speakersDetected: parsed.speakersDetected || ['Speaker 1'],
      videoDurationSeconds: p.videoDurationSeconds || maxEnd,
      clips,
    }));
  } catch (err) {
    const message = formatGeminiErrorMessage(
      err,
      'Failed to analyze YouTube URL with Gemini.'
    );
    updateProjectInStore(projectId, (p) => ({
      ...p,
      status: 'failed',
      analysisStage: 'failed',
      analysisProgress: 0,
      analysisMessage: message,
      errorMessage: message,
    }));
  }
}

async function runUploadAnalysisPipeline(
  projectId: string,
  filePath: string,
  mimeType: string
): Promise<void> {
  const projects = readProjects();
  const project = projects.find((p) => p.id === projectId);
  if (!project) return;

  const appSettings = readSettings();
  let uploadedRemoteName: string | undefined;
  let aiClient: GoogleGenAI | undefined;

  try {
    updateProjectInStore(projectId, (p) => ({
      ...p,
      analysisStage: 'probing_media',
      analysisProgress: 12,
      analysisMessage: 'Probing video resolution, frame rate, and audio streams via FFprobe...',
    }));

    const mediaInfo = await probeMedia(filePath);
    const coverThumb = await extractThumbnailFrame(
      filePath,
      Math.min(2, Math.floor(mediaInfo.durationSeconds / 4)),
      `${projectId}_cover.jpg`
    );

    updateProjectInStore(projectId, (p) => ({
      ...p,
      videoDurationSeconds: mediaInfo.durationSeconds,
      videoWidth: mediaInfo.width,
      videoHeight: mediaInfo.height,
      hasAudioStream: mediaInfo.hasAudio,
      thumbnailUrl: coverThumb || p.thumbnailUrl,
      analysisStage: 'uploading_to_ai',
      analysisProgress: 28,
      analysisMessage: 'Uploading media stream to Gemini File API for multimodal inspection...',
    }));

    aiClient = createGeminiClient();
    const uploaded = await aiClient.files.upload({
      file: filePath,
      config: { mimeType },
    });
    uploadedRemoteName = uploaded.name;

    let fileState = uploaded.state;
    let fileUri = uploaded.uri;
    let pollAttempts = 0;
    while (fileState === 'PROCESSING' && pollAttempts < 40 && uploadedRemoteName) {
      await new Promise((r) => setTimeout(r, 2500));
      const check = await aiClient.files.get({ name: uploadedRemoteName });
      fileState = check.state;
      fileUri = check.uri;
      pollAttempts += 1;
      updateProjectInStore(projectId, (p) => ({
        ...p,
        analysisProgress: Math.min(48, 30 + pollAttempts),
        analysisMessage: 'Indexing video frames and audio track for Gemini analysis...',
      }));
    }

    if (fileState === 'FAILED' || !fileUri) {
      throw new Error('Gemini File API failed to index the uploaded video.');
    }

    updateProjectInStore(projectId, (p) => ({
      ...p,
      analysisStage: 'analyzing_video',
      analysisProgress: 56,
      analysisMessage: 'Analyzing scenes, speaker positions, emotional peaks, and hooks...',
    }));

    const parsed = await analyzeMediaWithTokenBudget({
      ai: aiClient,
      model: appSettings.geminiModel,
      fileUri,
      mimeType,
      settings: project.settings,
      durationSeconds: mediaInfo.durationSeconds,
      onProgress: (msg, progress) => {
        updateProjectInStore(projectId, (p) => ({
          ...p,
          analysisProgress: progress ?? p.analysisProgress,
          analysisMessage: msg,
        }));
      },
    });

    updateProjectInStore(projectId, (p) => ({
      ...p,
      analysisStage: 'scoring_moments',
      analysisProgress: 82,
      analysisMessage: 'Scoring viral candidates and aligning animated caption timestamps...',
    }));

    const rawClips = Array.isArray(parsed.clips) ? parsed.clips : [];
    if (rawClips.length === 0) {
      throw new Error('Gemini did not detect any clip candidates in the uploaded video.');
    }

    const clips = normalizeClipsFromAi(
      rawClips,
      project.settings,
      mediaInfo.durationSeconds
    );

    updateProjectInStore(projectId, (p) => ({
      ...p,
      analysisStage: 'extracting_thumbnails',
      analysisProgress: 92,
      analysisMessage: 'Extracting frame previews for detected clips via FFmpeg...',
    }));

    for (const clip of clips) {
      const midPoint = Math.round((clip.startSeconds + clip.endSeconds) / 2);
      const thumb = await extractThumbnailFrame(
        filePath,
        midPoint,
        `${projectId}_${clip.id}.jpg`
      );
      if (thumb) {
        clip.thumbnailUrl = thumb;
      }
    }

    updateProjectInStore(projectId, (p) => ({
      ...p,
      status: 'completed',
      analysisStage: 'completed',
      analysisProgress: 100,
      analysisMessage: `Detected ${clips.length} viral clip candidates ready for editing and FFmpeg export.`,
      summary: parsed.summary || 'Analysis complete.',
      speakersDetected: parsed.speakersDetected || ['Speaker 1'],
      clips,
    }));
  } catch (err) {
    const message = formatGeminiErrorMessage(
      err,
      'Failed to analyze uploaded video.'
    );
    updateProjectInStore(projectId, (p) => ({
      ...p,
      status: 'failed',
      analysisStage: 'failed',
      analysisProgress: 0,
      analysisMessage: message,
      errorMessage: message,
    }));
  } finally {
    if (aiClient && uploadedRemoteName) {
      aiClient.files.delete({ name: uploadedRemoteName }).catch(() => {});
    }
  }
}

function hexToAssBgr(hex: string): string {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return '&H000B9EF5&';
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H00${b}${g}${r}&`.toUpperCase();
}

function formatAssTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const cs = Math.floor((s % 1) * 100);
  return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(
    cs
  ).padStart(2, '0')}`;
}

function formatSrtTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 1000);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(
    secs
  ).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function escapeAssText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\n/g, '\\N');
}

function buildAssContent(
  clip: ClipCandidate,
  appSettings: AppSettings,
  width: number,
  height: number
): string {
  const fontSize = clamp(appSettings.subtitleFontSize || 54, 28, 86);
  const minDim = Math.min(width, height);
  const scaleFactor = minDim > 0 ? minDim / 1080 : 1;
  const scaledFont = Math.max(18, Math.round(fontSize * scaleFactor));
  const hookFont = Math.max(16, Math.round(scaledFont * 0.78));
  const watermarkFont = Math.max(16, Math.round(28 * scaleFactor));
  const marginH = Math.max(32, Math.round(60 * scaleFactor));
  const hookMarginH = Math.max(36, Math.round(70 * scaleFactor));
  const watermarkMargin = Math.max(20, Math.round(40 * scaleFactor));

  let accentBgr = hexToAssBgr(appSettings.subtitleAccentColor || '#F59E0B');
  if (clip.subtitleStyle === 'kinetic_blue') accentBgr = '&H00F6823B&';
  if (clip.subtitleStyle === 'karaoke_gold') accentBgr = '&H000B9EF5&';

  const borderStyle = clip.subtitleStyle === 'clean_minimal' ? 3 : 1;
  const outlineWidth = Math.max(
    2,
    Math.round((clip.subtitleStyle === 'clean_minimal' ? 10 : 4) * scaleFactor)
  );
  const shadow =
    clip.subtitleStyle === 'clean_minimal' ? 0 : Math.max(1, Math.round(2 * scaleFactor));
  const alignment =
    appSettings.subtitlePosition === 'center'
      ? 5
      : appSettings.subtitlePosition === 'bottom'
      ? 2
      : 2;
  const marginV =
    appSettings.subtitlePosition === 'center'
      ? 0
      : appSettings.subtitlePosition === 'bottom'
      ? Math.round(height * 0.08)
      : Math.round(height * 0.18);

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,${scaledFont},&H00FFFFFF&,${accentBgr},&H00080A0F&,&H96000000&,-1,0,0,0,100,100,0,0,${borderStyle},${outlineWidth},${shadow},${alignment},${marginH},${marginH},${marginV},1
Style: HookBanner,DejaVu Sans,${hookFont},&H00FFFFFF&,&H00FFFFFF&,&H00080A0F&,&HC8111827&,-1,0,0,0,100,100,0,0,3,${Math.max(
    8,
    Math.round(14 * scaleFactor)
  )},0,8,${hookMarginH},${hookMarginH},${Math.round(height * 0.1)},1
Style: Watermark,DejaVu Sans,${watermarkFont},&H88E5E7EB&,&H88E5E7EB&,&H88000000&,&H00000000&,0,0,0,0,100,100,1,0,1,${Math.max(
    1,
    Math.round(2 * scaleFactor)
  )},0,9,${watermarkMargin},${watermarkMargin},${watermarkMargin},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines: string[] = [];

  if (clip.showHookBanner && clip.openingHook.trim()) {
    const hookEnd = Math.min(4.2, clip.durationSeconds);
    lines.push(
      `Dialogue: 1,${formatAssTime(0)},${formatAssTime(
        hookEnd
      )},HookBanner,,0,0,0,,${escapeAssText(clip.openingHook.trim())}`
    );
  }

  if (appSettings.showWatermark && appSettings.brandWatermark.trim()) {
    lines.push(
      `Dialogue: 2,${formatAssTime(0)},${formatAssTime(
        clip.durationSeconds
      )},Watermark,,0,0,0,,${escapeAssText(appSettings.brandWatermark.trim())}`
    );
  }

  for (const seg of clip.segments) {
    const relStart = Math.max(0, seg.startSeconds - clip.startSeconds);
    const relEnd = Math.min(clip.durationSeconds, seg.endSeconds - clip.startSeconds);
    if (relEnd <= relStart) continue;

    let displayText = seg.text.trim();
    if (appSettings.subtitleUppercase) {
      displayText = displayText.toUpperCase();
    }

    const words = displayText.split(/\s+/).filter(Boolean);
    const highlights = new Set(
      (seg.highlightWords || []).map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ''))
    );

    const styledWords = words.map((word) => {
      const normalized = word.toLowerCase().replace(/[^a-z0-9]/g, '');
      const escaped = escapeAssText(word);
      if (highlights.has(normalized)) {
        return `{\\c${accentBgr}\\b1}${escaped}{\\c&H00FFFFFF&}`;
      }
      return escaped;
    });

    lines.push(
      `Dialogue: 0,${formatAssTime(relStart)},${formatAssTime(
        relEnd
      )},Default,,0,0,0,,${styledWords.join(' ')}`
    );
  }

  return header + lines.join('\n') + '\n';
}

type ExportQualityMode = 'best' | 'high_1080p';

function normalizeQualityMode(raw: unknown): ExportQualityMode {
  return raw === 'high_1080p' ? 'high_1080p' : 'best';
}

function roundEven(n: number): number {
  return Math.max(2, Math.round(n) & ~1);
}

function getOutputDimensions(
  format: AspectRatioFormat,
  srcW = 1920,
  srcH = 1080,
  quality: ExportQualityMode = 'best'
): { width: number; height: number } {
  if (quality === 'high_1080p') {
    if (format === '16:9') return { width: 1920, height: 1080 };
    if (format === '1:1') return { width: 1080, height: 1080 };
    return { width: 1080, height: 1920 };
  }

  // Best Quality: preserve high-res 1440p / 4K source detail without downscaling
  if (format === '16:9') {
    if (srcW >= 3840 || srcH >= 2160) return { width: 3840, height: 2160 };
    if (srcW >= 2560 || srcH >= 1440) return { width: 2560, height: 1440 };
    return { width: 1920, height: 1080 };
  }

  if (format === '1:1') {
    const minSrc = Math.min(srcW, srcH);
    if (minSrc >= 2160) return { width: 2160, height: 2160 };
    if (minSrc >= 1440) return { width: 1440, height: 1440 };
    return { width: 1080, height: 1080 };
  }

  // 9:16 vertical: preserve native 4K vertical (2160x3840) or 4K-height landscape crop (1216x2160)
  if (srcW >= 2160 && srcH >= 3840) {
    return { width: 2160, height: 3840 };
  }
  if (srcH >= 2160) {
    return { width: roundEven((2160 * 9) / 16), height: 2160 };
  }
  return { width: 1080, height: 1920 };
}

async function renderClipWithFfmpeg(
  project: Project,
  clip: ClipCandidate,
  appSettings: AppSettings,
  quality: ExportQualityMode = 'best'
): Promise<string> {
  if (!project.localVideoFilename) {
    throw new Error(
      'No local source video file is attached to this project. Upload the authorized source video in the Clip Editor or New Project to export MP4 clips.'
    );
  }
  const sourcePath = path.join(UPLOADS_DIR, project.localVideoFilename);
  if (!fs.existsSync(sourcePath)) {
    throw new Error('Source video file was not found on disk.');
  }

  const outFilename = `${project.id}_${clip.id}_${clip.outputFormat.replace(':', 'x')}_${quality}.mp4`;
  const outPath = path.join(EXPORTS_DIR, outFilename);
  const assFilename = `tmp_${project.id}_${clip.id}.ass`;
  const assPath = path.join(EXPORTS_DIR, assFilename);

  let srcW = project.videoWidth || 1920;
  let srcH = project.videoHeight || 1080;
  let hasAudioStream = project.hasAudioStream;
  try {
    const probed = await probeMedia(sourcePath);
    if (probed.width > 0 && probed.height > 0) {
      srcW = probed.width;
      srcH = probed.height;
    }
    hasAudioStream = probed.hasAudio;
  } catch {
    // Fall back to stored project metadata if probe fails
  }
  const { width: outW, height: outH } = getOutputDimensions(
    clip.outputFormat,
    srcW,
    srcH,
    quality
  );
  const assContent = buildAssContent(clip, appSettings, outW, outH);
  fs.writeFileSync(assPath, assContent, 'utf-8');

  const targetRatio = outW / outH;
  const srcRatio = srcW / srcH;
  const scaleFlags = 'flags=lanczos+accurate_rnd+full_chroma_int';

  let cropFilter = '';
  if (srcRatio > targetRatio + 0.02) {
    // Source is wider than target (e.g. 16:9 -> 9:16): crop horizontally around speakerCenterX
    const cropW = Math.max(64, Math.floor(srcH * targetRatio) & ~1);
    const maxOffset = Math.max(0, srcW - cropW);
    const centerPx = Math.round(clip.speakerCenterX * srcW);
    const xOffset = clamp(Math.round(centerPx - cropW / 2), 0, maxOffset);
    cropFilter = `crop=${cropW}:${srcH}:${xOffset}:0,scale=${outW}:${outH}:${scaleFlags}`;
  } else if (srcRatio < targetRatio - 0.02) {
    // Source is taller than target (e.g. 9:16 -> 16:9): scale and pad cleanly
    cropFilter = `scale=${outW}:${outH}:force_original_aspect_ratio=decrease:${scaleFlags},pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:color=#0B0D12`;
  } else {
    cropFilter = `scale=${outW}:${outH}:${scaleFlags}`;
  }

  const relativeAssPath = path.relative(ROOT_DIR, assPath).replace(/\\/g, '/').replace(/:/g, '\\:');
  const vfChain = `${cropFilter},ass=${relativeAssPath}`;
  const clipDur = Math.max(3, clip.endSeconds - clip.startSeconds);

  const args: string[] = [
    '-y',
    '-ss',
    String(clip.startSeconds),
    '-t',
    String(clipDur),
    '-i',
    sourcePath,
  ];

  if (clip.addBackgroundMusic) {
    // Subtle warm ambient pulse synthesized via FFmpeg aevalsrc at low background ducking volume
    args.push(
      '-f',
      'lavfi',
      '-t',
      String(clipDur),
      '-i',
      `aevalsrc=0.035*sin(2*PI*110*t)+0.02*sin(2*PI*164.81*t)*(0.5+0.5*sin(2*PI*0.5*t)):s=48000`
    );
  }

  if (clip.addBackgroundMusic) {
    if (hasAudioStream !== false) {
      args.push(
        '-filter_complex',
        `[0:v]${vfChain}[vout];[0:a]volume=1.0[va];[1:a]volume=0.22[bg];[va][bg]amix=inputs=2:duration=shortest[aout]`,
        '-map',
        '[vout]',
        '-map',
        '[aout]'
      );
    } else {
      args.push(
        '-filter_complex',
        `[0:v]${vfChain}[vout]`,
        '-map',
        '[vout]',
        '-map',
        '1:a:0'
      );
    }
  } else {
    args.push('-vf', vfChain, '-map', '0:v:0');
    if (hasAudioStream !== false) {
      args.push('-map', '0:a?');
    }
  }

  const isBest = quality === 'best';
  const h264Level = outW * outH > 1920 * 1080 ? '5.1' : '4.2';
  args.push(
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-level:v',
    h264Level,
    '-preset',
    isBest ? 'medium' : 'fast',
    '-crf',
    isBest ? '15' : '18',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    isBest ? '320k' : '256k',
    '-ar',
    '48000',
    '-movflags',
    '+faststart',
    outPath
  );

  try {
    await execFileAsync('ffmpeg', args, { maxBuffer: 1024 * 1024 * 32 });
  } finally {
    if (fs.existsSync(assPath)) {
      fs.unlinkSync(assPath);
    }
  }

  return `/exports/${outFilename}?v=${Date.now()}`;
}

function getExportFilePathForClip(
  projectId: string,
  clip: ClipCandidate,
  preferredQuality?: ExportQualityMode
): string | null {
  const formatTag = clip.outputFormat.replace(':', 'x');
  if (preferredQuality) {
    const qualityPath = path.join(
      EXPORTS_DIR,
      `${projectId}_${clip.id}_${formatTag}_${preferredQuality}.mp4`
    );
    if (fs.existsSync(qualityPath)) return qualityPath;
    return null;
  }

  if (clip.renderedVideoUrl) {
    const cleanFile = path.basename(clip.renderedVideoUrl.split('?')[0]);
    if (cleanFile) {
      const candidate = path.join(EXPORTS_DIR, cleanFile);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  const bestCanonical = path.join(EXPORTS_DIR, `${projectId}_${clip.id}_${formatTag}_best.mp4`);
  if (fs.existsSync(bestCanonical)) return bestCanonical;
  const legacyCanonical = path.join(EXPORTS_DIR, `${projectId}_${clip.id}_${formatTag}.mp4`);
  return fs.existsSync(legacyCanonical) ? legacyCanonical : null;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, `vid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
});

async function startServer() {
  recoverInterruptedProjects();
  autoConnectEnvironment();

  const app = express();
  app.set('trust proxy', true);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const explicitOrigins = (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    if (explicitOrigins.length === 0) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
    } else if (origin && explicitOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-ClipGenius-Mp4-Count');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '10mb' }));

  app.use('/uploads', express.static(UPLOADS_DIR));
  app.use('/uploads', (_req, res) => {
    res.status(404).json({
      error: 'Source video file is not on server disk. Re-attach the video file to render clips.',
    });
  });
  app.use('/exports', express.static(EXPORTS_DIR));
  app.use('/exports', (_req, res) => {
    res.status(404).json({
      error: 'Rendered clip MP4 was not found on disk. Click Render & Download MP4 to generate it.',
    });
  });
  app.use('/thumbnails', express.static(THUMBNAILS_DIR));
  app.use('/thumbnails', (_req, res) => {
    res.status(404).json({ error: 'Thumbnail not found.' });
  });

  const buildHealthPayload = async (req: express.Request) => {
    let ffmpegAvailable = false;
    let ffprobeAvailable = false;
    try {
      await execFileAsync('ffmpeg', ['-version']);
      ffmpegAvailable = true;
    } catch {
      ffmpegAvailable = false;
    }
    try {
      await execFileAsync('ffprobe', ['-version']);
      ffprobeAvailable = true;
    } catch {
      ffprobeAvailable = false;
    }
    let storageWritable = false;
    try {
      fs.accessSync(DATA_DIR, fs.constants.W_OK);
      storageWritable = true;
    } catch {
      storageWritable = false;
    }

    const envReport = autoConnectEnvironment(req);

    return {
      ok: true,
      ffmpegAvailable,
      ffprobeAvailable,
      storageWritable,
      hasGeminiKey: envReport.envStatus.geminiApiKey,
      environment: process.env.NODE_ENV || 'development',
      resolvedAppUrl: envReport.resolvedAppUrl,
      appUrlSource: envReport.appUrlSource,
      allowedOriginsList: envReport.allowedOriginsList,
      allowedOriginsMode: envReport.allowedOriginsMode,
      firebase: envReport.firebase,
      oauthCallbacks: envReport.oauthCallbacks,
      envStatus: envReport.envStatus,
    };
  };

  app.get('/api/health', async (req, res) => {
    res.json(await buildHealthPayload(req));
  });

  app.get('/api/env/auto-connect', async (req, res) => {
    res.json(await buildHealthPayload(req));
  });

  app.post('/api/env/auto-connect', async (req, res) => {
    res.json(await buildHealthPayload(req));
  });

  app.get('/api/settings', (_req, res) => {
    res.json({ settings: readSettings() });
  });

  app.put('/api/settings', (req, res) => {
    const current = readSettings();
    const next: AppSettings = { ...current, ...(req.body || {}) };
    writeSettings(next);
    res.json({ settings: next });
  });

  app.get('/api/projects', (_req, res) => {
    res.json({ projects: readProjects() });
  });

  app.post('/api/projects/sync', (req, res) => {
    const incoming = (req.body as { project?: Project })?.project;
    if (!incoming || !incoming.id || !incoming.title) {
      res.status(400).json({ error: 'Valid project payload is required.' });
      return;
    }

    const existing = readProjects().find((p) => p.id === incoming.id);
    if (existing) {
      res.json({ project: existing });
      return;
    }

    const hasSourceOnDisk = Boolean(
      incoming.localVideoFilename &&
        fs.existsSync(path.join(UPLOADS_DIR, path.basename(incoming.localVideoFilename)))
    );

    const sanitized: Project = {
      ...incoming,
      localVideoFilename: hasSourceOnDisk ? incoming.localVideoFilename : undefined,
      localVideoUrl: hasSourceOnDisk ? incoming.localVideoUrl : undefined,
      clips: (incoming.clips || []).map((c) => {
        const exportPath = getExportFilePathForClip(incoming.id, c);
        if (exportPath) {
          return {
            ...c,
            renderStatus: 'completed',
            renderedVideoUrl: `/exports/${path.basename(exportPath)}`,
            renderError: undefined,
          };
        }
        return c.renderStatus === 'completed'
          ? { ...c, renderStatus: 'idle', renderedVideoUrl: undefined }
          : c;
      }),
    };

    upsertProject(sanitized);
    res.json({ project: sanitized });
  });

  app.get('/api/projects/:id', (req, res) => {
    const project = readProjects().find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    res.json({ project });
  });

  app.delete('/api/projects/:id', (req, res) => {
    const projects = readProjects();
    const target = projects.find((p) => p.id === req.params.id);
    if (!target) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    if (target.localVideoFilename) {
      const p = path.join(UPLOADS_DIR, target.localVideoFilename);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    writeProjects(projects.filter((p) => p.id !== req.params.id));
    res.json({ ok: true });
  });

  app.post('/api/projects/youtube', async (req, res) => {
    try {
      const { youtubeUrl, settings } = req.body as {
        youtubeUrl?: string;
        settings?: ProjectSettings;
      };
      if (!youtubeUrl || typeof youtubeUrl !== 'string') {
        res.status(400).json({ error: 'Please provide a valid YouTube URL.' });
        return;
      }

      const videoId = extractYoutubeId(youtubeUrl);
      if (!videoId) {
        res.status(400).json({
          error: 'Could not parse a valid YouTube video ID from that URL.',
        });
        return;
      }

      const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const meta = await fetchYoutubeMetadata(canonicalUrl, videoId);
      const appSettings = readSettings();

      const mergedSettings: ProjectSettings = {
        durationPreset: settings?.durationPreset || appSettings.defaultDurationPreset,
        customMinSeconds: settings?.customMinSeconds || 20,
        customMaxSeconds: settings?.customMaxSeconds || 45,
        outputFormat: settings?.outputFormat || appSettings.defaultOutputFormat,
        clippingMode: settings?.clippingMode || appSettings.defaultClippingMode,
        targetPlatforms: settings?.targetPlatforms || appSettings.defaultPlatforms,
        maxClips: settings?.maxClips || 6,
        subtitleStyle: settings?.subtitleStyle || appSettings.defaultSubtitleStyle,
        autoFaceTrack: settings?.autoFaceTrack ?? true,
        deduplicateClips: settings?.deduplicateClips ?? true,
        addHookOverlay: settings?.addHookOverlay ?? true,
        addBackgroundMusic: settings?.addBackgroundMusic ?? false,
      };

      const project: Project = {
        id: `proj_${Date.now()}`,
        title: meta.title,
        channelOrAuthor: meta.author,
        sourceType: 'youtube',
        youtubeUrl: canonicalUrl,
        youtubeVideoId: videoId,
        thumbnailUrl: meta.thumbnailUrl,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'processing',
        analysisStage: 'queued',
        analysisProgress: 8,
        analysisMessage: 'Preparing Gemini YouTube video analysis...',
        settings: mergedSettings,
        clips: [],
      };

      upsertProject(project);
      runYoutubeAnalysisPipeline(project.id).catch((err) => {
        console.error('YouTube pipeline error:', err);
      });

      res.status(201).json({ project });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to create YouTube project.',
      });
    }
  });

  app.post('/api/projects/upload', upload.single('video'), async (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No video file was uploaded.' });
        return;
      }

      let parsedSettings: Partial<ProjectSettings> = {};
      if (req.body.settings) {
        try {
          parsedSettings = JSON.parse(req.body.settings);
        } catch {
          parsedSettings = {};
        }
      }

      const appSettings = readSettings();
      const mergedSettings: ProjectSettings = {
        durationPreset: parsedSettings.durationPreset || appSettings.defaultDurationPreset,
        customMinSeconds: parsedSettings.customMinSeconds || 20,
        customMaxSeconds: parsedSettings.customMaxSeconds || 45,
        outputFormat: parsedSettings.outputFormat || appSettings.defaultOutputFormat,
        clippingMode: parsedSettings.clippingMode || appSettings.defaultClippingMode,
        targetPlatforms: parsedSettings.targetPlatforms || appSettings.defaultPlatforms,
        maxClips: parsedSettings.maxClips || 6,
        subtitleStyle: parsedSettings.subtitleStyle || appSettings.defaultSubtitleStyle,
        autoFaceTrack: parsedSettings.autoFaceTrack ?? true,
        deduplicateClips: parsedSettings.deduplicateClips ?? true,
        addHookOverlay: parsedSettings.addHookOverlay ?? true,
        addBackgroundMusic: parsedSettings.addBackgroundMusic ?? false,
      };

      const rawName = (req.body.title as string) || req.file.originalname.replace(/\.[^/.]+$/, '');
      const project: Project = {
        id: `proj_${Date.now()}`,
        title: rawName || 'Uploaded Studio Video',
        channelOrAuthor: 'Local Studio Source',
        sourceType: 'upload',
        localVideoFilename: req.file.filename,
        localVideoUrl: `/uploads/${req.file.filename}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'processing',
        analysisStage: 'queued',
        analysisProgress: 5,
        analysisMessage: 'File uploaded. Starting FFprobe media inspection...',
        settings: mergedSettings,
        clips: [],
      };

      upsertProject(project);
      runUploadAnalysisPipeline(
        project.id,
        req.file.path,
        req.file.mimetype || 'video/mp4'
      ).catch((err) => {
        console.error('Upload pipeline error:', err);
      });

      res.status(201).json({ project });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to upload video.',
      });
    }
  });

  app.post('/api/projects/:id/attach-video', upload.single('video'), async (req, res) => {
    try {
      const existing = readProjects().find((p) => p.id === req.params.id);
      if (!existing) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: 'No video file provided.' });
        return;
      }

      const mediaInfo = await probeMedia(req.file.path);
      const updatedClips = [...existing.clips];
      for (const clip of updatedClips) {
        const midPoint = Math.round((clip.startSeconds + clip.endSeconds) / 2);
        const thumb = await extractThumbnailFrame(
          req.file.path,
          midPoint,
          `${existing.id}_${clip.id}.jpg`
        );
        if (thumb) clip.thumbnailUrl = thumb;
      }

      const updated = updateProjectInStore(existing.id, (p) => ({
        ...p,
        localVideoFilename: req.file!.filename,
        localVideoUrl: `/uploads/${req.file!.filename}`,
        videoDurationSeconds: mediaInfo.durationSeconds,
        videoWidth: mediaInfo.width,
        videoHeight: mediaInfo.height,
        hasAudioStream: mediaInfo.hasAudio,
        clips: updatedClips,
      }));

      res.json({ project: updated });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to attach source video.',
      });
    }
  });

  app.post('/api/projects/:id/retry', (req, res) => {
    const project = readProjects().find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }

    const updated = updateProjectInStore(project.id, (p) => ({
      ...p,
      status: 'processing',
      analysisStage: 'queued',
      analysisProgress: 8,
      analysisMessage: 'Retrying Gemini viral moment analysis...',
      errorMessage: undefined,
    }));

    if (project.sourceType === 'youtube' && project.youtubeUrl) {
      runYoutubeAnalysisPipeline(project.id).catch((err) => {
        console.error('Retry YouTube pipeline error:', err);
      });
    } else if (project.localVideoFilename) {
      const filePath = path.join(UPLOADS_DIR, project.localVideoFilename);
      if (!fs.existsSync(filePath)) {
        res.status(400).json({ error: 'Uploaded video file is no longer on disk.' });
        return;
      }
      runUploadAnalysisPipeline(project.id, filePath, 'video/mp4').catch((err) => {
        console.error('Retry Upload pipeline error:', err);
      });
    } else {
      res.status(400).json({ error: 'No source video or YouTube URL available to retry.' });
      return;
    }

    res.json({ project: updated });
  });

  app.post('/api/projects/:id/clips', async (req, res) => {
    try {
      const project = readProjects().find((p) => p.id === req.params.id);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }

      const { title, startSeconds, endSeconds } = req.body as {
        title?: string;
        startSeconds?: number;
        endSeconds?: number;
      };
      const start = Math.max(0, Math.round(Number(startSeconds ?? 0)));
      const end = Math.max(start + 5, Math.round(Number(endSeconds ?? start + 30)));
      const duration = end - start;

      const clipId = `clip_manual_${Date.now()}`;
      let thumbnailUrl = project.thumbnailUrl;
      if (project.localVideoFilename) {
        const videoPath = path.join(UPLOADS_DIR, project.localVideoFilename);
        if (fs.existsSync(videoPath)) {
          const thumb = await extractThumbnailFrame(
            videoPath,
            Math.round((start + end) / 2),
            `${project.id}_${clipId}.jpg`
          );
          if (thumb) thumbnailUrl = thumb;
        }
      }

      const cleanTitle = (title || '').trim() || `Manual Clip (${start}s – ${end}s)`;
      const newClip: ClipCandidate = {
        id: clipId,
        index: project.clips.length + 1,
        title: cleanTitle,
        categoryLabel: 'Manual Selection',
        startSeconds: start,
        endSeconds: end,
        durationSeconds: duration,
        score: {
          openingHook: 15,
          emotionalReaction: 15,
          interestingConversation: 12,
          humorOrSurprise: 10,
          educationalValue: 8,
          standaloneContext: 8,
          strongEnding: 8,
          total: 76,
        },
        whyInteresting: 'Manually selected custom timestamp range.',
        openingHook: cleanTitle,
        socialCaption: cleanTitle,
        platformCaptions: {
          tiktok: cleanTitle,
          youtube_shorts: cleanTitle,
          instagram_reels: cleanTitle,
          facebook: cleanTitle,
        },
        hashtags: ['#shorts', '#viral', '#clips'],
        speakerCenterX: 0.5,
        primarySpeaker: project.speakersDetected?.[0] || 'Speaker 1',
        selected: true,
        showHookBanner: project.settings.addHookOverlay,
        subtitleStyle: project.settings.subtitleStyle,
        outputFormat: project.settings.outputFormat,
        addBackgroundMusic: project.settings.addBackgroundMusic,
        segments: [
          {
            id: `seg_manual_${Date.now()}`,
            startSeconds: start,
            endSeconds: end,
            speaker: project.speakersDetected?.[0] || 'Speaker 1',
            text: 'Edit this subtitle line in the Clip Editor or regenerate captions.',
            highlightWords: [],
          },
        ],
        thumbnailUrl,
        renderStatus: 'idle',
      };

      const updated = updateProjectInStore(project.id, (p) => ({
        ...p,
        clips: [...p.clips, newClip],
      }));

      res.status(201).json({ project: updated, clip: newClip });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to create manual clip.',
      });
    }
  });

  app.patch('/api/projects/:id/clips/:clipId', (req, res) => {
    const patch = req.body as Partial<ClipCandidate>;
    const updated = updateProjectInStore(req.params.id, (project) => {
      const clips = project.clips.map((c) => {
        if (c.id !== req.params.clipId) return c;
        const nextStart =
          typeof patch.startSeconds === 'number'
            ? Math.max(0, patch.startSeconds)
            : c.startSeconds;
        const nextEnd =
          typeof patch.endSeconds === 'number'
            ? Math.max(nextStart + 3, patch.endSeconds)
            : c.endSeconds;
        const nextApproved =
          typeof patch.approved === 'boolean' ? patch.approved : c.approved;
        const nextApprovedAt =
          patch.approved === true
            ? patch.approvedAt || c.approvedAt || new Date().toISOString()
            : patch.approved === false
            ? undefined
            : c.approvedAt;
        return {
          ...c,
          ...patch,
          approved: nextApproved,
          approvedAt: nextApprovedAt,
          startSeconds: nextStart,
          endSeconds: nextEnd,
          durationSeconds: Math.round(nextEnd - nextStart),
        };
      });
      return { ...project, clips };
    });

    if (!updated) {
      res.status(404).json({ error: 'Project or clip not found.' });
      return;
    }
    const clip = updated.clips.find((c) => c.id === req.params.clipId);
    res.json({ project: updated, clip });
  });

  app.post('/api/projects/:id/clips/:clipId/regenerate-copy', async (req, res) => {
    try {
      const project = readProjects().find((p) => p.id === req.params.id);
      const clip = project?.clips.find((c) => c.id === req.params.clipId);
      if (!project || !clip) {
        res.status(404).json({ error: 'Project or clip not found.' });
        return;
      }

      const ai = createGeminiClient();
      const appSettings = readSettings();
      const transcriptText = clip.segments.map((s) => `${s.speaker}: ${s.text}`).join('\n');

      const response = await generateContentWithFallback(
        ai,
        appSettings.geminiModel,
        {
          contents: `Rewrite the viral packaging for this short video clip to maximize retention and click-through across TikTok, YouTube Shorts, Instagram Reels, and Facebook.
Current Title: ${clip.title}
Context / Why Interesting: ${clip.whyInteresting}
Transcript:
${transcriptText}`,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                openingHook: { type: Type.STRING },
                socialCaption: { type: Type.STRING },
                tiktokCaption: { type: Type.STRING },
                youtubeShortsCaption: { type: Type.STRING },
                instagramReelsCaption: { type: Type.STRING },
                facebookCaption: { type: Type.STRING },
                hashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
              },
              required: [
                'title',
                'openingHook',
                'socialCaption',
                'tiktokCaption',
                'youtubeShortsCaption',
                'instagramReelsCaption',
                'facebookCaption',
                'hashtags',
              ],
            },
          },
        }
      );

      const generated = parseModelJson<{
        title: string;
        openingHook: string;
        socialCaption: string;
        tiktokCaption: string;
        youtubeShortsCaption: string;
        instagramReelsCaption: string;
        facebookCaption: string;
        hashtags: string[];
      }>(response.text);

      const updated = updateProjectInStore(project.id, (p) => ({
        ...p,
        clips: p.clips.map((c) =>
          c.id === clip.id
            ? {
                ...c,
                title: generated.title || c.title,
                openingHook: generated.openingHook || c.openingHook,
                socialCaption: generated.socialCaption || c.socialCaption,
                platformCaptions: {
                  tiktok: generated.tiktokCaption || c.platformCaptions.tiktok,
                  youtube_shorts:
                    generated.youtubeShortsCaption || c.platformCaptions.youtube_shorts,
                  instagram_reels:
                    generated.instagramReelsCaption || c.platformCaptions.instagram_reels,
                  facebook: generated.facebookCaption || c.platformCaptions.facebook,
                },
                hashtags: (generated.hashtags || c.hashtags).map((h) =>
                  h.startsWith('#') ? h : `#${h.replace(/\s+/g, '')}`
                ),
              }
            : c
        ),
      }));

      res.json({
        project: updated,
        clip: updated?.clips.find((c) => c.id === clip.id),
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to regenerate viral copy.',
      });
    }
  });

  const buildClipDownloadFilename = (clip: { index: number; title: string }): string => {
    const safeTitle = (clip.title || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    return `clip-${String(clip.index).padStart(2, '0')}-${safeTitle || 'clipgenius'}.mp4`;
  };

  app.post('/api/projects/:id/clips/:clipId/render', async (req, res) => {
    const project = readProjects().find((p) => p.id === req.params.id);
    const clip = project?.clips.find((c) => c.id === req.params.clipId);
    if (!project || !clip) {
      res.status(404).json({ error: 'Project or clip not found.' });
      return;
    }

    const quality = normalizeQualityMode(req.query.quality || (req.body as { quality?: string })?.quality);
    const skipIfExists = req.query.skipIfExists === 'true' || req.query.skipIfExists === '1';
    const filename = buildClipDownloadFilename(clip);
    const downloadUrl = `/api/projects/${project.id}/clips/${clip.id}/download?quality=${encodeURIComponent(
      quality
    )}`;

    if (skipIfExists) {
      const existingPath = getExportFilePathForClip(project.id, clip, quality);
      if (existingPath && fs.existsSync(existingPath)) {
        const renderedVideoUrl = `/exports/${path.basename(existingPath)}`;
        const fileSizeBytes = fs.statSync(existingPath).size;
        const updated =
          clip.renderStatus === 'completed' && clip.renderedVideoUrl === renderedVideoUrl
            ? project
            : updateProjectInStore(project.id, (p) => ({
                ...p,
                clips: p.clips.map((c) =>
                  c.id === clip.id
                    ? { ...c, renderStatus: 'completed', renderedVideoUrl, renderError: undefined }
                    : c
                ),
              })) || project;
        res.json({
          project: updated,
          clip: updated.clips.find((c) => c.id === clip.id),
          downloadUrl,
          filename,
          fileSizeBytes,
        });
        return;
      }
    }

    updateProjectInStore(project.id, (p) => ({
      ...p,
      clips: p.clips.map((c) =>
        c.id === clip.id ? { ...c, renderStatus: 'rendering', renderError: undefined } : c
      ),
    }));

    try {
      const appSettings = readSettings();
      const renderedVideoUrl = await renderClipWithFfmpeg(project, clip, appSettings, quality);
      const updated = updateProjectInStore(project.id, (p) => ({
        ...p,
        clips: p.clips.map((c) =>
          c.id === clip.id
            ? { ...c, renderStatus: 'completed', renderedVideoUrl, renderError: undefined }
            : c
        ),
      }));
      const cleanFile = path.basename(renderedVideoUrl.split('?')[0]);
      const exportFilePath = path.join(EXPORTS_DIR, cleanFile);
      const fileSizeBytes = fs.existsSync(exportFilePath)
        ? fs.statSync(exportFilePath).size
        : 0;
      res.json({
        project: updated,
        clip: updated?.clips.find((c) => c.id === clip.id),
        downloadUrl,
        filename,
        fileSizeBytes,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'FFmpeg render failed.';
      const updated = updateProjectInStore(project.id, (p) => ({
        ...p,
        clips: p.clips.map((c) =>
          c.id === clip.id ? { ...c, renderStatus: 'failed', renderError: message } : c
        ),
      }));
      res.status(500).json({ error: message, project: updated });
    }
  });

  app.post('/api/projects/:id/render-batch', async (req, res) => {
    const project = readProjects().find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    if (!project.localVideoFilename) {
      res.status(400).json({
        error:
          'This project has no local source video attached yet. Attach an authorized video file first to batch-render MP4s.',
      });
      return;
    }

    const quality = normalizeQualityMode(req.query.quality || (req.body as { quality?: string })?.quality);
    const targets = project.clips.filter((c) => c.selected);
    const appSettings = readSettings();

    for (const clip of targets) {
      updateProjectInStore(project.id, (p) => ({
        ...p,
        clips: p.clips.map((c) =>
          c.id === clip.id ? { ...c, renderStatus: 'rendering', renderError: undefined } : c
        ),
      }));
      try {
        const renderedVideoUrl = await renderClipWithFfmpeg(project, clip, appSettings, quality);
        updateProjectInStore(project.id, (p) => ({
          ...p,
          clips: p.clips.map((c) =>
            c.id === clip.id
              ? { ...c, renderStatus: 'completed', renderedVideoUrl, renderError: undefined }
              : c
          ),
        }));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'FFmpeg render failed.';
        updateProjectInStore(project.id, (p) => ({
          ...p,
          clips: p.clips.map((c) =>
            c.id === clip.id ? { ...c, renderStatus: 'failed', renderError: message } : c
          ),
        }));
      }
    }

    const refreshed = readProjects().find((p) => p.id === project.id);
    res.json({ project: refreshed });
  });

  app.get('/api/projects/:id/clips/:clipId/download', async (req, res) => {
    const project = readProjects().find((p) => p.id === req.params.id);
    const clip = project?.clips.find((c) => c.id === req.params.clipId);
    if (!project || !clip) {
      res.status(404).json({ error: 'Project or clip not found.' });
      return;
    }

    const quality = normalizeQualityMode(req.query.quality);
    let filePath = getExportFilePathForClip(project.id, clip, quality);

    if (!filePath) {
      const sourceExists = Boolean(
        project.localVideoFilename &&
          fs.existsSync(path.join(UPLOADS_DIR, path.basename(project.localVideoFilename)))
      );
      if (!sourceExists) {
        // Fall back to any previously rendered MP4 on disk if source is absent
        filePath = getExportFilePathForClip(project.id, clip);
        if (!filePath) {
          res.status(409).json({
            error:
              'Attach your authorized source video file first so FFmpeg can cut and download this MP4 clip.',
            needsVideoAttach: true,
          });
          return;
        }
      } else {
        updateProjectInStore(project.id, (p) => ({
          ...p,
          clips: p.clips.map((c) =>
            c.id === clip.id ? { ...c, renderStatus: 'rendering', renderError: undefined } : c
          ),
        }));

        try {
          const appSettings = readSettings();
          const renderedVideoUrl = await renderClipWithFfmpeg(project, clip, appSettings, quality);
          updateProjectInStore(project.id, (p) => ({
            ...p,
            clips: p.clips.map((c) =>
              c.id === clip.id
                ? { ...c, renderStatus: 'completed', renderedVideoUrl, renderError: undefined }
                : c
            ),
          }));
          const cleanFile = path.basename(renderedVideoUrl.split('?')[0]);
          filePath = path.join(EXPORTS_DIR, cleanFile);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'FFmpeg render failed.';
          updateProjectInStore(project.id, (p) => ({
            ...p,
            clips: p.clips.map((c) =>
              c.id === clip.id ? { ...c, renderStatus: 'failed', renderError: message } : c
            ),
          }));
          res.status(500).json({ error: message });
          return;
        }
      }
    }

    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Rendered MP4 file could not be located on disk.' });
      return;
    }

    const downloadName = buildClipDownloadFilename(clip);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.sendFile(filePath);
  });

  app.get('/api/projects/:id/clips/:clipId/srt', (req, res) => {
    const project = readProjects().find((p) => p.id === req.params.id);
    const clip = project?.clips.find((c) => c.id === req.params.clipId);
    if (!project || !clip) {
      res.status(404).json({ error: 'Clip not found.' });
      return;
    }

    const srt = clip.segments
      .map((seg, i) => {
        const start = Math.max(0, seg.startSeconds - clip.startSeconds);
        const end = Math.max(start + 0.5, seg.endSeconds - clip.startSeconds);
        return `${i + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${seg.text.trim()}\n`;
      })
      .join('\n');

    const safeTitle = clip.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="clip-${clip.index}-${safeTitle || 'subtitles'}.srt"`
    );
    res.send(srt);
  });

  app.get('/api/projects/:id/export-zip', async (req, res) => {
    let project = readProjects().find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }

    const quality = normalizeQualityMode(req.query.quality);
    const selectedClips = project.clips.filter((c) => c.selected);
    const clipsToExport = selectedClips.length > 0 ? selectedClips : project.clips;
    const hasLocalSource = Boolean(
      project.localVideoFilename &&
        fs.existsSync(path.join(UPLOADS_DIR, path.basename(project.localVideoFilename)))
    );

    if (hasLocalSource) {
      const appSettings = readSettings();
      for (const clip of clipsToExport) {
        if (!getExportFilePathForClip(project.id, clip, quality)) {
          try {
            const renderedVideoUrl = await renderClipWithFfmpeg(project, clip, appSettings, quality);
            const updated = updateProjectInStore(project.id, (p) => ({
              ...p,
              clips: p.clips.map((c) =>
                c.id === clip.id
                  ? { ...c, renderStatus: 'completed', renderedVideoUrl, renderError: undefined }
                  : c
              ),
            }));
            if (updated) project = updated;
          } catch (err) {
            const message = err instanceof Error ? err.message : 'FFmpeg render failed.';
            const updated = updateProjectInStore(project.id, (p) => ({
              ...p,
              clips: p.clips.map((c) =>
                c.id === clip.id ? { ...c, renderStatus: 'failed', renderError: message } : c
              ),
            }));
            if (updated) project = updated;
          }
        }
      }
    }

    const refreshedSelected = project.clips.filter((c) => c.selected);
    const finalClipsToExport =
      refreshedSelected.length > 0 ? refreshedSelected : project.clips;

    const clipEntries = finalClipsToExport.map((clip) => {
      const srt = clip.segments
        .map((seg, i) => {
          const start = Math.max(0, seg.startSeconds - clip.startSeconds);
          const end = Math.max(start + 0.5, seg.endSeconds - clip.startSeconds);
          return `${i + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(
            end
          )}\n${seg.text.trim()}\n`;
        })
        .join('\n');

      const mp4Path =
        getExportFilePathForClip(project!.id, clip, quality) ||
        getExportFilePathForClip(project!.id, clip);

      return { clip, srt, mp4Path };
    });

    const includedMp4Count = clipEntries.filter((entry) => Boolean(entry.mp4Path)).length;

    const safeProjName = project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('X-ClipGenius-Mp4-Count', String(includedMp4Count));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeProjName || 'clipgenius'}-export.zip"`
    );

    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on('error', (err: Error) => {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });
    archive.pipe(res);

    const socialKitLines: string[] = [
      `ClipGenius AI — Export Package`,
      `Project: ${project.title}`,
      `Quality: ${quality === 'best' ? 'Best Quality (Native/4K, CRF 15, 320k AAC)' : '1080p HD (CRF 18, 256k AAC)'}`,
      `MP4 Videos Included: ${includedMp4Count} of ${clipEntries.length}`,
      `Generated: ${new Date().toISOString()}`,
      `==================================================\n`,
    ];

    for (const { clip, srt, mp4Path } of clipEntries) {
      archive.append(srt, { name: `subtitles/clip_${clip.index}.srt` });

      if (mp4Path) {
        archive.file(mp4Path, {
          name: `videos/clip_${clip.index}_${clip.outputFormat.replace(':', 'x')}.mp4`,
        });
      }

      socialKitLines.push(
        `CLIP #${clip.index}: ${clip.title} (${clip.score.total}/100)`,
        `Timestamps: ${clip.startSeconds}s - ${clip.endSeconds}s (${clip.durationSeconds}s)`,
        `Opening Hook: ${clip.openingHook}`,
        `Why Viral: ${clip.whyInteresting}`,
        `TikTok: ${clip.platformCaptions.tiktok}`,
        `YouTube Shorts: ${clip.platformCaptions.youtube_shorts}`,
        `Instagram Reels: ${clip.platformCaptions.instagram_reels}`,
        `Facebook: ${clip.platformCaptions.facebook}`,
        `Hashtags: ${clip.hashtags.join(' ')}`,
        `--------------------------------------------------\n`
      );
    }

    if (includedMp4Count === 0) {
      archive.append(
        [
          'WHERE ARE THE .MP4 VIDEO FILES?',
          '==================================',
          '',
          `Project: ${project.title}`,
          `Source Type: ${project.sourceType}`,
          '',
          'This ZIP package includes your .SRT subtitle files and social_media_kit.txt,',
          'but 0 .MP4 video files were included because no source video file is currently',
          'attached on the ClipGenius server disk for this project.',
          '',
          'HOW TO EXPORT CUT .MP4 VIDEO CLIPS:',
          '1. Open ClipGenius AI -> Export (or Clip Editor).',
          '2. Click "Attach Video File" (or upload your video when creating a New Project).',
          '3. Click "Download MP4" on any clip, or click "Download All Clips (.ZIP)" again.',
          '4. Your .mp4 files will save directly to your browser Downloads folder (and inside videos/ in the ZIP).',
          '',
        ].join('\n'),
        { name: 'README_WHERE_ARE_MP4_FILES.txt' }
      );
    }

    archive.append(socialKitLines.join('\n'), { name: 'social_media_kit.txt' });
    archive.finalize();
  });

  app.get('/api/project/download-zip', (_req, res) => {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="clipgenius-ai-full-project.zip"'
    );

    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on('error', (err: Error) => {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });
    archive.pipe(res);

    const excludedDirs = new Set([
      'node_modules',
      'dist',
      'dev-dist',
      'uploads',
      'exports',
      'data',
      '.git',
      '.aistudio',
    ]);
    const excludedFiles = new Set([
      '.env',
      '.env.local',
      '.env.development.local',
      '.env.production.local',
    ]);

    const addDirectoryToArchive = (currentDir: string, relativePrefix = '') => {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (excludedDirs.has(entry.name)) continue;
          const nextDir = path.join(currentDir, entry.name);
          const nextPrefix = relativePrefix
            ? `${relativePrefix}/${entry.name}`
            : entry.name;
          addDirectoryToArchive(nextDir, nextPrefix);
        } else if (entry.isFile()) {
          if (excludedFiles.has(entry.name) || entry.name.endsWith('.zip')) {
            continue;
          }
          const fullPath = path.join(currentDir, entry.name);
          const zipName = relativePrefix
            ? `${relativePrefix}/${entry.name}`
            : entry.name;
          archive.file(fullPath, { name: zipName });
        }
      }
    };

    try {
      addDirectoryToArchive(ROOT_DIR);
      archive.finalize();
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          error:
            err instanceof Error
              ? err.message
              : 'Failed to create project archive.',
        });
      }
    }
  });

  registerPublishingRoutes(app, {
    dataDir: DATA_DIR,
    exportsDir: EXPORTS_DIR,
    port: PORT,
    readProjects,
    updateProjectInStore,
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  app.use(
    (
      err: unknown,
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (req.path.startsWith('/api')) {
        const status =
          typeof (err as { status?: number })?.status === 'number'
            ? (err as { status: number }).status
            : 500;
        const message =
          err instanceof Error ? err.message : 'Unexpected server error.';
        if (!res.headersSent) {
          res.status(status).json({ error: message });
        }
        return;
      }
      next(err);
    }
  );

  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.join(ROOT_DIR, 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : { server: httpServer },
        ws: { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`ClipGenius AI Studio listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

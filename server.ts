import { GoogleGenAI, Type } from '@google/genai';
import { ZipArchive } from 'archiver';
import { execFile } from 'child_process';
import dotenv from 'dotenv';
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
import { registerPublishingRoutes } from './server/publishing.ts';

dotenv.config();

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
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
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
      'scale=640:-2',
      '-q:v',
      '3',
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

function buildAnalysisPrompt(settings: ProjectSettings, durationHint?: number): string {
  const durationClause = durationHint
    ? `The total video duration is approximately ${durationHint} seconds. Never output timestamps exceeding ${durationHint} seconds.`
    : 'Ensure all timestamps accurately reflect the actual video timeline.';

  return `You are an expert short-form viral video producer and editor for TikTok, YouTube Shorts, Instagram Reels, and Facebook Reels.
Analyze the provided video carefully (visuals, facial expressions, emotional tone, speaker turns, speech content, humor, surprises, and educational insights).
${durationClause}

Select between 4 and ${Math.min(12, Math.max(4, settings.maxClips))} distinct, non-overlapping high-retention viral moments.
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
    const prompt = buildAnalysisPrompt(project.settings);

    updateProjectInStore(projectId, (p) => ({
      ...p,
      analysisStage: 'transcribing_speech',
      analysisProgress: 52,
      analysisMessage: 'Detecting speakers, speech timestamps, hooks, and emotional peaks...',
    }));

    const response = await generateContentWithFallback(
      ai,
      appSettings.geminiModel,
      {
        contents: [
          {
            fileData: {
              fileUri: project.youtubeUrl,
            },
          },
          { text: prompt },
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: ANALYSIS_RESPONSE_SCHEMA,
        },
      }
    );

    updateProjectInStore(projectId, (p) => ({
      ...p,
      analysisStage: 'scoring_moments',
      analysisProgress: 84,
      analysisMessage: 'Scoring viral candidates across the 7-factor retention rubric...',
    }));

    const parsed = parseModelJson<{
      summary?: string;
      speakersDetected?: string[];
      clips?: RawAiClip[];
    }>(response.text);

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
    const message =
      err instanceof Error ? err.message : 'Failed to analyze YouTube URL with Gemini.';
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

    const prompt = buildAnalysisPrompt(project.settings, mediaInfo.durationSeconds);

    const response = await generateContentWithFallback(
      aiClient,
      appSettings.geminiModel,
      {
        contents: [
          {
            fileData: {
              fileUri,
              mimeType,
            },
          },
          { text: prompt },
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: ANALYSIS_RESPONSE_SCHEMA,
        },
      }
    );

    updateProjectInStore(projectId, (p) => ({
      ...p,
      analysisStage: 'scoring_moments',
      analysisProgress: 82,
      analysisMessage: 'Scoring viral candidates and aligning animated caption timestamps...',
    }));

    const parsed = parseModelJson<{
      summary?: string;
      speakersDetected?: string[];
      clips?: RawAiClip[];
    }>(response.text);

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
    const message =
      err instanceof Error ? err.message : 'Failed to analyze uploaded video.';
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
  const scaleFactor = width < 1080 ? width / 1080 : 1;
  const scaledFont = Math.round(fontSize * scaleFactor);
  const hookFont = Math.round(scaledFont * 0.78);

  let accentBgr = hexToAssBgr(appSettings.subtitleAccentColor || '#F59E0B');
  if (clip.subtitleStyle === 'kinetic_blue') accentBgr = '&H00F6823B&';
  if (clip.subtitleStyle === 'karaoke_gold') accentBgr = '&H000B9EF5&';

  const borderStyle = clip.subtitleStyle === 'clean_minimal' ? 3 : 1;
  const outlineWidth = clip.subtitleStyle === 'clean_minimal' ? 10 : 4;
  const shadow = clip.subtitleStyle === 'clean_minimal' ? 0 : 2;
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
Style: Default,DejaVu Sans,${scaledFont},&H00FFFFFF&,${accentBgr},&H00080A0F&,&H96000000&,-1,0,0,0,100,100,0,0,${borderStyle},${outlineWidth},${shadow},${alignment},60,60,${marginV},1
Style: HookBanner,DejaVu Sans,${hookFont},&H00FFFFFF&,&H00FFFFFF&,&H00080A0F&,&HC8111827&,-1,0,0,0,100,100,0,0,3,14,0,8,70,70,${Math.round(
    height * 0.1
  )},1
Style: Watermark,DejaVu Sans,28,&H88E5E7EB&,&H88E5E7EB&,&H88000000&,&H00000000&,0,0,0,0,100,100,1,0,1,2,0,9,40,40,40,1

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

function getOutputDimensions(format: AspectRatioFormat): { width: number; height: number } {
  if (format === '16:9') return { width: 1920, height: 1080 };
  if (format === '1:1') return { width: 1080, height: 1080 };
  return { width: 1080, height: 1920 };
}

async function renderClipWithFfmpeg(
  project: Project,
  clip: ClipCandidate,
  appSettings: AppSettings
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

  const outFilename = `${project.id}_${clip.id}_${clip.outputFormat.replace(':', 'x')}.mp4`;
  const outPath = path.join(EXPORTS_DIR, outFilename);
  const assFilename = `tmp_${project.id}_${clip.id}.ass`;
  const assPath = path.join(EXPORTS_DIR, assFilename);

  const { width: outW, height: outH } = getOutputDimensions(clip.outputFormat);
  const assContent = buildAssContent(clip, appSettings, outW, outH);
  fs.writeFileSync(assPath, assContent, 'utf-8');

  const srcW = project.videoWidth || 1920;
  const srcH = project.videoHeight || 1080;
  const targetRatio = outW / outH;
  const srcRatio = srcW / srcH;

  let cropFilter = '';
  if (srcRatio > targetRatio + 0.02) {
    // Source is wider than target (e.g. 16:9 -> 9:16): crop horizontally around speakerCenterX
    const cropW = Math.max(64, Math.floor(srcH * targetRatio) & ~1);
    const maxOffset = Math.max(0, srcW - cropW);
    const centerPx = Math.round(clip.speakerCenterX * srcW);
    const xOffset = clamp(Math.round(centerPx - cropW / 2), 0, maxOffset);
    cropFilter = `crop=${cropW}:${srcH}:${xOffset}:0,scale=${outW}:${outH}`;
  } else if (srcRatio < targetRatio - 0.02) {
    // Source is taller than target (e.g. 9:16 -> 16:9): scale and pad cleanly
    cropFilter = `scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:color=#0B0D12`;
  } else {
    cropFilter = `scale=${outW}:${outH}`;
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
      `aevalsrc=0.035*sin(2*PI*110*t)+0.02*sin(2*PI*164.81*t)*(0.5+0.5*sin(2*PI*0.5*t)):s=44100`
    );
  }

  if (clip.addBackgroundMusic) {
    if (project.hasAudioStream !== false) {
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
    if (project.hasAudioStream !== false) {
      args.push('-map', '0:a?');
    }
  }

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '22',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    outPath
  );

  try {
    await execFileAsync('ffmpeg', args, { maxBuffer: 1024 * 1024 * 20 });
  } finally {
    if (fs.existsSync(assPath)) {
      fs.unlinkSync(assPath);
    }
  }

  return `/exports/${outFilename}?v=${Date.now()}`;
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

  const app = express();
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (allowedOrigins.length === 0) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
    } else if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '10mb' }));

  app.use('/uploads', express.static(UPLOADS_DIR));
  app.use('/exports', express.static(EXPORTS_DIR));
  app.use('/thumbnails', express.static(THUMBNAILS_DIR));

  app.get('/api/health', async (_req, res) => {
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
    const hasRealEnv = (...names: string[]) =>
      names.some((name) => {
        const val = (process.env[name] || '').trim();
        return Boolean(val && !val.startsWith('MY_'));
      });
    res.json({
      ok: true,
      ffmpegAvailable,
      ffprobeAvailable,
      storageWritable,
      hasGeminiKey: hasRealEnv('GEMINI_API_KEY'),
      environment: process.env.NODE_ENV || 'development',
      envStatus: {
        geminiApiKey: hasRealEnv('GEMINI_API_KEY'),
        appUrl: hasRealEnv('APP_URL'),
        youtubeOAuth:
          hasRealEnv('GOOGLE_CLIENT_ID', 'YOUTUBE_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_ID') &&
          hasRealEnv('GOOGLE_CLIENT_SECRET', 'YOUTUBE_CLIENT_SECRET', 'GOOGLE_OAUTH_CLIENT_SECRET'),
        tiktokOAuth:
          hasRealEnv('TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_ID') &&
          hasRealEnv('TIKTOK_CLIENT_SECRET'),
        instagramOAuth:
          hasRealEnv('META_APP_ID', 'INSTAGRAM_APP_ID', 'FACEBOOK_APP_ID') &&
          hasRealEnv('META_APP_SECRET', 'INSTAGRAM_APP_SECRET', 'FACEBOOK_APP_SECRET'),
        allowedOrigins: hasRealEnv('ALLOWED_ORIGINS'),
      },
    });
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

  app.post('/api/projects/:id/clips/:clipId/render', async (req, res) => {
    const project = readProjects().find((p) => p.id === req.params.id);
    const clip = project?.clips.find((c) => c.id === req.params.clipId);
    if (!project || !clip) {
      res.status(404).json({ error: 'Project or clip not found.' });
      return;
    }

    updateProjectInStore(project.id, (p) => ({
      ...p,
      clips: p.clips.map((c) =>
        c.id === clip.id ? { ...c, renderStatus: 'rendering', renderError: undefined } : c
      ),
    }));

    try {
      const appSettings = readSettings();
      const renderedVideoUrl = await renderClipWithFfmpeg(project, clip, appSettings);
      const updated = updateProjectInStore(project.id, (p) => ({
        ...p,
        clips: p.clips.map((c) =>
          c.id === clip.id
            ? { ...c, renderStatus: 'completed', renderedVideoUrl, renderError: undefined }
            : c
        ),
      }));
      res.json({
        project: updated,
        clip: updated?.clips.find((c) => c.id === clip.id),
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
        const renderedVideoUrl = await renderClipWithFfmpeg(project, clip, appSettings);
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

  app.get('/api/projects/:id/export-zip', (req, res) => {
    const project = readProjects().find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }

    const safeProjName = project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeProjName || 'clipgenius'}-export.zip"`
    );

    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on('error', (err: Error) => {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });
    archive.pipe(res);

    const selectedClips = project.clips.filter((c) => c.selected);
    const clipsToExport = selectedClips.length > 0 ? selectedClips : project.clips;

    const socialKitLines: string[] = [
      `ClipGenius AI — Export Package`,
      `Project: ${project.title}`,
      `Generated: ${new Date().toISOString()}`,
      `==================================================\n`,
    ];

    for (const clip of clipsToExport) {
      const srt = clip.segments
        .map((seg, i) => {
          const start = Math.max(0, seg.startSeconds - clip.startSeconds);
          const end = Math.max(start + 0.5, seg.endSeconds - clip.startSeconds);
          return `${i + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(
            end
          )}\n${seg.text.trim()}\n`;
        })
        .join('\n');
      archive.append(srt, { name: `subtitles/clip_${clip.index}.srt` });

      if (clip.renderedVideoUrl) {
        const cleanFile = clip.renderedVideoUrl.split('?')[0].replace(/^\/exports\//, '');
        const fullPath = path.join(EXPORTS_DIR, cleanFile);
        if (fs.existsSync(fullPath)) {
          archive.file(fullPath, { name: `videos/clip_${clip.index}_${clip.outputFormat.replace(':', 'x')}.mp4` });
        }
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
    const excludedFiles = new Set(['.env']);

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

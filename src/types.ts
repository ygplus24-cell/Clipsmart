export type SourceType = 'youtube' | 'upload';

export type AspectRatioFormat = '9:16' | '16:9' | '1:1';

export type ExportQualityMode = 'best' | 'high_1080p';

export interface ReadyMp4Download {
  clipId: string;
  clipTitle: string;
  url: string;
  filename: string;
  fileSizeBytes?: number;
  quality: ExportQualityMode;
}

export type DurationPreset = '15-30' | '30-60' | '60-90' | 'auto' | 'custom';

export type ClippingMode = 'auto' | 'manual';

export type TargetPlatform =
  | 'tiktok'
  | 'youtube_shorts'
  | 'instagram_reels'
  | 'facebook';

export type SubtitleStylePreset =
  | 'bold_impact'
  | 'clean_minimal'
  | 'karaoke_gold'
  | 'kinetic_blue';

export interface ViralScoreBreakdown {
  openingHook: number; // 0-20
  emotionalReaction: number; // 0-20
  interestingConversation: number; // 0-15
  humorOrSurprise: number; // 0-15
  educationalValue: number; // 0-10
  standaloneContext: number; // 0-10
  strongEnding: number; // 0-10
  total: number; // 0-100
}

export interface TranscriptSegment {
  id: string;
  startSeconds: number;
  endSeconds: number;
  speaker: string;
  text: string;
  highlightWords: string[];
}

export interface PlatformCaptions {
  tiktok: string;
  youtube_shorts: string;
  instagram_reels: string;
  facebook: string;
}

export interface ClipCandidate {
  id: string;
  index: number;
  title: string;
  categoryLabel: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  score: ViralScoreBreakdown;
  whyInteresting: string;
  openingHook: string;
  socialCaption: string;
  platformCaptions: PlatformCaptions;
  hashtags: string[];
  speakerCenterX: number; // 0.0 (left) to 1.0 (right)
  primarySpeaker: string;
  selected: boolean;
  showHookBanner: boolean;
  subtitleStyle: SubtitleStylePreset;
  outputFormat: AspectRatioFormat;
  addBackgroundMusic: boolean;
  segments: TranscriptSegment[];
  thumbnailUrl?: string;
  renderStatus: 'idle' | 'rendering' | 'completed' | 'failed';
  renderedVideoUrl?: string;
  renderError?: string;
  approved?: boolean;
  approvedAt?: string;
}

export interface ProjectSettings {
  durationPreset: DurationPreset;
  customMinSeconds: number;
  customMaxSeconds: number;
  outputFormat: AspectRatioFormat;
  clippingMode: ClippingMode;
  targetPlatforms: TargetPlatform[];
  maxClips: number;
  subtitleStyle: SubtitleStylePreset;
  autoFaceTrack: boolean;
  deduplicateClips: boolean;
  addHookOverlay: boolean;
  addBackgroundMusic: boolean;
}

export interface AppSettings {
  defaultDurationPreset: DurationPreset;
  defaultOutputFormat: AspectRatioFormat;
  defaultClippingMode: ClippingMode;
  defaultPlatforms: TargetPlatform[];
  defaultSubtitleStyle: SubtitleStylePreset;
  subtitleFontSize: number;
  subtitleAccentColor: string;
  subtitlePosition: 'bottom' | 'center' | 'lower_third';
  subtitleUppercase: boolean;
  brandWatermark: string;
  showWatermark: boolean;
  geminiModel: 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';
}

export type AnalysisStage =
  | 'queued'
  | 'probing_media'
  | 'uploading_to_ai'
  | 'analyzing_video'
  | 'transcribing_speech'
  | 'scoring_moments'
  | 'extracting_thumbnails'
  | 'completed'
  | 'failed';

export interface Project {
  id: string;
  title: string;
  channelOrAuthor?: string;
  sourceType: SourceType;
  youtubeUrl?: string;
  youtubeVideoId?: string;
  localVideoFilename?: string;
  localVideoUrl?: string;
  thumbnailUrl?: string;
  videoDurationSeconds?: number;
  videoWidth?: number;
  videoHeight?: number;
  hasAudioStream?: boolean;
  createdAt: string;
  updatedAt: string;
  status: 'processing' | 'completed' | 'failed';
  analysisStage: AnalysisStage;
  analysisProgress: number;
  analysisMessage: string;
  errorMessage?: string;
  settings: ProjectSettings;
  clips: ClipCandidate[];
  summary?: string;
  speakersDetected?: string[];
}

export type PublishPlatform = 'youtube_shorts' | 'tiktok' | 'instagram_reels';

export type ConnectionStatus =
  | 'not_configured'
  | 'disconnected'
  | 'connected'
  | 'expired'
  | 'error';

export interface PlatformConnectionInfo {
  platform: PublishPlatform;
  label: string;
  configured: boolean;
  status: ConnectionStatus;
  accountName?: string;
  accountHandle?: string;
  accountId?: string;
  connectedAt?: string;
  expiresAt?: string;
  lastError?: string;
  redirectUri: string;
  requirementsNote: string;
}

export type PublishTargetStatus =
  | 'pending'
  | 'scheduled'
  | 'uploading'
  | 'processing'
  | 'published'
  | 'failed'
  | 'auth_expired';

export type PublishPrivacy = 'public' | 'unlisted' | 'private';

export interface PublishTargetSpec {
  platform: PublishPlatform;
  enabled: boolean;
  title: string;
  caption: string;
  hashtags: string[];
  privacy: PublishPrivacy;
  scheduleMode: 'now' | 'scheduled';
  scheduledAt?: string;
  status: PublishTargetStatus;
  progress: number;
  publishedUrl?: string;
  remotePostId?: string;
  errorMessage?: string;
  updatedAt: string;
}

export interface PublishJob {
  id: string;
  projectId: string;
  projectTitle: string;
  clipId: string;
  clipTitle: string;
  clipThumbnailUrl?: string;
  renderedVideoUrl?: string;
  approvedAt: string;
  createdAt: string;
  updatedAt: string;
  targets: Record<PublishPlatform, PublishTargetSpec>;
}

export interface PublishNotification {
  id: string;
  type: 'error' | 'auth_expired' | 'success' | 'info';
  platform?: PublishPlatform;
  jobId?: string;
  title: string;
  message: string;
  createdAt: string;
  read: boolean;
}

export type AppView =
  | 'dashboard'
  | 'new-project'
  | 'analysis'
  | 'editor'
  | 'export'
  | 'publish'
  | 'settings';

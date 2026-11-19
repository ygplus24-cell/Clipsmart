import type { TargetPlatform } from '../types';

export function formatTimecode(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(
    secs
  ).padStart(2, '0')}`;
}

export function formatShortTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function formatDurationLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

export function formatDateShort(isoString: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(isoString));
  } catch {
    return isoString;
  }
}

export function getScoreTierText(score: number): {
  label: string;
  colorClass: string;
} {
  if (score >= 85) {
    return { label: 'High Viral Potential', colorClass: 'text-emerald-400' };
  }
  if (score >= 70) {
    return { label: 'Strong Candidate', colorClass: 'text-amber-400' };
  }
  return { label: 'Standard Clip', colorClass: 'text-gray-400' };
}

export function formatPlatformName(p: TargetPlatform): string {
  switch (p) {
    case 'tiktok':
      return 'TikTok';
    case 'youtube_shorts':
      return 'YouTube Shorts';
    case 'instagram_reels':
      return 'Instagram Reels';
    case 'facebook':
      return 'Facebook';
  }
}

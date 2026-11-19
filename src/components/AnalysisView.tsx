import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  CheckSquare,
  Download,
  Film,
  Loader2,
  Plus,
  RefreshCw,
  Sliders,
  Square,
} from 'lucide-react';
import type { ClipCandidate, Project } from '../types';
import { apiUrl } from '../utils/api';
import {
  formatDurationLabel,
  formatTimecode,
  getScoreTierText,
} from '../utils/formatters';

interface AnalysisViewProps {
  project: Project | null;
  onOpenEditor: (clipId: string) => void;
  onGoToExport: () => void;
  onCreateNew: () => void;
  onRetryProject: (projectId: string) => Promise<void>;
  onCreateManualClip: (
    title: string,
    startSeconds: number,
    endSeconds: number
  ) => Promise<void>;
  onToggleClipSelection: (clipId: string, selected: boolean) => void;
  onSelectBatchPreset: (mode: 'top5' | 'all' | 'none') => void;
}

const PIPELINE_STEPS = [
  { key: 'probing_media', label: 'Media Inspection' },
  { key: 'uploading_to_ai', label: 'AI Stream Indexing' },
  { key: 'analyzing_video', label: 'Multimodal Video Understanding' },
  { key: 'transcribing_speech', label: 'Speech & Speaker Detection' },
  { key: 'scoring_moments', label: '7-Factor Viral Scoring' },
  { key: 'extracting_thumbnails', label: 'Frame Preview Extraction' },
];

export const AnalysisView: React.FC<AnalysisViewProps> = ({
  project,
  onOpenEditor,
  onGoToExport,
  onCreateNew,
  onRetryProject,
  onCreateManualClip,
  onToggleClipSelection,
  onSelectBatchPreset,
}) => {
  const [sortBy, setSortBy] = useState<'score' | 'timeline' | 'duration'>('score');
  const [expandedClipId, setExpandedClipId] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualTitle, setManualTitle] = useState('');
  const [manualStart, setManualStart] = useState(0);
  const [manualEnd, setManualEnd] = useState(30);
  const [addingManual, setAddingManual] = useState(false);

  const sortedClips = useMemo(() => {
    if (!project) return [];
    const copy = [...project.clips];
    if (sortBy === 'score') {
      copy.sort((a, b) => b.score.total - a.score.total);
    } else if (sortBy === 'timeline') {
      copy.sort((a, b) => a.startSeconds - b.startSeconds);
    } else {
      copy.sort((a, b) => b.durationSeconds - a.durationSeconds);
    }
    return copy;
  }, [project, sortBy]);

  if (!project) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/12 bg-[#12151C] px-6 py-16 text-center">
        <Film className="h-10 w-10 text-gray-500" />
        <h2 className="mt-4 text-lg font-semibold text-white">No Active Project Selected</h2>
        <p className="mt-1.5 max-w-md text-sm text-gray-400">
          Start a new YouTube or video upload project to inspect detected viral moments and
          7-factor scoring breakdowns.
        </p>
        <button
          type="button"
          onClick={onCreateNew}
          className="mt-5 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500"
        >
          Start New Project
        </button>
      </div>
    );
  }

  if (project.status === 'processing') {
    const activeIdx = PIPELINE_STEPS.findIndex((s) => s.key === project.analysisStage);
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="rounded-xl border border-white/8 bg-[#12151C] p-6 sm:p-8">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-medium text-blue-400">AI Analysis In Progress</p>
              <h1 className="mt-1 truncate text-xl font-bold text-white">{project.title}</h1>
            </div>
            <div className="flex items-center gap-2 font-mono text-lg font-semibold text-white tabular-nums shrink-0">
              <Loader2 className="h-5 w-5 animate-spin text-blue-400" />
              <span>{project.analysisProgress}%</span>
            </div>
          </div>

          <div className="mt-5 h-2 w-full overflow-hidden rounded-full bg-white/8">
            <div
              className="h-full bg-blue-500 transition-all duration-300"
              style={{ width: `${Math.max(5, project.analysisProgress)}%` }}
            />
          </div>

          <p className="mt-3 text-sm text-gray-300">{project.analysisMessage}</p>

          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {PIPELINE_STEPS.map((step, i) => {
              const isDone = activeIdx > i || project.analysisProgress >= 95;
              const isCurrent = activeIdx === i;
              return (
                <div
                  key={step.key}
                  className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-sm ${
                    isCurrent
                      ? 'border-blue-500/40 bg-blue-500/10 text-white'
                      : isDone
                      ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-300'
                      : 'border-white/6 bg-[#0B0D12] text-gray-500'
                  }`}
                >
                  {isDone ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                  ) : isCurrent ? (
                    <Loader2 className="h-4 w-4 animate-spin text-blue-400 shrink-0" />
                  ) : (
                    <div className="h-4 w-4 rounded-full border border-current shrink-0" />
                  )}
                  <span className="truncate">{step.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  if (project.status === 'failed') {
    return (
      <div className="mx-auto max-w-2xl rounded-xl border border-rose-500/30 bg-[#12151C] p-6 sm:p-8">
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 h-6 w-6 text-rose-400 shrink-0" />
          <div>
            <h1 className="text-lg font-bold text-white">Analysis Failed</h1>
            <p className="mt-1 text-sm text-gray-300">{project.title}</p>
            <p className="mt-3 rounded-lg border border-rose-500/20 bg-rose-950/30 p-3 text-sm text-rose-200">
              {project.errorMessage || project.analysisMessage}
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={retrying}
                onClick={async () => {
                  setRetrying(true);
                  try {
                    await onRetryProject(project.id);
                  } finally {
                    setRetrying(false);
                  }
                }}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {retrying ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                <span>Retry Analysis</span>
              </button>
              <button
                type="button"
                onClick={onCreateNew}
                className="rounded-lg border border-white/12 bg-[#171B24] px-4 py-2 text-sm font-medium text-gray-200 hover:bg-[#202634]"
              >
                Try Another Video
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const selectedCount = project.clips.filter((c) => c.selected).length;

  return (
    <div className="space-y-6">
      {/* Project Header */}
      <div className="flex flex-col gap-4 rounded-xl border border-white/8 bg-[#12151C] p-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
            <span>{project.sourceType === 'youtube' ? 'YouTube Analysis' : 'Studio Upload'}</span>
            <span aria-hidden="true">·</span>
            <span>{project.channelOrAuthor || 'Creator'}</span>
            {project.speakersDetected && project.speakersDetected.length > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span>Speakers: {project.speakersDetected.join(', ')}</span>
              </>
            )}
          </div>
          <h1 className="mt-1.5 text-xl font-bold text-white [text-wrap:balance]">
            {project.title}
          </h1>
          {project.summary && (
            <p className="mt-2 max-w-3xl text-sm text-gray-400">{project.summary}</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => setShowManualForm((s) => !s)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 bg-[#171B24] px-3.5 py-2.5 text-sm font-medium text-gray-200 hover:bg-[#202634] whitespace-nowrap shrink-0"
          >
            <Plus className="h-4 w-4 text-blue-400" />
            <span>Add Manual Clip</span>
          </button>
          <button
            type="button"
            onClick={onGoToExport}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 whitespace-nowrap shrink-0"
          >
            <Download className="h-4 w-4" />
            <span>Export Selected ({selectedCount})</span>
          </button>
        </div>
      </div>

      {showManualForm && (
        <div className="rounded-xl border border-blue-500/30 bg-[#12151C] p-5">
          <h2 className="text-sm font-semibold text-white">Create Custom Manual Clip</h2>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-4 items-end">
            <div className="sm:col-span-2">
              <label className="block text-xs text-gray-400">Clip Title</label>
              <input
                type="text"
                value={manualTitle}
                onChange={(e) => setManualTitle(e.target.value)}
                placeholder="Custom highlight moment"
                className="mt-1 w-full rounded-lg border border-white/10 bg-[#0B0D12] px-3 py-2 text-xs text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400">Start (sec)</label>
              <input
                type="number"
                min={0}
                value={manualStart}
                onChange={(e) => setManualStart(Number(e.target.value) || 0)}
                className="mt-1 w-full rounded-lg border border-white/10 bg-[#0B0D12] px-3 py-2 font-mono text-xs text-white tabular-nums"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400">End (sec)</label>
              <input
                type="number"
                min={manualStart + 5}
                value={manualEnd}
                onChange={(e) => setManualEnd(Number(e.target.value) || manualStart + 30)}
                className="mt-1 w-full rounded-lg border border-white/10 bg-[#0B0D12] px-3 py-2 font-mono text-xs text-white tabular-nums"
              />
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowManualForm(false)}
              className="rounded-lg px-3 py-1.5 text-xs text-gray-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={addingManual}
              onClick={async () => {
                setAddingManual(true);
                try {
                  await onCreateManualClip(manualTitle, manualStart, manualEnd);
                  setManualTitle('');
                  setShowManualForm(false);
                } finally {
                  setAddingManual(false);
                }
              }}
              className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {addingManual ? 'Adding...' : 'Add Clip'}
            </button>
          </div>
        </div>
      )}

      {/* Controls Strip */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-gray-300">
            {project.clips.length} Viral Candidates
          </span>
          <span className="text-gray-600" aria-hidden="true">
            ·
          </span>
          <button
            type="button"
            onClick={() => onSelectBatchPreset('top5')}
            className="text-xs font-medium text-blue-400 hover:text-blue-300 whitespace-nowrap"
          >
            Select Top 5
          </button>
          <span className="text-gray-600" aria-hidden="true">
            /
          </span>
          <button
            type="button"
            onClick={() => onSelectBatchPreset('all')}
            className="text-xs font-medium text-gray-300 hover:text-white whitespace-nowrap"
          >
            Select All
          </button>
          <span className="text-gray-600" aria-hidden="true">
            /
          </span>
          <button
            type="button"
            onClick={() => onSelectBatchPreset('none')}
            className="text-xs font-medium text-gray-400 hover:text-white whitespace-nowrap"
          >
            Clear
          </button>
        </div>

        <div className="flex items-center gap-1 rounded-lg border border-white/8 bg-[#12151C] p-1">
          {(
            [
              { id: 'score', label: 'Viral Score' },
              { id: 'timeline', label: 'Timeline Order' },
              { id: 'duration', label: 'Duration' },
            ] as const
          ).map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setSortBy(opt.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                sortBy === opt.id
                  ? 'bg-[#1E2330] text-white'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Candidate Cards */}
      <div className="space-y-4">
        {sortedClips.map((clip: ClipCandidate) => {
          const tier = getScoreTierText(clip.score.total);
          const isExpanded = expandedClipId === clip.id;

          return (
            <div
              key={clip.id}
              className="rounded-xl border border-white/8 bg-[#12151C] p-5 transition-colors hover:border-white/15"
            >
              <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
                {/* Selection & Thumbnail */}
                <div className="flex items-start gap-4">
                  <button
                    type="button"
                    onClick={() => onToggleClipSelection(clip.id, !clip.selected)}
                    aria-label={clip.selected ? 'Deselect clip' : 'Select clip'}
                    className="mt-1 text-gray-400 hover:text-white"
                  >
                    {clip.selected ? (
                      <CheckSquare className="h-5 w-5 text-blue-400" />
                    ) : (
                      <Square className="h-5 w-5" />
                    )}
                  </button>

                  <div className="relative h-24 w-40 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-[#0B0D12]">
                    {clip.thumbnailUrl ? (
                      <img
                        src={apiUrl(clip.thumbnailUrl)}
                        alt={clip.title}
                        referrerPolicy="no-referrer"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-gray-600">
                        <Film className="h-6 w-6" />
                      </div>
                    )}
                    <div className="absolute bottom-1.5 right-1.5 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[11px] text-white tabular-nums">
                      {formatDurationLabel(clip.durationSeconds)}
                    </div>
                  </div>
                </div>

                {/* Main Metadata & Content */}
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
                    <span className="font-mono font-semibold text-gray-200 tabular-nums">
                      Clip {String(clip.index).padStart(2, '0')}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{clip.categoryLabel}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      {formatTimecode(clip.startSeconds)} – {formatTimecode(clip.endSeconds)}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{clip.primarySpeaker}</span>
                  </div>

                  <h3 className="text-base font-semibold text-white">{clip.title}</h3>

                  <p className="text-sm leading-relaxed text-gray-300">
                    {clip.whyInteresting}
                  </p>

                  <div className="pt-1 text-xs text-gray-400">
                    <span className="font-medium text-gray-300">Opening Hook: </span>
                    <span>“{clip.openingHook}”</span>
                  </div>
                </div>

                {/* Viral Score & Actions */}
                <div className="flex flex-row items-center justify-between gap-4 border-t border-white/8 pt-4 lg:w-64 lg:flex-col lg:items-end lg:border-t-0 lg:pt-0 shrink-0">
                  <div className="lg:text-right">
                    <div className="font-mono text-2xl font-bold text-white tabular-nums">
                      {clip.score.total}
                      <span className="text-sm font-normal text-gray-500">/100</span>
                    </div>
                    <div className={`text-xs font-medium ${tier.colorClass}`}>
                      {tier.label}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedClipId(isExpanded ? null : clip.id)
                      }
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#171B24] px-3 py-2 text-xs font-medium text-gray-300 hover:text-white whitespace-nowrap shrink-0"
                    >
                      <Sliders className="h-3.5 w-3.5" />
                      <span>{isExpanded ? 'Hide Rubric' : 'Score Rubric'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenEditor(clip.id)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-500 whitespace-nowrap shrink-0"
                    >
                      <span>Edit Clip</span>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>

              {/* 7-Factor Rubric Breakdown */}
              {isExpanded && (
                <div className="mt-5 grid grid-cols-2 gap-3 border-t border-white/8 pt-4 sm:grid-cols-4 lg:grid-cols-7">
                  {[
                    { label: 'Opening Hook', val: clip.score.openingHook, max: 20 },
                    { label: 'Emotional Reaction', val: clip.score.emotionalReaction, max: 20 },
                    { label: 'Conversation', val: clip.score.interestingConversation, max: 15 },
                    { label: 'Humor / Surprise', val: clip.score.humorOrSurprise, max: 15 },
                    { label: 'Educational Value', val: clip.score.educationalValue, max: 10 },
                    { label: 'Standalone Context', val: clip.score.standaloneContext, max: 10 },
                    { label: 'Strong Ending', val: clip.score.strongEnding, max: 10 },
                  ].map((factor) => (
                    <div
                      key={factor.label}
                      className="rounded-lg border border-white/8 bg-[#0B0D12] p-3"
                    >
                      <p className="text-[11px] text-gray-400 truncate">{factor.label}</p>
                      <p className="mt-1 font-mono text-sm font-semibold text-white tabular-nums">
                        {factor.val}
                        <span className="text-gray-500">/{factor.max}</span>
                      </p>
                      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/10">
                        <div
                          className="h-full bg-amber-400"
                          style={{ width: `${(factor.val / factor.max) * 100}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

import React, { useMemo, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  Film,
  Loader2,
  Plus,
  Search,
  Trash2,
  TriangleAlert,
  Youtube,
  Upload,
} from 'lucide-react';
import type { Project } from '../types';
import { apiUrl } from '../utils/api';
import { formatDateShort, formatDurationLabel } from '../utils/formatters';

interface DashboardViewProps {
  projects: Project[];
  loading: boolean;
  onCreateNew: () => void;
  onSelectProject: (project: Project, targetView?: 'analysis' | 'editor' | 'export') => void;
  onDeleteProject: (projectId: string) => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  projects,
  loading,
  onCreateNew,
  onSelectProject,
  onDeleteProject,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'processing' | 'failed'>('all');
  const [bannerError, setBannerError] = useState(false);

  const stats = useMemo(() => {
    const totalProjects = projects.length;
    const allClips = projects.flatMap((p) => p.clips);
    const totalClips = allClips.length;
    const avgScore =
      totalClips > 0
        ? Math.round(allClips.reduce((acc, c) => acc + c.score.total, 0) / totalClips)
        : 0;
    const renderedExports = allClips.filter((c) => c.renderStatus === 'completed').length;
    return { totalProjects, totalClips, avgScore, renderedExports };
  }, [projects]);

  const filteredProjects = useMemo(() => {
    return projects.filter((p) => {
      if (statusFilter !== 'all' && p.status !== statusFilter) return false;
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        p.title.toLowerCase().includes(q) ||
        (p.channelOrAuthor || '').toLowerCase().includes(q) ||
        (p.youtubeUrl || '').toLowerCase().includes(q)
      );
    });
  }, [projects, searchQuery, statusFilter]);

  return (
    <div className="space-y-8">
      {/* Hero Launch Section */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-stretch">
        <div className="lg:col-span-7 flex flex-col justify-between rounded-xl border border-white/8 bg-[#12151C] p-6 sm:p-8">
          <div>
            <p className="text-xs font-medium tracking-wide text-blue-400">
              AI Video Clipping Workspace
            </p>
            <h1 className="mt-2 text-2xl sm:text-3xl font-bold tracking-tight text-white [text-wrap:balance]">
              Turn long-form videos into ready-to-publish vertical clips
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-gray-400">
              Paste a public YouTube link or upload an original studio video. Gemini analyzes speech,
              emotional reactions, and hooks against a 100-point viral rubric, then FFmpeg reframes
              to 9:16 with speaker centering and burned-in animated captions.
            </p>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3 pt-4 border-t border-white/8">
            <button
              type="button"
              onClick={onCreateNew}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500 whitespace-nowrap shrink-0"
            >
              <Plus className="h-4 w-4" />
              <span>Start New Project</span>
            </button>
            {projects.length > 0 && (
              <button
                type="button"
                onClick={() => onSelectProject(projects[0], projects[0].status === 'completed' ? 'editor' : 'analysis')}
                className="inline-flex items-center gap-2 rounded-lg border border-white/12 bg-[#171B24] px-4 py-2.5 text-sm font-medium text-gray-200 transition-colors hover:bg-[#1E2330] whitespace-nowrap shrink-0"
              >
                <span>Resume Latest Project</span>
                <ArrowRight className="h-4 w-4 text-gray-400" />
              </button>
            )}
          </div>
        </div>

        <div className="lg:col-span-5 relative min-h-[220px] overflow-hidden rounded-xl border border-white/8 bg-[#12151C]">
          {!bannerError ? (
            <img
              src="/src/assets/images/studio_editing_preview_1795082252069.jpg"
              alt="Video editing workstation displaying interview timeline"
              referrerPolicy="no-referrer"
              onError={() => setBannerError(true)}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-[#151922] p-6">
              <Film className="h-12 w-12 text-blue-500/60" />
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-[#0B0D12]/90 via-[#0B0D12]/30 to-transparent" />
          <div className="absolute bottom-0 left-0 right-0 p-5">
            <p className="text-xs font-medium text-amber-400">
              Multi-Platform Pipeline
            </p>
            <p className="mt-1 text-sm font-medium text-white">
              TikTok · YouTube Shorts · Instagram Reels · Facebook
            </p>
          </div>
        </div>
      </section>

      {/* Usage Metrics Strip (4-column flat grid) */}
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-xl border border-white/8 bg-[#12151C] p-5">
          <p className="text-xs text-gray-400">Projects Analyzed</p>
          <p className="mt-2 font-mono text-2xl font-bold text-white tabular-nums">
            {stats.totalProjects}
          </p>
        </div>
        <div className="rounded-xl border border-white/8 bg-[#12151C] p-5">
          <p className="text-xs text-gray-400">Viral Clips Detected</p>
          <p className="mt-2 font-mono text-2xl font-bold text-white tabular-nums">
            {stats.totalClips}
          </p>
        </div>
        <div className="rounded-xl border border-white/8 bg-[#12151C] p-5">
          <p className="text-xs text-gray-400">Average Viral Score</p>
          <p className="mt-2 font-mono text-2xl font-bold text-amber-400 tabular-nums">
            {stats.avgScore}
            <span className="text-sm font-normal text-gray-500">/100</span>
          </p>
        </div>
        <div className="rounded-xl border border-white/8 bg-[#12151C] p-5">
          <p className="text-xs text-gray-400">Rendered MP4 Exports</p>
          <p className="mt-2 font-mono text-2xl font-bold text-emerald-400 tabular-nums">
            {stats.renderedExports}
          </p>
        </div>
      </section>

      {/* Recent Projects Table / Grid */}
      <section className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg font-semibold text-white">Recent Projects</h2>

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search projects..."
                className="w-56 rounded-lg border border-white/10 bg-[#12151C] py-2 pl-9 pr-3 text-sm text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div className="flex items-center gap-1 rounded-lg border border-white/8 bg-[#12151C] p-1">
              {(['all', 'completed', 'processing', 'failed'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setStatusFilter(tab)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors whitespace-nowrap shrink-0 ${
                    statusFilter === tab
                      ? 'bg-[#1E2330] text-white'
                      : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
          </div>
        </div>

        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((row) => (
              <div
                key={row}
                className="h-20 animate-pulse rounded-xl border border-white/8 bg-[#12151C]"
              />
            ))}
          </div>
        ) : filteredProjects.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/12 bg-[#12151C] px-6 py-14 text-center">
            <Film className="h-10 w-10 text-gray-500" />
            <h3 className="mt-4 text-base font-semibold text-white">
              {projects.length === 0 ? 'No clipping projects yet' : 'No matching projects'}
            </h3>
            <p className="mt-1.5 max-w-md text-sm text-gray-400">
              {projects.length === 0
                ? 'Paste a YouTube video link or upload an MP4/MOV file to let Gemini find your highest-retention short clips.'
                : 'Try clearing your search filter or switching the status tab.'}
            </p>
            {projects.length === 0 && (
              <button
                type="button"
                onClick={onCreateNew}
                className="mt-5 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
              >
                <Plus className="h-4 w-4" />
                <span>Create First Project</span>
              </button>
            )}
          </div>
        ) : (
          <div className="divide-y divide-white/8 overflow-hidden rounded-xl border border-white/8 bg-[#12151C]">
            {filteredProjects.map((project) => {
              const topScore =
                project.clips.length > 0
                  ? Math.max(...project.clips.map((c) => c.score.total))
                  : null;
              const renderedCount = project.clips.filter(
                (c) => c.renderStatus === 'completed'
              ).length;

              return (
                <div
                  key={project.id}
                  className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between hover:bg-white/[0.02] transition-colors"
                >
                  <button
                    type="button"
                    onClick={() =>
                      onSelectProject(
                        project,
                        project.status === 'completed' ? 'analysis' : 'analysis'
                      )
                    }
                    className="flex flex-1 items-center gap-4 text-left min-w-0"
                  >
                    <div className="relative h-16 w-28 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-[#1A1E27]">
                      {project.thumbnailUrl ? (
                        <img
                          src={apiUrl(project.thumbnailUrl)}
                          alt={project.title}
                          referrerPolicy="no-referrer"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-gray-500">
                          {project.sourceType === 'youtube' ? (
                            <Youtube className="h-5 w-5" />
                          ) : (
                            <Upload className="h-5 w-5" />
                          )}
                        </div>
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-sm font-semibold text-white">
                        {project.title}
                      </h3>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-400">
                        <span>
                          {project.sourceType === 'youtube' ? 'YouTube URL' : 'Uploaded Video'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">
                          {project.clips.length} clips
                        </span>
                        {topScore !== null && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono text-amber-400 tabular-nums">
                              Top {topScore}/100
                            </span>
                          </>
                        )}
                        {project.videoDurationSeconds && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">
                              {formatDurationLabel(project.videoDurationSeconds)}
                            </span>
                          </>
                        )}
                        <span aria-hidden="true">·</span>
                        <span>{formatDateShort(project.createdAt)}</span>
                      </div>
                    </div>
                  </button>

                  <div className="flex items-center justify-between gap-4 sm:justify-end shrink-0">
                    {/* Explicit Icon + Text Status */}
                    <div className="flex items-center gap-1.5 text-xs font-medium whitespace-nowrap">
                      {project.status === 'completed' && (
                        <>
                          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                          <span className="text-emerald-400">
                            Completed
                            {renderedCount > 0 ? ` (${renderedCount} exported)` : ''}
                          </span>
                        </>
                      )}
                      {project.status === 'processing' && (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
                          <span className="text-blue-400 font-mono tabular-nums">
                            Processing {project.analysisProgress}%
                          </span>
                        </>
                      )}
                      {project.status === 'failed' && (
                        <>
                          <TriangleAlert className="h-4 w-4 text-rose-400" />
                          <span className="text-rose-400">Failed</span>
                        </>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      {project.status === 'completed' && (
                        <button
                          type="button"
                          onClick={() => onSelectProject(project, 'editor')}
                          className="rounded-lg border border-white/10 bg-[#181C26] px-3 py-1.5 text-xs font-medium text-gray-200 hover:bg-[#222836] whitespace-nowrap shrink-0"
                        >
                          Open Editor
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onSelectProject(project, 'analysis')}
                        className="rounded-lg bg-blue-600/15 px-3 py-1.5 text-xs font-medium text-blue-400 hover:bg-blue-600/25 whitespace-nowrap shrink-0"
                      >
                        View Clips
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteProject(project.id)}
                        aria-label={`Delete ${project.title}`}
                        className="rounded-lg p-2 text-gray-500 hover:bg-rose-500/10 hover:text-rose-400 transition-colors"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};

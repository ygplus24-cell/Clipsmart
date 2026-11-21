import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    let readable = error.message || 'An unexpected application error occurred.';
    try {
      const parsed = JSON.parse(readable) as {
        error?: string;
        operationType?: string;
        path?: string;
      };
      if (parsed?.error && parsed?.operationType) {
        readable = `Database ${parsed.operationType} error${
          parsed.path ? ` (${parsed.path})` : ''
        }: ${parsed.error}`;
      }
    } catch {
      // Keep original error message if not JSON
    }
    return { hasError: true, message: readable };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('ClipGenius ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#0B0D12] text-[#F3F4F6] flex items-center justify-center p-6">
          <div className="max-w-lg w-full rounded-xl border border-rose-500/35 bg-[#12151C] p-6 space-y-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-rose-400 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-white">
                  Workspace Error Detected
                </h2>
                <p className="mt-1.5 text-xs leading-relaxed text-rose-200/90 break-words">
                  {this.state.message}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>Reload Workspace</span>
              </button>
              <button
                type="button"
                onClick={() => this.setState({ hasError: false, message: '' })}
                className="rounded-lg border border-white/12 bg-[#171B24] px-4 py-2 text-xs font-medium text-gray-200 hover:bg-[#222836]"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

import React, { useState } from 'react';
import { Check, Copy, Download, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  compact?: boolean;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({
  compact = false,
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

  if (isInstalled) {
    return null;
  }

  const appUrl =
    typeof window !== 'undefined' ? window.location.origin : '';
  const isInIframe =
    typeof window !== 'undefined' && window.self !== window.top;

  const handleCopyUrl = async () => {
    if (!appUrl) return;
    await navigator.clipboard.writeText(appUrl);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className={`flex items-center justify-center gap-2 rounded-lg bg-blue-600 font-medium text-white transition-colors hover:bg-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 whitespace-nowrap shrink-0 ${
          compact ? 'px-3 py-2 text-xs w-full' : 'px-4 py-2 text-sm'
        }`}
      >
        <Download className="h-4 w-4 shrink-0" />
        <span>Install App</span>
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setShowGuide(true)}
        className={`flex items-center justify-center gap-2 rounded-lg border border-white/12 bg-[#171B24] font-medium text-gray-200 transition-colors hover:bg-[#1F2430] whitespace-nowrap shrink-0 ${
          compact ? 'px-3 py-2 text-xs w-full' : 'px-4 py-2 text-sm'
        }`}
      >
        {isIOS ? (
          <Smartphone className="h-4 w-4 shrink-0 text-blue-400" />
        ) : (
          <Download className="h-4 w-4 shrink-0 text-blue-400" />
        )}
        <span>{isIOS ? 'Install on iPhone' : 'Install on Phone'}</span>
      </button>

      {showGuide && (
        <div
          onClick={() => setShowGuide(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-xl border border-white/10 bg-[#14171F] p-6 shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-white">
                {isIOS
                  ? 'Install ClipGenius on iPhone / iPad'
                  : 'Install ClipGenius on Your Phone'}
              </h3>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                aria-label="Close install guide"
                className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {isInIframe && (
              <p className="rounded-lg border border-amber-500/25 bg-amber-950/30 p-3 text-xs leading-relaxed text-amber-200">
                Open this app directly in Safari (iPhone) or Chrome (Android) outside the
                embedded preview frame so your browser can add it to your home screen.
              </p>
            )}

            {isIOS ? (
              <ol className="space-y-2 text-sm text-gray-300">
                <li>1. Open the app URL in <strong className="text-white">Safari</strong> on your iPhone.</li>
                <li>2. Tap the <strong className="text-white">Share</strong> icon at the bottom of the screen.</li>
                <li>3. Scroll down and tap <strong className="text-white">Add to Home Screen</strong>, then tap <strong className="text-white">Add</strong>.</li>
              </ol>
            ) : (
              <ol className="space-y-2 text-sm text-gray-300">
                <li>1. Open the app URL in <strong className="text-white">Chrome</strong> on your Android phone (or Safari on iPhone).</li>
                <li>2. Tap the <strong className="text-white">Install App</strong> prompt, or tap the browser menu (<strong className="text-white">⋮</strong>) and select <strong className="text-white">Add to Home screen</strong> / <strong className="text-white">Install app</strong>.</li>
                <li>3. Launch <strong className="text-white">ClipGenius</strong> directly from your home screen in standalone mode.</li>
              </ol>
            )}

            {appUrl && (
              <div className="rounded-lg border border-white/10 bg-[#0B0D12] p-3">
                <p className="text-[11px] font-medium text-gray-400">Direct App URL</p>
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs text-blue-300">
                    {appUrl}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyUrl}
                    className="inline-flex items-center gap-1 rounded-md border border-white/12 bg-[#171B24] px-2.5 py-1 text-xs font-medium text-white hover:bg-[#222836] shrink-0"
                  >
                    {copiedUrl ? (
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    <span>{copiedUrl ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-semibold text-white hover:bg-blue-500"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </>
  );
};

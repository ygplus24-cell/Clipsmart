import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-950/90 px-3.5 py-2 text-xs font-medium text-amber-200 shadow-lg backdrop-blur"
    >
      <WifiOff className="h-3.5 w-3.5 shrink-0 text-amber-400" />
      <span>Offline Mode — Cached studio interface active</span>
    </div>
  );
};

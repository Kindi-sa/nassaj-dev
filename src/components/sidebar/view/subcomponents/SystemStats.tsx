import { useCallback, useEffect, useRef, useState } from 'react';
import { Cpu, MemoryStick } from 'lucide-react';
import type { TFunction } from 'i18next';
import { authenticatedFetch } from '../../../../utils/api';

const POLL_INTERVAL_MS = 5000;

type SystemStats = {
  cpu: { percent: number };
  memory: { usedBytes: number; totalBytes: number; percent: number };
};

function formatGb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

/**
 * Polls GET /api/system/stats every 5s. Polling pauses while the tab is
 * hidden (document.hidden) and resumes with an immediate fetch on return.
 * A 404 (live server predates the route) stops polling permanently and the
 * widgets render a graceful em-dash / nothing — no console noise.
 */
function useSystemStats(): SystemStats | null {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const unsupportedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    if (unsupportedRef.current) return;
    if (!document.hidden) {
      try {
        const res = await authenticatedFetch('/api/system/stats');
        if (res.ok) {
          setStats(await res.json());
        } else if (res.status === 404) {
          // Old server without the route — give up quietly.
          unsupportedRef.current = true;
          return;
        }
      } catch {
        // Network hiccup: keep the last value and retry on the next tick.
      }
    }
    timerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
  }, []);

  useEffect(() => {
    poll();
    const onVisibility = () => {
      if (!document.hidden && !unsupportedRef.current) {
        if (timerRef.current) clearTimeout(timerRef.current);
        poll();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      unsupportedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [poll]);

  return stats;
}

/** Expanded-footer variant: two rows (desktop + mobile styles inside). */
export function SystemStatsFooter({ t }: { t: TFunction }) {
  const stats = useSystemStats();

  const cpuText = stats ? `${Math.round(stats.cpu.percent)}%` : '—';
  const ramText = stats
    ? `${formatGb(stats.memory.usedBytes)}/${formatGb(stats.memory.totalBytes)}GB (${Math.round(stats.memory.percent)}%)`
    : '—';

  return (
    <>
      {/* Desktop CPU */}
      <div className="hidden px-2 pt-1.5 md:block">
        <div
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground"
          title={t('systemStats.cpuUsage')}
        >
          <Cpu className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="truncate text-sm tabular-nums">CPU {cpuText}</span>
        </div>
      </div>

      {/* Desktop RAM */}
      <div className="hidden px-2 md:block">
        <div
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground"
          title={t('systemStats.memoryUsage')}
        >
          <MemoryStick className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="truncate text-sm tabular-nums">RAM {ramText}</span>
        </div>
      </div>

      {/* Mobile combined card */}
      <div className="px-3 pt-3 md:hidden">
        <div className="flex w-full flex-col justify-center gap-1 rounded-xl bg-muted/40 px-4 py-2.5">
          <div
            className="flex items-center gap-2 text-muted-foreground"
            title={t('systemStats.cpuUsage')}
          >
            <Cpu className="h-4 w-4 flex-shrink-0" />
            <span className="text-sm tabular-nums">CPU {cpuText}</span>
          </div>
          <div
            className="flex items-center gap-2 text-muted-foreground"
            title={t('systemStats.memoryUsage')}
          >
            <MemoryStick className="h-4 w-4 flex-shrink-0" />
            <span className="text-sm tabular-nums">RAM {ramText}</span>
          </div>
        </div>
      </div>
    </>
  );
}

/** Collapsed-rail variant: two tiny icon+percent stacks; hidden until data. */
export function SystemStatsCollapsed({ t }: { t: TFunction }) {
  const stats = useSystemStats();

  if (!stats) return null;

  return (
    <>
      <div
        className="flex flex-col items-center gap-0.5 py-1 text-muted-foreground"
        title={`${t('systemStats.cpuUsage')}: ${Math.round(stats.cpu.percent)}%`}
        aria-label={t('systemStats.cpuUsage')}
      >
        <Cpu className="h-3.5 w-3.5" />
        <span className="text-[9px] leading-none tabular-nums">
          {Math.round(stats.cpu.percent)}%
        </span>
      </div>
      <div
        className="flex flex-col items-center gap-0.5 py-1 text-muted-foreground"
        title={`${t('systemStats.memoryUsage')}: ${formatGb(stats.memory.usedBytes)}/${formatGb(stats.memory.totalBytes)}GB (${Math.round(stats.memory.percent)}%)`}
        aria-label={t('systemStats.memoryUsage')}
      >
        <MemoryStick className="h-3.5 w-3.5" />
        <span className="text-[9px] leading-none tabular-nums">
          {Math.round(stats.memory.percent)}%
        </span>
      </div>
    </>
  );
}

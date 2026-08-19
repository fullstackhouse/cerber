import { searchAwaitingMe } from "../core/gh.js";
import { pool, reviewPr } from "../runner/review.js";

export interface DaemonOptions {
  /** Repos to watch (owner/repo). Empty = everything your gh account can see. */
  repos: string[];
  intervalMs: number;
  parallel: number;
  model?: string;
}

export interface DaemonStatus {
  enabled: true;
  polling: boolean;
  repos: string[];
  intervalMs: number;
  polls: number;
  errors: number;
  lastPollAt: string | null;
  nextPollAt: string | null;
  lastSummary: string | null;
}

export interface DaemonHandle {
  status: () => DaemonStatus;
  stop: () => void;
}

/**
 * Poll GitHub for PRs awaiting the user's review and keep their artifacts
 * warm. Reviews are read-only; the daemon NEVER sends anything.
 */
export function startDaemon(opts: DaemonOptions): DaemonHandle {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const status: DaemonStatus = {
    enabled: true,
    polling: false,
    repos: opts.repos,
    intervalMs: opts.intervalMs,
    polls: 0,
    errors: 0,
    lastPollAt: null,
    nextPollAt: new Date(Date.now()).toISOString(),
    lastSummary: null,
  };

  const log = (m: string) => console.log(`[daemon] ${m}`);

  async function poll(): Promise<void> {
    if (status.polling) return;
    status.polling = true;
    status.lastPollAt = new Date().toISOString();
    try {
      const filters = opts.repos.length > 0 ? opts.repos : [undefined];
      const seen = new Set<string>();
      const refs = (
        await Promise.all(filters.map((repo) => searchAwaitingMe(repo)))
      )
        .flat()
        .filter((r) => {
          const id = `${r.owner}/${r.repo}#${r.number}`;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });

      let reviewed = 0;
      let skipped = 0;
      let failed = 0;
      await pool(refs, opts.parallel, async (ref) => {
        const label = `${ref.owner}/${ref.repo}#${ref.number}`;
        try {
          const result = await reviewPr(ref, {
            model: opts.model,
            onProgress: (m) => log(`[${label}] ${m}`),
          });
          if (result.skipped) skipped++;
          else reviewed++;
        } catch (err: unknown) {
          failed++;
          status.errors++;
          log(`[${label}] failed: ${err instanceof Error ? err.message : err}`);
        }
      });
      status.lastSummary = `${refs.length} awaiting; ${reviewed} reviewed, ${skipped} up to date${failed > 0 ? `, ${failed} failed` : ""}`;
      log(status.lastSummary);
    } catch (err: unknown) {
      status.errors++;
      status.lastSummary = `poll failed: ${err instanceof Error ? err.message : err}`;
      log(status.lastSummary);
    } finally {
      status.polls++;
      status.polling = false;
      if (!stopped) {
        status.nextPollAt = new Date(Date.now() + opts.intervalMs).toISOString();
        timer = setTimeout(poll, opts.intervalMs);
      }
    }
  }

  void poll();

  return {
    status: () => ({ ...status }),
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

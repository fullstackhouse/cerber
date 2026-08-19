import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { PrRef } from "./gh.js";
import { cerberHome } from "./state.js";

const execFileAsync = promisify(execFile);

export interface Checkout {
  /** Working tree the reviewer reads from. */
  dir: string;
  /** Commit actually checked out — compare against the PR head. */
  sha: string;
}

export interface CheckoutDeps {
  git: (args: string[], cwd: string) => Promise<string>;
  isRepo: (dir: string) => Promise<boolean>;
  mkdir: (dir: string) => Promise<void>;
  /** Rename a path out of the way; a no-op if it isn't there. */
  quarantine: (from: string, to: string) => Promise<boolean>;
  /** Mark the checkout as used just now, for the cache's eviction order. */
  touch: (dir: string) => Promise<void>;
}

/**
 * Config files a checked-out repo could use to make the reviewing agent run
 * code. `claude -p` skips the workspace-trust prompt, so a PR that adds a hook
 * here would otherwise execute on the reviewer's machine.
 */
export const AGENT_CONFIG_FILES = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".mcp.json",
];

const QUARANTINE_SUFFIX = ".cerber-quarantined";

const realDeps: CheckoutDeps = {
  git: async (args, cwd) => {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
      return stdout;
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string };
      throw new Error(`git ${args.slice(0, 2).join(" ")} failed: ${e.stderr?.trim() || e.message}`);
    }
  },
  isRepo: (dir) =>
    fs
      .access(path.join(dir, ".git"))
      .then(() => true)
      .catch(() => false),
  mkdir: async (dir) => {
    await fs.mkdir(dir, { recursive: true });
  },
  quarantine: async (from, to) => {
    try {
      await fs.rename(from, to);
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  },
  touch: async (dir) => {
    const now = new Date();
    await fs.utimes(dir, now, now).catch(() => {});
  },
};

/** One shallow working tree per PR, under ~/.cerber/src — a cache, safe to delete. */
export function sourceDir(ref: PrRef): string {
  return path.join(cerberHome(), "src", `${ref.owner}__${ref.repo}__${ref.number}`);
}

/**
 * An empty directory for diff-only runs. Whatever directory cerber was started
 * from belongs to some other project, and the run would pick up its CLAUDE.md
 * and settings as if they described the PR under review.
 */
export async function neutralDir(): Promise<string> {
  const dir = path.join(cerberHome(), "run");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Put the PR's head commit on disk so the reviewer can read the code around the
 * diff. Fetches `refs/pull/N/head` from the base repo, which resolves fork PRs
 * too, at depth 1 — cerber never needs the history, only the tree.
 *
 * Read-only towards GitHub. Auth rides `gh`'s credential helper, set locally on
 * this clone so nothing in the user's git config is touched.
 */
export async function prepareCheckout(
  ref: PrRef,
  opts: {
    log?: (message: string) => void;
    deps?: Partial<CheckoutDeps>;
    /** A trusted review gets the repo as its author wrote it, config included. */
    trusted?: boolean;
  } = {},
): Promise<Checkout> {
  const deps = { ...realDeps, ...opts.deps };
  const log = opts.log ?? (() => {});
  const dir = sourceDir(ref);

  if (!(await deps.isRepo(dir))) {
    log(`Preparing a source checkout in ${dir}…`);
    await deps.mkdir(dir);
    await deps.git(["init", "-q"], dir);
    await deps.git(["remote", "add", "origin", `https://github.com/${ref.owner}/${ref.repo}.git`], dir);
    await deps.git(["config", "credential.helper", "!gh auth git-credential"], dir);
  }

  await deps.git(["fetch", "-q", "--depth=1", "--no-tags", "origin", `refs/pull/${ref.number}/head`], dir);
  await deps.git(["checkout", "-q", "--force", "--detach", "FETCH_HEAD"], dir);
  // A previous head may have left untracked files behind; they would read as
  // part of this commit's tree. This also wipes any quarantine an earlier run
  // left, which is why the loop below never has to undo one: every run starts
  // from the commit's own files, whether or not the last one was trusted.
  await deps.git(["clean", "-qfdx"], dir);

  if (!opts.trusted) {
    // Renamed rather than deleted: the reviewer can still read and comment on
    // these files, but Claude Code won't load them as its own configuration.
    for (const file of AGENT_CONFIG_FILES) {
      const live = path.join(dir, file);
      if (await deps.quarantine(live, live + QUARANTINE_SUFFIX)) {
        log(`Quarantined ${file} from the checkout — PR config never configures the reviewer.`);
      }
    }
  }

  const sha = (await deps.git(["rev-parse", "HEAD"], dir)).trim();
  await deps.touch(dir);
  return { dir, sha };
}

export interface CachedCheckout {
  /** "owner/repo#123" — the artifact this checkout belongs to. */
  id: string;
  dir: string;
  bytes: number;
}

interface CheckoutEntry {
  id: string;
  dir: string;
  /** Last time a review used it — how the cache decides what to drop. */
  usedAt: number;
}

async function listCheckoutDirs(): Promise<CheckoutEntry[]> {
  const root = path.join(cerberHome(), "src");
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const found: CheckoutEntry[] = [];
  for (const entry of entries) {
    const parsed = entry.match(/^(.+)__(.+)__(\d+)$/);
    if (!parsed) continue;
    const dir = path.join(root, entry);
    const usedAt = await fs.stat(dir).then((s) => s.mtimeMs, () => 0);
    found.push({ id: `${parsed[1]}/${parsed[2]}#${parsed[3]}`, dir, usedAt });
  }
  return found;
}

/** Every checkout currently on disk, with what it costs. Walks each tree. */
export async function listCheckouts(): Promise<CachedCheckout[]> {
  const entries = await listCheckoutDirs();
  const found: CachedCheckout[] = [];
  for (const entry of entries) {
    found.push({ id: entry.id, dir: entry.dir, bytes: await dirSize(entry.dir) });
  }
  return found.sort((a, b) => b.bytes - a.bytes);
}

/**
 * Checkouts are the default now, so the cache has to stop growing on its own —
 * a daemon watching a busy repo would otherwise clone every PR it ever sees and
 * keep them all. Drops the least recently used, and never one being reviewed.
 */
export const MAX_CACHED_CHECKOUTS = 8;

export async function evictOldCheckouts(
  opts: { keep?: number; inUse?: (id: string) => boolean } = {},
): Promise<string[]> {
  const keep = opts.keep ?? MAX_CACHED_CHECKOUTS;
  const inUse = opts.inUse ?? (() => false);
  const entries = (await listCheckoutDirs()).sort((a, b) => b.usedAt - a.usedAt);

  const evicted: string[] = [];
  let kept = 0;
  for (const entry of entries) {
    if (inUse(entry.id) || kept < keep) {
      kept++;
      continue;
    }
    await removeCheckout(entry.dir);
    evicted.push(entry.id);
  }
  return evicted;
}

export async function removeCheckout(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) total += await fs.stat(full).then((s) => s.size, () => 0);
  }
  return total;
}

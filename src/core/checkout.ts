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
  opts: { log?: (message: string) => void; deps?: Partial<CheckoutDeps> } = {},
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
  // part of this commit's tree.
  await deps.git(["clean", "-qfdx"], dir);

  // Renamed rather than deleted: the reviewer can still read and comment on
  // these files, but Claude Code won't load them as its own configuration.
  for (const file of AGENT_CONFIG_FILES) {
    const moved = await deps.quarantine(
      path.join(dir, file),
      path.join(dir, file + QUARANTINE_SUFFIX),
    );
    if (moved) log(`Quarantined ${file} from the checkout — PR config never configures the reviewer.`);
  }

  const sha = (await deps.git(["rev-parse", "HEAD"], dir)).trim();
  return { dir, sha };
}

export interface CachedCheckout {
  /** "owner/repo#123" — the artifact this checkout belongs to. */
  id: string;
  dir: string;
  bytes: number;
}

/** Every checkout currently on disk, with what it costs. */
export async function listCheckouts(): Promise<CachedCheckout[]> {
  const root = path.join(cerberHome(), "src");
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const found: CachedCheckout[] = [];
  for (const entry of entries) {
    const parsed = entry.match(/^(.+)__(.+)__(\d+)$/);
    if (!parsed) continue;
    const dir = path.join(root, entry);
    found.push({ id: `${parsed[1]}/${parsed[2]}#${parsed[3]}`, dir, bytes: await dirSize(dir) });
  }
  return found.sort((a, b) => b.bytes - a.bytes);
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

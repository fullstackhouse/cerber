import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PrInfo, PrInfoSchema } from "./artifact.js";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

/**
 * Accepts: a full PR URL, "owner/repo#123", or a bare number (requires repoFlag "owner/repo").
 */
export function parsePrRef(input: string, repoFlag?: string): PrRef {
  const urlMatch = input.match(
    /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/,
  );
  if (urlMatch) {
    return { owner: urlMatch[1]!, repo: urlMatch[2]!, number: Number(urlMatch[3]) };
  }
  const shortMatch = input.match(/^([^/\s#]+)\/([^/\s#]+)#(\d+)$/);
  if (shortMatch) {
    return { owner: shortMatch[1]!, repo: shortMatch[2]!, number: Number(shortMatch[3]) };
  }
  const numMatch = input.match(/^#?(\d+)$/);
  if (numMatch) {
    if (!repoFlag) {
      throw new Error(
        `PR "${input}" is a bare number — pass --repo owner/repo, or use a full URL / owner/repo#number.`,
      );
    }
    const [owner, repo] = repoFlag.split("/");
    if (!owner || !repo) throw new Error(`Invalid --repo "${repoFlag}", expected owner/repo.`);
    return { owner, repo, number: Number(numMatch[1]) };
  }
  throw new Error(`Cannot parse PR reference: "${input}"`);
}

async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, { maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${e.stderr?.trim() || e.message}`);
  }
}

export async function fetchPrInfo(ref: PrRef): Promise<PrInfo> {
  const out = await gh([
    "pr",
    "view",
    String(ref.number),
    "--repo",
    `${ref.owner}/${ref.repo}`,
    "--json",
    "title,url,author,body,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles,state",
  ]);
  const raw = JSON.parse(out);
  return PrInfoSchema.parse({
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    title: raw.title,
    url: raw.url,
    author: raw.author?.login ?? "unknown",
    body: raw.body ?? "",
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    headSha: raw.headRefOid ?? "",
    state: raw.state ?? "OPEN",
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    changedFiles: raw.changedFiles ?? 0,
  });
}

/**
 * Org and team membership, for `@org/*` and `@org/team` trust rules. A 404 is
 * GitHub's "no" and the answer we want; anything else (no `read:org` scope, an
 * outage) throws, so a broken check can never read as "trusted".
 */
export async function isOrgMember(org: string, login: string): Promise<boolean> {
  return membershipCheck(["api", `orgs/${org}/members/${login}`, "--silent"]);
}

export async function isTeamMember(org: string, team: string, login: string): Promise<boolean> {
  return membershipCheck(["api", `orgs/${org}/teams/${team}/memberships/${login}`, "--jq", ".state"]);
}

async function membershipCheck(args: string[]): Promise<boolean> {
  try {
    const out = await gh(args);
    // The team endpoint answers for invited-but-not-yet-joined people too.
    return out.trim() === "" || out.trim() === "active";
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not found|HTTP 404/i.test(message)) return false;
    throw err;
  }
}

export async function fetchPrDiff(ref: PrRef): Promise<string> {
  return gh(["pr", "diff", String(ref.number), "--repo", `${ref.owner}/${ref.repo}`]);
}

export interface DiscoveredPr extends PrRef {
  title: string;
  url: string;
  updatedAt: string;
  isDraft: boolean;
  /** Who opened it — the queue shows whose code an unattended run would execute. */
  author: string;
}

/** Map `gh search prs` JSON output to PR refs. Drafts are excluded. */
export function mapSearchResults(
  raw: {
    number: number;
    title: string;
    url: string;
    updatedAt: string;
    isDraft: boolean;
    repository: { nameWithOwner: string };
    author?: { login?: string };
  }[],
): DiscoveredPr[] {
  return raw
    .filter((r) => !r.isDraft)
    .flatMap((r) => {
      const [owner, repo] = r.repository.nameWithOwner.split("/");
      if (!owner || !repo) return [];
      return [
        {
          owner,
          repo,
          number: r.number,
          title: r.title,
          url: r.url,
          updatedAt: r.updatedAt,
          isDraft: r.isDraft,
          author: r.author?.login ?? "",
        },
      ];
    });
}

/**
 * Whose move it is on a PR GitHub still holds a review request for.
 *
 * A review of any kind — even a bare `COMMENTED` one — clears the request, so
 * a PR that is still awaiting you has had no review from you at all. The only
 * place your engagement can hide is the conversation, which is exactly what
 * this reads. `unknown` means the read failed: it claims nothing rather than
 * reporting silence we could not confirm.
 */
export type Reply = "none" | "you" | "them" | "unknown";

export interface Comment {
  author: string;
  at: string;
  /** CI, changelog and integration bots talk on PRs; none of it is an answer. */
  bot: boolean;
}

/** GitHub types bot accounts, and names them `something[bot]` besides. */
export const isBot = (c: { author: string; bot: boolean }) =>
  c.bot || c.author.endsWith("[bot]");

/** The PR's conversation comments, oldest first. Not the inline review ones —
 *  those come attached to a review, which would have cleared the request. */
export async function fetchConversation(ref: PrRef): Promise<Comment[]> {
  const out = await gh([
    "api",
    "--paginate",
    `repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`,
    "--jq",
    '.[] | {author: .user.login, at: .created_at, bot: (.user.type == "Bot")}',
  ]);
  // --jq streams one object per line rather than a JSON array.
  return out
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Comment);
}

/**
 * Whose move it is, from the conversation: you have not spoken at all, you
 * spoke last (so it is on them), or a person answered after you (back to you).
 *
 * Bots are ignored outright. A repo whose CI posts on every push would
 * otherwise report "they replied last" on everything, which is the fastest way
 * to make a signal worthless.
 */
export function classifyReply(comments: Comment[], login: string): Reply {
  const human = comments.filter((c) => !isBot(c));
  const mine = human.filter((c) => c.author === login);
  if (mine.length === 0) return "none";
  const lastMine = mine[mine.length - 1]!.at;
  // A comment of your own posted at the same instant can't be someone else's
  // answer to it, so only strictly-later comments hand the move back.
  return human.some((c) => c.author !== login && c.at > lastMine) ? "them" : "you";
}

/** The login `@me` resolves to. Asked once — it cannot change mid-process. */
let cachedLogin: Promise<string> | null = null;
export function currentLogin(): Promise<string> {
  cachedLogin ??= gh(["api", "user", "--jq", ".login"]).then((out) => out.trim());
  return cachedLogin;
}

export function searchAwaitingArgs(repoFilter?: string, limit = 50): string[] {
  const args = [
    "search",
    "prs",
    // An archived repo is read-only: its PRs can never merge, close, or take a
    // review. Without this they'd sit in the inbox forever — nothing retires them.
    "archived:false",
    "--review-requested=@me",
    "--state=open",
    "--limit",
    String(limit),
    "--json",
    "number,title,repository,isDraft,url,updatedAt,author",
  ];
  if (repoFilter) args.push("--repo", repoFilter);
  return args;
}

/** Open, non-draft PRs where the current gh user's review is requested. */
export async function searchAwaitingMe(repoFilter?: string, limit = 50): Promise<DiscoveredPr[]> {
  const out = await gh(searchAwaitingArgs(repoFilter, limit));
  return mapSearchResults(JSON.parse(out));
}

/**
 * THE ONLY GITHUB WRITE IN CERBER.
 * Submits a review in one shot. Must only ever be called from an explicit
 * user action (cockpit Send button / `cerber send` after confirmation).
 */
export async function submitReview(
  ref: PrRef,
  payload: {
    event: string;
    body: string;
    comments: { path: string; line: number; side: string; body: string }[];
    /** Commit the review was drafted against. Without it GitHub anchors comments
     *  to the PR's latest commit, which 422s whenever the PR moved on. */
    commitId?: string;
  },
): Promise<{ url: string | null }> {
  const args = [
    "api",
    `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`,
    "--method",
    "POST",
    "--input",
    "-",
  ];
  const { commitId, ...rest } = payload;
  const body = commitId ? { ...rest, commit_id: commitId } : rest;
  const { execFile: ef } = await import("node:child_process");
  const out = await new Promise<string>((resolve, reject) => {
    const child = ef("gh", args, { maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      // gh only prints the top-level "message" ("Unprocessable Entity"); the useful
      // part is the errors[] array it leaves in the response body on stdout.
      if (err) reject(new Error(`gh api reviews failed: ${ghErrorDetail(stderr, stdout) || err.message}`));
      else resolve(stdout);
    });
    child.stdin!.write(JSON.stringify(body));
    child.stdin!.end();
  });
  try {
    const res = JSON.parse(out);
    return { url: res.html_url ?? null };
  } catch {
    return { url: null };
  }
}

/** Combine gh's stderr with the details GitHub returns in the response body. */
export function ghErrorDetail(stderr: string | undefined, stdout: string | undefined): string {
  const head = stderr?.trim() ?? "";
  let details: string[] = [];
  try {
    const res = JSON.parse(stdout ?? "");
    details = (Array.isArray(res.errors) ? res.errors : [])
      .map((e: unknown) => (typeof e === "string" ? e : describeGhError(e as Record<string, unknown>)))
      .filter((s: string) => s.length > 0 && !head.includes(s));
  } catch {
    // Non-JSON body (rate-limit HTML, empty response) — stderr is all we have.
  }
  return [head, ...details].filter(Boolean).join(" — ");
}

function describeGhError(e: Record<string, unknown>): string {
  if (typeof e.message === "string") return e.message;
  const where = [e.resource, e.field].filter((v) => typeof v === "string").join(".");
  return [where, e.code].filter(Boolean).join(": ");
}

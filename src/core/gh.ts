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
 * Repo visibility, for the `private` trust rule. A separate call from
 * `gh pr view` — only made when a trust rule actually asks about it.
 */
export async function fetchRepoIsPrivate(ref: Pick<PrRef, "owner" | "repo">): Promise<boolean> {
  const out = await gh(["repo", "view", `${ref.owner}/${ref.repo}`, "--json", "isPrivate"]);
  return JSON.parse(out).isPrivate === true;
}

export async function fetchPrDiff(ref: PrRef): Promise<string> {
  return gh(["pr", "diff", String(ref.number), "--repo", `${ref.owner}/${ref.repo}`]);
}

export interface DiscoveredPr extends PrRef {
  title: string;
  url: string;
  updatedAt: string;
  isDraft: boolean;
}

/** Map `gh search prs` JSON output to PR refs. Drafts are excluded. */
export function mapSearchResults(
  raw: { number: number; title: string; url: string; updatedAt: string; isDraft: boolean; repository: { nameWithOwner: string } }[],
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
        },
      ];
    });
}

/** Open, non-draft PRs where the current gh user's review is requested. */
export async function searchAwaitingMe(repoFilter?: string, limit = 50): Promise<DiscoveredPr[]> {
  const args = [
    "search",
    "prs",
    "--review-requested=@me",
    "--state=open",
    "--limit",
    String(limit),
    "--json",
    "number,title,repository,isDraft,url,updatedAt",
  ];
  if (repoFilter) args.push("--repo", repoFilter);
  const out = await gh(args);
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

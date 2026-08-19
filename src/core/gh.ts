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
    "title,url,author,body,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles",
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
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    changedFiles: raw.changedFiles ?? 0,
  });
}

export async function fetchPrDiff(ref: PrRef): Promise<string> {
  return gh(["pr", "diff", String(ref.number), "--repo", `${ref.owner}/${ref.repo}`]);
}

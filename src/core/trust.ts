import { promises as fs } from "node:fs";
import path from "node:path";
import { cerberHome } from "./state.js";

/**
 * Which PRs cerber is willing to review with its guard down.
 *
 * The default review is defensive: it can read the checkout and nothing else,
 * because a PR is code a stranger wrote. That is the wrong posture for a
 * colleague's PR in your own repo, where you would happily run the tests
 * yourself. A trusted review may run commands — so trust is a statement about
 * the *people*, not the code, and you make it explicitly.
 */
export interface TrustRule {
  /** A "!" line: matches the same way, but denies. Denials win. */
  negated: boolean;
  kind: "repo" | "author" | "private";
  pattern: string;
}

export interface TrustContext {
  owner: string;
  repo: string;
  author: string;
  /** Only looked up when a `private` rule exists — it costs an extra gh call. */
  isPrivate?: boolean;
}

export function trustFilePath(): string {
  return path.join(cerberHome(), "trusted.txt");
}

export const TRUST_FILE_TEMPLATE = `# Reviews of PRs matching these lines run trusted: the AI may run commands in
# the checkout (tests, typecheck, git log) instead of only reading files, and
# the repo's own .claude config applies. Trust people, not code.
#
#   acme/widgets     one repo
#   acme             every repo in that owner or org
#   acme/*-service   globs, within a path segment
#   @someone         anything that person authored
#   private          any private repo
#   !acme/public-fork   "!" denies, and beats every other line
#
# Everything not listed is reviewed read-only. Delete a line to withdraw trust.
`;

export function parseTrustRules(text: string): TrustRule[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const negated = line.startsWith("!");
      const body = negated ? line.slice(1).trim() : line;
      if (body.toLowerCase() === "private") return { negated, kind: "private" as const, pattern: "private" };
      if (body.startsWith("@")) return { negated, kind: "author" as const, pattern: body.slice(1) };
      // A bare owner means every repo under it.
      return { negated, kind: "repo" as const, pattern: body.includes("/") ? body : `${body}/*` };
    });
}

/** True when any rule needs repo visibility, which is a separate gh call. */
export function needsVisibility(rules: TrustRule[]): boolean {
  return rules.some((rule) => rule.kind === "private");
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`, "i");
}

function ruleMatches(rule: TrustRule, ctx: TrustContext): boolean {
  switch (rule.kind) {
    case "repo":
      return globToRegExp(rule.pattern).test(`${ctx.owner}/${ctx.repo}`);
    case "author":
      return globToRegExp(rule.pattern).test(ctx.author);
    case "private":
      return ctx.isPrivate === true;
  }
}

export interface TrustDecision {
  trusted: boolean;
  /** The rule that decided it, for the log and the artifact. */
  reason: string;
}

export function decideTrust(rules: TrustRule[], ctx: TrustContext): TrustDecision {
  const describe = (rule: TrustRule) =>
    rule.kind === "private" ? "private" : rule.kind === "author" ? `@${rule.pattern}` : rule.pattern;

  const denial = rules.find((rule) => rule.negated && ruleMatches(rule, ctx));
  if (denial) return { trusted: false, reason: `denied by !${describe(denial)}` };

  const grant = rules.find((rule) => !rule.negated && ruleMatches(rule, ctx));
  if (grant) return { trusted: true, reason: `trusted by ${describe(grant)}` };

  return { trusted: false, reason: "no trust rule matches" };
}

/** Reads ~/.cerber/trusted.txt. Missing file = trust nobody, which is the safe default. */
export async function loadTrustRules(): Promise<TrustRule[]> {
  try {
    return parseTrustRules(await fs.readFile(trustFilePath(), "utf8"));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Append a rule, creating the file with its explanatory header if needed. */
export async function addTrustRule(pattern: string): Promise<string> {
  const file = trustFilePath();
  await fs.mkdir(cerberHome(), { recursive: true });
  const existing = await fs.readFile(file, "utf8").catch(() => null);
  const body = existing ?? TRUST_FILE_TEMPLATE;
  const line = pattern.trim();
  if (parseTrustRules(body).some((r) => r.pattern === parseTrustRules(line)[0]?.pattern && !r.negated)) {
    return file;
  }
  await fs.writeFile(file, `${body}${body.endsWith("\n") ? "" : "\n"}${line}\n`);
  return file;
}

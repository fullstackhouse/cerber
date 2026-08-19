/**
 * Which PRs cerber is willing to review with its guard down.
 *
 * The default review is defensive: it can read the checkout and nothing else,
 * because a PR is code a stranger wrote. That is the wrong posture for a
 * colleague's PR in your own repo, where you would happily run the tests
 * yourself. A trusted review may run commands — so trust is a statement about
 * the *people*, not the code, and you make it explicitly.
 *
 * The trap this guards against: a repo is not a set of people. Anyone can open
 * a PR against a public repo, so "trust this repo" must never mean "trust
 * whoever showed up". Repo-shaped rules therefore only apply when the PR's
 * branch was pushed to the repo itself, which takes write access; to trust
 * people directly, name them (`@login`) or their org/team (`@org/team`).
 */
export interface TrustRule {
  /** A "!" rule: matches the same way, but denies. Denials win. */
  negated: boolean;
  /** `membership` is "org/team" or "org/*" — who the author is, not where the PR lives. */
  kind: "repo" | "author" | "membership" | "private";
  pattern: string;
}

export interface TrustContext {
  owner: string;
  repo: string;
  author: string;
  /**
   * The PR's branch lives in the base repo, so its author can push there.
   * Anyone can open a PR against a public repo from a fork; only someone with
   * write access can push a branch to the repo itself. Every repo-shaped rule
   * requires this, or "trust this repo" would quietly mean "trust GitHub".
   */
  pushAccess: boolean;
  /** Only looked up when a `private` rule exists — it costs an extra gh call. */
  isPrivate?: boolean;
  /** "org/team" and "org/*" keys this author belongs to, resolved from GitHub. */
  memberships?: ReadonlySet<string>;
}

/** The org/team lookups a rule set needs before {@link decideTrust} can run. */
export interface MembershipQuery {
  org: string;
  /** null = "is a member of the org at all". */
  team: string | null;
  /** The key to put in {@link TrustContext.memberships} if it holds. */
  key: string;
}

export function membershipQueries(rules: TrustRule[]): MembershipQuery[] {
  const seen = new Map<string, MembershipQuery>();
  for (const rule of rules) {
    if (rule.kind !== "membership" || seen.has(rule.pattern)) continue;
    const [org, team] = rule.pattern.split("/");
    seen.set(rule.pattern, { org: org!, team: team === "*" ? null : team!, key: rule.pattern });
  }
  return [...seen.values()];
}

/** One rule as a person writes it. Null when there is nothing to parse. */
export function parseTrustRule(input: string): TrustRule | null {
  // Trailing "# why we trust them" survives a hand-edited config.
  const line = input.replace(/\s+#.*$/, "").trim();
  if (line.length === 0 || line.startsWith("#")) return null;

  const negated = line.startsWith("!");
  const body = negated ? line.slice(1).trim() : line;
  if (body.length === 0) return null;
  if (body.toLowerCase() === "private") return { negated, kind: "private", pattern: "private" };
  if (body.startsWith("@")) {
    const handle = body.slice(1);
    if (handle.length === 0) return null;
    // "@org/team" and "@org/*" are about the person; "@login" is one person.
    return handle.includes("/")
      ? { negated, kind: "membership", pattern: handle.toLowerCase() }
      : { negated, kind: "author", pattern: handle };
  }
  // A bare owner means every repo under it.
  return { negated, kind: "repo", pattern: body.includes("/") ? body : `${body}/*` };
}

export function parseTrustRules(lines: string[]): TrustRule[] {
  return lines.flatMap((line) => {
    const rule = parseTrustRule(line);
    return rule ? [rule] : [];
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
      return ctx.pushAccess && globToRegExp(rule.pattern).test(`${ctx.owner}/${ctx.repo}`);
    case "private":
      return ctx.pushAccess && ctx.isPrivate === true;
    case "author":
      return globToRegExp(rule.pattern).test(ctx.author);
    case "membership":
      return ctx.memberships?.has(rule.pattern) === true;
  }
}

/**
 * A denial must not depend on push access: `!acme/widgets` means "never run
 * this repo's PRs", and a fork PR is exactly the case you meant to stop.
 */
function denialMatches(rule: TrustRule, ctx: TrustContext): boolean {
  if (rule.kind === "repo") return globToRegExp(rule.pattern).test(`${ctx.owner}/${ctx.repo}`);
  if (rule.kind === "private") return ctx.isPrivate === true;
  return ruleMatches(rule, ctx);
}

export interface TrustDecision {
  trusted: boolean;
  /** The rule that decided it, for the log and the artifact. */
  reason: string;
}

export function decideTrust(rules: TrustRule[], ctx: TrustContext): TrustDecision {
  const denial = rules.find((rule) => rule.negated && denialMatches(rule, ctx));
  // describeRule, not a second copy of it: a team rule and a repo rule can read
  // identically once the "@" is dropped, and this string is the audit trail.
  if (denial) return { trusted: false, reason: `denied by ${describeRule(denial)}` };

  const grant = rules.find((rule) => !rule.negated && ruleMatches(rule, ctx));
  if (grant) return { trusted: true, reason: `trusted by ${describeRule(grant)}` };

  return { trusted: false, reason: "no trust rule matches" };
}

/** How a rule reads back to a human: what you typed, what the cockpit shows. */
export function describeRule(rule: TrustRule): string {
  const body = rule.kind === "author" || rule.kind === "membership" ? `@${rule.pattern}` : rule.pattern;
  return rule.negated ? `!${body}` : body;
}

/** Plain-English gloss for the cockpit, so a rule is never a mystery string. */
export function explainRule(rule: TrustRule): string {
  const subject = ruleSubject(rule);
  if (rule.negated) return `never runs commands: ${subject}`;
  // Repo-shaped rules only ever apply to someone who can push to the repo.
  const caveat = rule.kind === "repo" || rule.kind === "private" ? ", if pushed by someone with write access" : "";
  return `may run commands: ${subject}${caveat}`;
}

function ruleSubject(rule: TrustRule): string {
  switch (rule.kind) {
    case "private":
      return "PRs in any private repo";
    case "author":
      return `PRs authored by @${rule.pattern}`;
    case "membership": {
      const [org, team] = rule.pattern.split("/");
      return team === "*" ? `PRs authored by members of ${org}` : `PRs authored by the ${org}/${team} team`;
    }
    case "repo":
      return rule.pattern.endsWith("/*")
        ? `PRs in every repo in ${rule.pattern.slice(0, -2)}`
        : `PRs in ${rule.pattern}`;
  }
}

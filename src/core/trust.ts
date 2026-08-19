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

/** How a rule reads back to a human: what you typed, what the cockpit shows. */
export function describeRule(rule: TrustRule): string {
  const body = rule.kind === "author" ? `@${rule.pattern}` : rule.pattern;
  return rule.negated ? `!${body}` : body;
}

/** Plain-English gloss for the cockpit, so a rule is never a mystery string. */
export function explainRule(rule: TrustRule): string {
  const subject =
    rule.kind === "private"
      ? "any private repo"
      : rule.kind === "author"
        ? `PRs authored by @${rule.pattern}`
        : rule.pattern.endsWith("/*")
          ? `every repo in ${rule.pattern.slice(0, -2)}`
          : rule.pattern;
  return rule.negated ? `never runs commands: ${subject}` : `may run commands: ${subject}`;
}

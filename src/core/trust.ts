/**
 * Which PRs cerber is willing to review with its guard down.
 *
 * The default review is defensive: it can read the checkout and nothing else,
 * because a PR is code a stranger wrote. That is the wrong posture for a
 * colleague's PR, where you would happily run the tests yourself. A trusted
 * review may run commands — so trust is a statement about the *people*, and
 * you make it explicitly.
 *
 * Only people can be trusted here. There is deliberately no way to trust a
 * repository: anyone may open a PR against a public repo, so "trust this repo"
 * would quietly mean "trust whoever shows up". Name a person (`@login`), a
 * team (`@org/team`), or an org (`@org/*`).
 */
export interface TrustRule {
  /** A "!" rule: matches the same way, but denies. Denials win. */
  negated: boolean;
  /** `author` is one login (globs allowed); `membership` is "org/team" or "org/*". */
  kind: "author" | "membership";
  pattern: string;
}

export interface TrustContext {
  author: string;
  /** "org/team" and "org/*" keys this author belongs to, resolved from GitHub. */
  memberships?: ReadonlySet<string>;
}

/** A rule cerber won't accept, with the reason a person needs to fix it. */
export class TrustRuleError extends Error {
  constructor(
    readonly input: string,
    message: string,
  ) {
    super(message);
    this.name = "TrustRuleError";
  }
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

/**
 * One rule as a person writes it. Null when the line holds nothing (blank or a
 * comment); throws when it holds something cerber refuses to interpret, rather
 * than guessing at what a typo was meant to trust.
 */
export function parseTrustRule(input: string): TrustRule | null {
  // Trailing "# why we trust them" survives a hand-edited config.
  const line = input.replace(/\s+#.*$/, "").trim();
  if (line.length === 0 || line.startsWith("#")) return null;

  const negated = line.startsWith("!");
  const body = negated ? line.slice(1).trim() : line;

  if (/^(private|public)$/i.test(body)) {
    throw new TrustRuleError(
      input,
      `"${body}" is not a trust rule. A repo's visibility says nothing about who opened the PR — ` +
        `name the people who work in it: @org/* for everyone in the org, @org/team, or @login.`,
    );
  }

  if (!body.startsWith("@")) {
    const org = body.split("/")[0] || "org";
    throw new TrustRuleError(
      input,
      `"${body}" is not a trust rule. Trust is about people, not repositories — anyone can open ` +
        `a PR against a repo you own, so trusting the repo would trust them too. ` +
        `Use @${org}/* for everyone in that org, @${org}/team for one team, or @login for a person.`,
    );
  }

  const handle = body.slice(1);
  if (handle.length === 0 || handle === "/") {
    throw new TrustRuleError(input, `"${body}" names nobody. Use @login, @org/team, or @org/*.`);
  }
  if (handle.split("/").length > 2) {
    throw new TrustRuleError(
      input,
      `"${body}" is not a login, team, or org. Use @login, @org/team, or @org/*.`,
    );
  }

  return handle.includes("/")
    ? { negated, kind: "membership", pattern: handle.toLowerCase() }
    : { negated, kind: "author", pattern: handle };
}

export function parseTrustRules(lines: string[]): TrustRule[] {
  return lines.flatMap((line) => {
    const rule = parseTrustRule(line);
    return rule ? [rule] : [];
  });
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`, "i");
}

function ruleMatches(rule: TrustRule, ctx: TrustContext): boolean {
  return rule.kind === "author"
    ? globToRegExp(rule.pattern).test(ctx.author)
    : ctx.memberships?.has(rule.pattern) === true;
}

export interface TrustDecision {
  trusted: boolean;
  /** The rule that decided it, for the log and the artifact. */
  reason: string;
}

export function decideTrust(rules: TrustRule[], ctx: TrustContext): TrustDecision {
  const denial = rules.find((rule) => rule.negated && ruleMatches(rule, ctx));
  if (denial) return { trusted: false, reason: `denied by ${describeRule(denial)}` };

  const grant = rules.find((rule) => !rule.negated && ruleMatches(rule, ctx));
  if (grant) return { trusted: true, reason: `trusted by ${describeRule(grant)}` };

  return { trusted: false, reason: "no trust rule matches" };
}

/** How a rule reads back to a human: what you typed, what the cockpit shows. */
export function describeRule(rule: TrustRule): string {
  return `${rule.negated ? "!" : ""}@${rule.pattern}`;
}

/** Plain-English gloss for the cockpit, so a rule is never a mystery string. */
export function explainRule(rule: TrustRule): string {
  const subject = ruleSubject(rule);
  return rule.negated ? `never runs commands: ${subject}` : `may run commands: ${subject}`;
}

function ruleSubject(rule: TrustRule): string {
  if (rule.kind === "author") return `PRs authored by @${rule.pattern}`;
  const [org, team] = rule.pattern.split("/");
  return team === "*" ? `PRs authored by anyone in ${org}` : `PRs authored by the ${org}/${team} team`;
}

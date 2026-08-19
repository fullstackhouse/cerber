import { PrInfo } from "../core/artifact.js";

/** Keep the prompt within a sane context budget. */
export const MAX_DIFF_CHARS = 300_000;

export function buildReviewPrompt(pr: PrInfo, diff: string): { prompt: string; truncated: boolean } {
  const truncated = diff.length > MAX_DIFF_CHARS;
  const diffBody = truncated ? diff.slice(0, MAX_DIFF_CHARS) + "\n[... diff truncated ...]" : diff;

  const prompt = `You are an expert senior code reviewer. Review the following GitHub pull request.

Respond with ONLY a JSON object (no markdown fences, no prose before or after) matching exactly this shape:

{
  "summary": "markdown — what this PR actually does and why, written top-down: problem first in plain language, then the solution, then notable technical details. A reader should be able to stop after any paragraph with a correct, just less detailed, picture. 1-3 paragraphs.",
  "chapters": [
    {
      "id": "short-kebab-id",
      "title": "Human title of this logical group of changes",
      "explanation": "markdown — 2-3 plain sentences: what this group changes, why, and what to look at closely",
      "files": ["path/to/file.ts", "path/other.ts"]
    }
  ],
  "comments": [
    {
      "path": "path/to/file.ts",
      "line": 42,
      "body": "markdown — the review comment. First sentence states the problem plainly; then the evidence or fix. Concrete, actionable, kind.",
      "chapterId": "short-kebab-id"
    }
  ],
  "verdict": {
    "recommendation": "approve" | "comment" | "request_changes",
    "confidence": 0-100,
    "reasoning": "why this recommendation, and what makes you more/less sure"
  }
}

Writing style (applies to every markdown field):
- Write like one human explaining to another: plain words, short sentences, no jargon. Someone who has NOT read the diff should follow every sentence.
- Lead with the point. State the claim first, support it after. No hedging chains, no em-dash clause stacks.
- Keep comments to ~3 sentences unless a code suggestion needs more. Length must buy clarity, not cover uncertainty — if you are unsure, say so in one plain sentence.
- Do NOT imitate the PR description's writing style. Keep this plain register even when the PR itself is dense or writerly.
- Describe the effect a person would see before the mechanism behind it. Not: "A stray closing code fence with prose on the same line left the block open, rendering the conditions below as code." But: "Also fixes a markdown typo: a code block was never closed, so everything after it displayed as code."

Rules:
- Group ALL changed files into chapters that tell the story of the PR (schema first, then logic, then tests, etc). Every changed file must appear in exactly one chapter.
- "line" is the line number in the NEW version of the file (the "+" side of the diff). Use null for file-level comments. Only reference lines that appear in the diff.
- Only write comments that are worth a human reading: real bugs, risky patterns, missing tests, unclear naming. No nitpicks a linter would catch. An empty comments array is a perfectly good review of a clean PR.
- "confidence" reflects how sure you are the recommendation is right given what you can see. You only see the diff, not the full codebase — factor that in.
- Never invent files or lines not present in the diff.

## Pull request

Repo: ${pr.owner}/${pr.repo}
PR #${pr.number}: ${pr.title}
Author: ${pr.author}
Branch: ${pr.headRefName} -> ${pr.baseRefName}
Stats: ${pr.changedFiles} files, +${pr.additions} -${pr.deletions}

### Description

${pr.body || "(no description)"}

### Diff

\`\`\`diff
${diffBody}
\`\`\`
`;
  return { prompt, truncated };
}

export function buildRetryPrompt(originalPrompt: string, badOutput: string, error: string): string {
  return `${originalPrompt}

---
Your previous response could not be parsed as the required JSON.
Error: ${error}
Previous response (truncated): ${badOutput.slice(0, 2_000)}

Respond again with ONLY the valid JSON object described above.`;
}

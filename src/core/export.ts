import { Artifact, Comment } from "./artifact.js";

/** Same convention as Send: the grade travels in the text, ungraded stays bare. */
function grade(c: Comment): string {
  return c.severity ? `**${c.severity}:** ` : "";
}

/** Render an artifact as a standalone markdown review document. */
export function toMarkdown(artifact: Artifact): string {
  const lines: string[] = [];
  const { pr, verdict } = artifact;

  lines.push(`# Review: ${artifact.id} — ${pr.title}`);
  lines.push("");
  lines.push(`> ${pr.url}`);
  lines.push(`> ${pr.author} · \`${pr.headRefName}\` → \`${pr.baseRefName}\` · ${pr.changedFiles} files +${pr.additions} -${pr.deletions}`);
  lines.push("");

  if (verdict) {
    lines.push(`**Verdict: ${verdict.recommendation.replace("_", " ")}** (confidence ${verdict.confidence}%)`);
    lines.push("");
    lines.push(verdict.reasoning);
    lines.push("");
  }

  lines.push("## Summary");
  lines.push("");
  lines.push(artifact.summary || "(no summary)");
  lines.push("");

  if (artifact.chapters.length > 0) {
    lines.push("## Walkthrough");
    lines.push("");
    for (const ch of artifact.chapters) {
      lines.push(`### ${ch.title}`);
      lines.push("");
      lines.push(ch.explanation);
      lines.push("");
      lines.push(ch.files.map((f) => `- \`${f}\``).join("\n"));
      lines.push("");
      const comments = artifact.comments.filter((c) => c.chapterId === ch.id && c.status !== "dropped");
      for (const c of comments) {
        lines.push(`> **${c.path}${c.line != null ? `:${c.line}` : ""}** — ${grade(c)}${c.body.replace(/\n/g, "\n> ")}`);
        lines.push("");
      }
    }
  }

  const orphans = artifact.comments.filter(
    (c) =>
      c.status !== "dropped" &&
      (!c.chapterId || !artifact.chapters.some((ch) => ch.id === c.chapterId)),
  );
  if (orphans.length > 0) {
    lines.push("## Other comments");
    lines.push("");
    for (const c of orphans) {
      lines.push(`> **${c.path}${c.line != null ? `:${c.line}` : ""}** — ${c.body.replace(/\n/g, "\n> ")}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

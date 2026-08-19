import { ClaudeEvent } from "./claude.js";

/**
 * Turning a run's own events into a line a human can read while they wait.
 *
 * A review or a chat turn takes minutes, and until now the only honest thing
 * cerber could say about that time was "thinking…". The run already narrates
 * itself — what it is about to read, what it concluded, what it was refused —
 * so this says that instead, in the same plain words the review itself uses:
 * what happened, not the wire format it happened in.
 *
 * Ignoring is the default. An event we don't recognise, and anything that would
 * leak the machinery (the JSON answer, tool results, session bookkeeping),
 * returns null and never reaches the user.
 *
 * Pure: no I/O, no clock.
 */

/** How much of any one line survives. Long enough to be useful in a sidebar. */
const MAX = 180;

export function describeEvent(event: ClaudeEvent): string[] {
  if (event.type === "assistant") {
    return (event.message?.content ?? []).flatMap((block) => {
      if (block.type === "thinking") return ["thinking…"];
      if (block.type === "text") {
        const text = (block.text ?? "").trim();
        // The turn's answer is a JSON object; showing it raw would put the
        // machinery on screen a second before the rendered version lands.
        if (!text || looksLikeJson(text)) return [];
        return [clip(collapse(text))];
      }
      if (block.type === "tool_use") return [describeTool(block.name ?? "", block.input ?? {})];
      return [];
    });
  }
  // Cerber denies most tools on purpose. When the run reaches for one anyway,
  // saying so beats a silent gap in the story.
  if (event.type === "system" && event.subtype === "permission_denied") {
    const tool = typeof event.tool_name === "string" ? event.tool_name : "a tool";
    return [`not allowed to use ${tool}`];
  }
  return [];
}

function describeTool(name: string, input: Record<string, unknown>): string {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  switch (name) {
    case "Read": {
      const file = short(str("file_path"));
      return file ? `reading ${file}` : "reading a file";
    }
    case "Grep": {
      const where = short(str("path"));
      return clip(`searching for ${str("pattern")}${where ? ` in ${where}` : ""}`);
    }
    case "Glob":
      return clip(`looking for files matching ${str("pattern")}`);
    case "Bash": {
      // The description is the model's own words for what it is about to run;
      // the command is what it will actually do. The command is the honest one.
      const command = collapse(str("command"));
      return command ? clip(`running ${command}`) : "running a command";
    }
    case "WebSearch":
      return clip(`searching the web for ${str("query")}`);
    case "WebFetch":
      return clip(`fetching ${str("url")}`);
    case "TodoWrite":
      return "planning the rest of the turn";
    default:
      return name ? `using ${name}` : "using a tool";
  }
}

/** Paths in a checkout are absolute and long; the repo-relative tail is the useful part. */
function short(file: string): string {
  if (!file) return "";
  const parts = file.split("/").filter(Boolean);
  return parts.length > 3 ? parts.slice(-3).join("/") : file;
}

function looksLikeJson(text: string): boolean {
  return text.startsWith("{") || text.startsWith("```");
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string): string {
  return text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text;
}

import { spawn } from "node:child_process";

export interface ClaudeResult {
  text: string;
  costUsd: number | null;
  model: string | null;
}

export interface ClaudeOptions {
  model?: string;
  /** Defaults to the `claude` on PATH. */
  bin?: string;
  /**
   * Directory the run sees as its workspace. Without one the run inherits
   * cerber's own cwd, where any file it read would belong to the wrong repo.
   */
  cwd?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  /**
   * Refuse to be configured by the working directory. `claude -p` skips the
   * workspace-trust prompt, so a PR carrying hooks or MCP servers would
   * otherwise get to run code on the reviewer's machine.
   */
  isolateWorkspace?: boolean;
  /** Kill the run after this long. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Generous, but finite: a wedged `claude` would otherwise hold the inflight
 * claim for that PR forever, and no re-review could ever start.
 */
export const DEFAULT_TIMEOUT_MS = 30 * 60_000;

export function buildClaudeArgs(opts: ClaudeOptions): string[] {
  const args = ["-p", "--output-format", "json"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.allowedTools?.length) args.push("--allowedTools", opts.allowedTools.join(","));
  if (opts.disallowedTools?.length) args.push("--disallowedTools", opts.disallowedTools.join(","));
  if (opts.isolateWorkspace) {
    args.push("--strict-mcp-config", "--settings", JSON.stringify({ disableAllHooks: true }));
  }
  return args;
}

/**
 * Run `claude -p` headless with the prompt on stdin, return the result text.
 * Rides the user's existing Claude Code login — no API key handling here.
 */
export function runClaude(prompt: string, opts: ClaudeOptions = {}): Promise<ClaudeResult> {
  const args = buildClaudeArgs(opts);

  return new Promise((resolve, reject) => {
    const child = spawn(opts.bin ?? "claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.cwd,
    });
    let stdout = "";
    let stderr = "";
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start claude CLI: ${err.message}. Is Claude Code installed and on PATH?`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`claude did not finish within ${Math.round(timeoutMs / 60_000)} minutes — run killed.`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr.trim() || stdout.slice(0, 500)}`));
        return;
      }
      try {
        const wrapper = JSON.parse(stdout);
        resolve({
          text: wrapper.result ?? "",
          costUsd: typeof wrapper.total_cost_usd === "number" ? wrapper.total_cost_usd : null,
          model: wrapper.modelUsage ? Object.keys(wrapper.modelUsage)[0] ?? null : null,
        });
      } catch {
        reject(new Error(`Could not parse claude output as JSON wrapper: ${stdout.slice(0, 500)}`));
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Extract a JSON object from model output that may be wrapped in fences or prose. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Fast path: it's already pure JSON.
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]!.trim());
    } catch {
      // fall through
    }
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    return JSON.parse(trimmed.slice(first, last + 1));
  }
  throw new Error("No JSON object found in model output");
}

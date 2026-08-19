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

/** How long a killed run gets to exit on its own before SIGKILL. */
const SIGKILL_GRACE_MS = 5_000;

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
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      // Escalate: a run that ignores SIGTERM would otherwise sit there holding
      // a checkout and burning quota. Unref'd so it never delays our exit.
      setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS).unref();
      // Settle now rather than on "close". Node only emits close once the
      // child's stdio is fully closed, and anything the run spawned still
      // holds those pipes — waiting for it is the wedge we came to prevent.
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      settle(() =>
        reject(new Error(`claude did not finish within ${Math.round(timeoutMs / 60_000)} minutes — run killed.`)),
      );
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      settle(() =>
        reject(new Error(`Failed to start claude CLI: ${err.message}. Is Claude Code installed and on PATH?`)),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
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

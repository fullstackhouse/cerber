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
}

/**
 * Run `claude -p` headless with the prompt on stdin, return the result text.
 * Rides the user's existing Claude Code login — no API key handling here.
 */
export function runClaude(prompt: string, opts: ClaudeOptions = {}): Promise<ClaudeResult> {
  const args = ["-p", "--output-format", "json"];
  if (opts.model) args.push("--model", opts.model);

  return new Promise((resolve, reject) => {
    const child = spawn(opts.bin ?? "claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) =>
      reject(new Error(`Failed to start claude CLI: ${err.message}. Is Claude Code installed and on PATH?`)),
    );
    child.on("close", (code) => {
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

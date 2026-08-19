import { spawn } from "node:child_process";

export interface ClaudeResult {
  text: string;
  costUsd: number | null;
  model: string | null;
  /**
   * The session this run belongs to. Handed back so a later run can re-enter it
   * with {@link ClaudeOptions.resumeSessionId} instead of rebuilding the context
   * from scratch — the difference between an agent that remembers reading a file
   * and one that only ever saw the diff.
   */
  sessionId: string | null;
}

/**
 * One line of `claude --output-format stream-json` — the run narrating itself
 * as it goes: what it is about to read, what it just decided, what it cost.
 *
 * Deliberately loose. This is the CLI's wire format, not cerber's schema: a new
 * event type must be something we ignore, never something that fails a review.
 */
export interface ClaudeEvent {
  type: string;
  subtype?: string;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
      name?: string;
      input?: Record<string, unknown>;
      is_error?: boolean;
    }>;
  };
  [key: string]: unknown;
}

export interface ClaudeOptions {
  model?: string;
  /** Defaults to the `claude` on PATH. */
  bin?: string;
  /**
   * Called for each event as the run emits it. A review or a chat turn takes
   * minutes; this is the only way to say what it is doing while it does it,
   * rather than making the user watch a spinner and hope.
   */
  onEvent?: (event: ClaudeEvent) => void;
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
  /**
   * Continue an earlier run's session rather than starting a fresh one. The
   * session keeps everything that run read, so a follow-up can answer "which
   * claim did you actually check?" instead of re-deriving an opinion.
   *
   * Sessions are keyed by the working directory they were created in: resuming
   * with a different (or deleted) `cwd` keeps the transcript but leaves the
   * run unable to open the files it is talking about. Callers must keep the
   * checkout alive, or say plainly in the prompt that it is gone.
   */
  resumeSessionId?: string;
  /**
   * Take GitHub write access away from the run. A trusted review gets `Bash`,
   * and cerber's promise is that nothing reaches GitHub except an explicit
   * Send — so the run must not merely be *told* not to push, it must have
   * nothing to push with.
   */
  /** Environment for the run. Defaults to cerber's own. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Environment that leaves a run unable to authenticate to GitHub: no gh config
 * to read a token from, no token in the environment, and no git config that
 * could supply a credential helper. Reading the checkout and running its tests
 * need none of these.
 */
export function unauthenticatedEnv(base: NodeJS.ProcessEnv, emptyDir: string): NodeJS.ProcessEnv {
  return {
    ...base,
    GH_CONFIG_DIR: emptyDir,
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    GH_ENTERPRISE_TOKEN: "",
    GITHUB_ENTERPRISE_TOKEN: "",
    GIT_CONFIG_GLOBAL: "/dev/null",
    // NOSYSTEM, not GIT_CONFIG_SYSTEM: on macOS git also reads a config shipped
    // with the Command Line Tools, which sets credential.helper=osxkeychain and
    // survives GIT_CONFIG_SYSTEM. Measured — a push still succeeded without it.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    // https is not the only way out: a run could point the remote at
    // git@github.com and ride the user's keys. No agent, no ~/.ssh/config, and
    // no default identity — IdentitiesOnly alone still permits ssh's built-in
    // key paths, which authenticated in testing.
    SSH_AUTH_SOCK: "",
    SSH_ASKPASS: "",
    GIT_SSH_COMMAND: NO_IDENTITY_SSH,
  };
}

/** `ssh` with nothing to authenticate as: no agent, no config, no identity. */
const NO_IDENTITY_SSH =
  "ssh -F /dev/null -o IdentitiesOnly=yes -o IdentityAgent=none -o IdentityFile=/dev/null -o BatchMode=yes";

/**
 * Generous, but finite: a wedged `claude` would otherwise hold the inflight
 * claim for that PR forever, and no re-review could ever start.
 */
export const DEFAULT_TIMEOUT_MS = 30 * 60_000;

/** How long a killed run gets to exit on its own before SIGKILL. */
const SIGKILL_GRACE_MS = 5_000;

export function buildClaudeArgs(opts: ClaudeOptions): string[] {
  // stream-json, not json: the same final result arrives in the closing event,
  // and everything before it is the run saying what it is doing. `--verbose` is
  // not optional — the CLI refuses the combination without it.
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  if (opts.model) args.push("--model", opts.model);
  if (opts.allowedTools?.length) args.push("--allowedTools", opts.allowedTools.join(","));
  if (opts.disallowedTools?.length) args.push("--disallowedTools", opts.disallowedTools.join(","));
  if (opts.isolateWorkspace) {
    args.push("--strict-mcp-config", "--settings", JSON.stringify({ disableAllHooks: true }));
  }
  return args;
}

/**
 * Split a stream-json stdout chunk into whole events, keeping whatever trailing
 * fragment has not been terminated yet. A tool result can be megabytes, so a
 * single event routinely arrives across several chunks.
 */
export function readEvents(buffer: string): { events: ClaudeEvent[]; rest: string } {
  const lines = buffer.split("\n");
  // The last piece has no newline after it — it may be half an event.
  const rest = lines.pop() ?? "";
  const events: ClaudeEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
        events.push(parsed as ClaudeEvent);
      }
    } catch {
      // A line we can't parse is a line we don't need — the run's own result
      // comes from the closing event, and dying here would throw away a
      // finished review over a stray byte.
    }
  }
  return { events, rest };
}

/**
 * Run `claude -p` headless with the prompt on stdin, return the result text.
 * Rides the user's existing Claude Code login — no API key handling here.
 *
 * Reads the run as a stream so {@link ClaudeOptions.onEvent} can report what it
 * is doing while it does it; the result itself is the closing event.
 */
export function runClaude(prompt: string, opts: ClaudeOptions = {}): Promise<ClaudeResult> {
  const args = buildClaudeArgs(opts);

  return new Promise((resolve, reject) => {
    const child = spawn(opts.bin ?? "claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.cwd,
      env: opts.env,
    });
    let unread = "";
    let result: ClaudeEvent | null = null;
    /** Kept only to explain a failure — the events carry everything we use. */
    let tail = "";
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

    const ingest = (chunk: string) => {
      const read = readEvents(unread + chunk);
      unread = read.rest;
      for (const event of read.events) {
        if (event.type === "result") result = event;
        // A throwing listener must not take the run down with it: the answer is
        // the point, the narration is not.
        try {
          opts.onEvent?.(event);
        } catch {
          // ignore
        }
      }
    };

    child.stdout.on("data", (d) => {
      tail = (tail + d).slice(-2_000);
      ingest(String(d));
    });
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
        reject(new Error(`claude exited with code ${code}: ${stderr.trim() || tail.slice(-500)}`));
        return;
      }
      // The last line need not be newline-terminated, and it is the one that
      // matters: dropping it would throw away a finished review for the want
      // of a trailing byte.
      ingest("\n");
      const wrapper = result as (ClaudeEvent & Record<string, unknown>) | null;
      if (!wrapper) {
        reject(new Error(`claude produced no result event: ${tail.slice(-500)}`));
        return;
      }
      resolve({
        text: typeof wrapper.result === "string" ? wrapper.result : "",
        costUsd: typeof wrapper.total_cost_usd === "number" ? wrapper.total_cost_usd : null,
        model: wrapper.modelUsage ? Object.keys(wrapper.modelUsage as object)[0] ?? null : null,
        sessionId: typeof wrapper.session_id === "string" ? wrapper.session_id : null,
      });
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

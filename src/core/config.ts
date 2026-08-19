import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { cerberHome } from "./state.js";
import { TrustRuleError, parseTrustRule } from "./trust.js";

/**
 * `~/.cerber/config.json` — everything cerber lets you decide, in one file the
 * cockpit can write and you can still edit by hand. Absent means defaults, so
 * "no config" stays a working state.
 *
 * Rules stay one-line strings rather than objects: the same syntax you type at
 * `cerber trust`, readable in a diff, and short enough to explain in a tooltip.
 */
export const ConfigSchema = z.object({
  /** Whose PRs may be reviewed by running code. See core/trust.ts for syntax. */
  trust: z
    .array(z.string())
    .default([])
    // Checked here so a rule cerber cannot honour is caught when you write it,
    // not silently ignored until you wonder why a review never runs anything.
    .superRefine((lines, ctx) => {
      lines.forEach((line, index) => {
        try {
          parseTrustRule(line);
        } catch (err: unknown) {
          if (!(err instanceof TrustRuleError)) throw err;
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: err.message });
        }
      });
    }),
});
export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = { trust: [] };

export function configPath(): string {
  return path.join(cerberHome(), "config.json");
}

export async function loadConfig(): Promise<Config> {
  const raw = await fs.readFile(configPath(), "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });

  if (raw === null) return { ...DEFAULT_CONFIG };

  try {
    return ConfigSchema.parse(JSON.parse(raw));
  } catch (err: unknown) {
    // A hand-edited file with a typo shouldn't silently turn trust off — that
    // would be a quiet security change in the *safe* direction, but a review
    // would then behave differently for reasons nobody can see. So: stop, and
    // say which entry is wrong in the words the person needs, not as a dump.
    throw new Error(`${configPath()} is not valid cerber config:\n${describeConfigError(err)}`);
  }
}

function describeConfigError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues
      .map((issue) => `  ${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`)
      .join("\n");
  }
  if (err instanceof SyntaxError) return `  not JSON — ${err.message}`;
  return `  ${err instanceof Error ? err.message : String(err)}`;
}

/** Write atomically — the cockpit and a `cerber trust` can both be writing. */
export async function saveConfig(config: Config): Promise<string> {
  const file = configPath();
  await fs.mkdir(cerberHome(), { recursive: true });
  const tmp = `${file}.tmp`;
  let validated: Config;
  try {
    validated = ConfigSchema.parse(config);
  } catch (err: unknown) {
    throw new Error(describeConfigError(err).trim());
  }
  await fs.writeFile(tmp, JSON.stringify(validated, null, 2) + "\n");
  await fs.rename(tmp, file);
  return file;
}

import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { cerberHome } from "./state.js";
import { describeRule, parseTrustRules } from "./trust.js";

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
  trust: z.array(z.string()).default([]),
});
export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = { trust: [] };

export function configPath(): string {
  return path.join(cerberHome(), "config.json");
}

/** The pre-JSON trust file. Still read, never written. */
function legacyTrustPath(): string {
  return path.join(cerberHome(), "trusted.txt");
}

export async function loadConfig(): Promise<Config> {
  const raw = await fs.readFile(configPath(), "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });

  if (raw === null) {
    // Nothing yet: fall back to a trusted.txt from before config.json existed.
    const legacy = await fs.readFile(legacyTrustPath(), "utf8").catch(() => null);
    if (legacy === null) return { ...DEFAULT_CONFIG };
    return { trust: parseTrustRules(legacy).map(describeRule) };
  }

  try {
    return ConfigSchema.parse(JSON.parse(raw));
  } catch (err: unknown) {
    // A hand-edited file with a typo shouldn't silently turn trust off — that
    // would be a quiet security change in the *safe* direction, but a review
    // would then behave differently for reasons nobody can see.
    throw new Error(
      `${configPath()} is not valid cerber config: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** Write atomically — the cockpit and a `cerber trust` can both be writing. */
export async function saveConfig(config: Config): Promise<string> {
  const file = configPath();
  await fs.mkdir(cerberHome(), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(ConfigSchema.parse(config), null, 2) + "\n");
  await fs.rename(tmp, file);
  return file;
}

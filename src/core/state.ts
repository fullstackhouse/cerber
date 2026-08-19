import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Artifact, ArtifactSchema, artifactKey } from "./artifact.js";

export function cerberHome(): string {
  return process.env.CERBER_HOME ?? path.join(os.homedir(), ".cerber");
}

function reviewsDir(): string {
  return path.join(cerberHome(), "reviews");
}

function artifactPath(id: string): string {
  return path.join(reviewsDir(), `${artifactKey(id)}.json`);
}

export async function saveArtifact(artifact: Artifact): Promise<string> {
  await fs.mkdir(reviewsDir(), { recursive: true });
  const file = artifactPath(artifact.id);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(artifact, null, 2));
  await fs.rename(tmp, file);
  return file;
}

export async function loadArtifact(id: string): Promise<Artifact | null> {
  try {
    const raw = await fs.readFile(artifactPath(id), "utf8");
    return ArtifactSchema.parse(JSON.parse(raw));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function loadArtifactByKey(key: string): Promise<Artifact | null> {
  try {
    const raw = await fs.readFile(path.join(reviewsDir(), `${key}.json`), "utf8");
    return ArtifactSchema.parse(JSON.parse(raw));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export interface AutoSendLogEntry {
  at: string;
  id: string;
  recommendation: string | null;
  confidence: number | null;
  mode: "shadow" | "on";
  decision: string;
  sent: boolean;
}

/** Append to ~/.cerber/autosend.ndjson — the shadow/auto-send audit log. */
export async function appendAutoSendLog(entry: AutoSendLogEntry): Promise<void> {
  await fs.mkdir(cerberHome(), { recursive: true });
  await fs.appendFile(path.join(cerberHome(), "autosend.ndjson"), JSON.stringify(entry) + "\n");
}

export async function readAutoSendLog(): Promise<AutoSendLogEntry[]> {
  try {
    const raw = await fs.readFile(path.join(cerberHome(), "autosend.ndjson"), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as AutoSendLogEntry];
        } catch {
          return [];
        }
      });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Load by key, apply a mutation, bump updatedAt, save. Returns the new artifact. */
export async function updateArtifactByKey(
  key: string,
  mutate: (artifact: Artifact) => Artifact,
): Promise<Artifact | null> {
  const artifact = await loadArtifactByKey(key);
  if (!artifact) return null;
  const updated = { ...mutate(artifact), updatedAt: new Date().toISOString() };
  await saveArtifact(updated);
  return updated;
}

export async function listArtifacts(): Promise<Artifact[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(reviewsDir());
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const artifacts: Artifact[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(reviewsDir(), entry), "utf8");
      artifacts.push(ArtifactSchema.parse(JSON.parse(raw)));
    } catch {
      // Skip corrupt files rather than breaking the whole listing.
    }
  }
  artifacts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return artifacts;
}

import { mkdtempSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { configPath, loadConfig } from "../core/config.js";
import { buildApp } from "./index.js";

const home = mkdtempSync(path.join(os.tmpdir(), "cerber-config-route-"));
process.env.CERBER_HOME = home;

async function setRepo(repo: unknown, on: unknown) {
  const app = await buildApp({});
  return app.request("/api/config/auto-review-repo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, on }),
  });
}

const writeConfig = async (daemon: Record<string, unknown>) => {
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify({ daemon }));
};

describe("POST /api/config/auto-review-repo", () => {
  beforeEach(async () => {
    await fs.rm(configPath(), { force: true });
  });

  it("sets, replaces across case, and removes one exception", async () => {
    expect((await setRepo("Acme/Web", false)).status).toBe(200);
    expect((await loadConfig()).daemon.autoReviewRepos).toEqual({ "Acme/Web": false });

    const res = await setRepo("acme/web", true);
    expect(((await res.json()) as { daemon: { autoReviewRepos: unknown } }).daemon.autoReviewRepos).toEqual({
      "acme/web": true,
    });

    expect((await setRepo("ACME/WEB", null)).status).toBe(200);
    expect((await loadConfig()).daemon.autoReviewRepos).toEqual({});
  });

  // The cockpit sends one repo, not the map it loaded, so an exception written
  // since — by a second tab, or by hand — survives the edit.
  it("keeps an exception written after the cockpit loaded", async () => {
    await writeConfig({ autoReviewRepos: { "acme/infra": false } });
    expect((await setRepo("acme/web", false)).status).toBe(200);
    expect((await loadConfig()).daemon.autoReviewRepos).toEqual({ "acme/infra": false, "acme/web": false });
  });

  it("refuses a key that is not owner/repo and leaves the file alone", async () => {
    await writeConfig({ autoReviewRepos: { "acme/infra": false } });
    const before = await fs.readFile(configPath(), "utf8");
    const res = await setRepo("acme", false);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/expected owner\/repo/);
    expect(await fs.readFile(configPath(), "utf8")).toBe(before);
  });

  it("refuses a body that is not a repo and a true/false/null", async () => {
    expect((await setRepo("", true)).status).toBe(400);
    expect((await setRepo("acme/web", "yes")).status).toBe(400);
  });
});

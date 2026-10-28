import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadConfig, saveConfig } from "./config.js";

describe("config", () => {
  let home: string;
  const previousHome = process.env.CERBER_HOME;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "cerber-config-"));
    process.env.CERBER_HOME = home;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.CERBER_HOME;
    else process.env.CERBER_HOME = previousHome;
    await fs.rm(home, { recursive: true, force: true });
  });

  const DEFAULT_DAEMON = {
    poll: true,
    autoReview: true,
    autoReviewRepos: {},
    notify: true,
    intervalMinutes: 5,
    parallel: 3,
    repos: [],
    ownPrMaxAgeDays: 30,
  };

  it("trusts nobody and runs the full inbox when there is no config at all", async () => {
    expect(await loadConfig()).toEqual({ trust: [], daemon: DEFAULT_DAEMON });
  });

  it("leaves your own PRs past 30 days out by default, and takes 0 or null for off", async () => {
    await fs.mkdir(home, { recursive: true });
    for (const off of [0, null]) {
      await fs.writeFile(configPath(), JSON.stringify({ daemon: { ownPrMaxAgeDays: off } }));
      expect((await loadConfig()).daemon.ownPrMaxAgeDays).toBe(off);
    }
    await fs.writeFile(configPath(), '{"daemon": {"ownPrMaxAgeDays": -1}}');
    await expect(loadConfig()).rejects.toThrow();
  });

  it("refuses a poll interval past a day, which setTimeout would turn into non-stop polling", async () => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(configPath(), '{"daemon": {"intervalMinutes": 1440}}');
    expect((await loadConfig()).daemon.intervalMinutes).toBe(1440);
    await fs.writeFile(configPath(), '{"daemon": {"intervalMinutes": 99999}}');
    await expect(loadConfig()).rejects.toThrow(/intervalMinutes/);
  });

  it("keeps an inbox knob a hand-edit flipped, defaulting the rest", async () => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(configPath(), '{"daemon": {"autoReview": false}}');
    expect((await loadConfig()).daemon).toEqual({ ...DEFAULT_DAEMON, autoReview: false });
  });

  it("keeps per-repo auto-review exceptions", async () => {
    await saveConfig({ daemon: { autoReviewRepos: { "acme/infra": false, "acme/web": true } } });
    expect((await loadConfig()).daemon.autoReviewRepos).toEqual({ "acme/infra": false, "acme/web": true });
  });

  it("refuses an auto-review exception that is not owner/repo", async () => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(configPath(), '{"daemon": {"autoReviewRepos": {"acme": false}}}');
    await expect(loadConfig()).rejects.toThrow(/autoReviewRepos.acme: expected owner\/repo/);
  });

  it("refuses two spellings of one repo, since the match ignores case", async () => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(configPath(), '{"daemon": {"autoReviewRepos": {"Acme/Web": true, "acme/web": false}}}');
    await expect(loadConfig()).rejects.toThrow(/autoReviewRepos.acme\/web: same repo as Acme\/Web/);
  });

  it("round-trips what the cockpit writes", async () => {
    await saveConfig({ trust: ["@acme/*", "@someone", "!@acme/contractors"] });
    expect((await loadConfig()).trust).toEqual(["@acme/*", "@someone", "!@acme/contractors"]);
  });

  it("writes JSON a human can still read and edit", async () => {
    await saveConfig({ trust: ["@acme/*"] });
    const raw = await fs.readFile(configPath(), "utf8");
    expect(JSON.parse(raw)).toEqual({ trust: ["@acme/*"], daemon: DEFAULT_DAEMON });
    // Pretty-printed, trailing newline — the file stays diffable and editable.
    expect(raw).toMatch(/^\{\n {2}"trust": \[\n {4}"@acme\/\*"\n {2}\],\n/);
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("rejects a repo-shaped rule on the way in, with the fix in the message", async () => {
    await expect(saveConfig({ trust: ["acme/widgets"] })).rejects.toThrow(
      /Trust is about people, not repositories/,
    );
  });

  it("refuses to load a config someone hand-edited a repo rule into", async () => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(configPath(), '{"trust": ["@acme/*", "acme/widgets"]}');
    await expect(loadConfig()).rejects.toThrow(/not valid cerber config/);
  });

  it("refuses a malformed config instead of silently reverting to defaults", async () => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(configPath(), '{"trust": "fullstackhouse"}');
    await expect(loadConfig()).rejects.toThrow(/not valid cerber config/);
  });
});

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
    notify: true,
    intervalMinutes: 5,
    parallel: 3,
    repos: [],
  };

  it("trusts nobody and runs the full inbox when there is no config at all", async () => {
    expect(await loadConfig()).toEqual({ trust: [], daemon: DEFAULT_DAEMON });
  });

  it("keeps an inbox knob a hand-edit flipped, defaulting the rest", async () => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(configPath(), '{"daemon": {"autoReview": false}}');
    expect((await loadConfig()).daemon).toEqual({ ...DEFAULT_DAEMON, autoReview: false });
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

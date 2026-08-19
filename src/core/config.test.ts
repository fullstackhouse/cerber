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

  it("trusts nobody when there is no config at all", async () => {
    expect(await loadConfig()).toEqual({ trust: [] });
  });

  it("round-trips what the cockpit writes", async () => {
    await saveConfig({ trust: ["acme", "@someone", "!acme/fork"] });
    expect((await loadConfig()).trust).toEqual(["acme", "@someone", "!acme/fork"]);
  });

  it("writes JSON a human can still read and edit", async () => {
    await saveConfig({ trust: ["acme"] });
    const raw = await fs.readFile(configPath(), "utf8");
    expect(raw).toBe('{\n  "trust": [\n    "acme"\n  ]\n}\n');
  });

  it("refuses a malformed config instead of silently reverting to defaults", async () => {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(configPath(), '{"trust": "fullstackhouse"}');
    await expect(loadConfig()).rejects.toThrow(/not valid cerber config/);
  });
});

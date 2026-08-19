import { describe, expect, it } from "vitest";
import { prepareCheckout, sourceDir } from "./checkout.js";

const ref = { owner: "acme", repo: "widgets", number: 42 };

function fakeGit(existing: boolean, present: string[] = []) {
  const calls: string[][] = [];
  const renamed: [string, string][] = [];
  return {
    calls,
    renamed,
    deps: {
      git: async (args: string[]) => {
        calls.push(args);
        return args[0] === "rev-parse" ? "abc1234\n" : "";
      },
      isRepo: async () => existing,
      mkdir: async () => {},
      quarantine: async (from: string, to: string) => {
        if (!present.some((p) => from.endsWith(p))) return false;
        renamed.push([from, to]);
        return true;
      },
    },
  };
}

describe("sourceDir", () => {
  it("gives each PR its own directory so parallel reviews cannot fight", () => {
    expect(sourceDir(ref)).not.toBe(sourceDir({ ...ref, number: 43 }));
    expect(sourceDir(ref)).toContain("acme__widgets__42");
  });
});

describe("prepareCheckout", () => {
  it("initialises a fresh clone that rides gh auth, then checks out the PR head", async () => {
    const { calls, deps } = fakeGit(false);
    const checkout = await prepareCheckout(ref, { deps });

    expect(calls[0]).toEqual(["init", "-q"]);
    expect(calls[1]).toEqual([
      "remote",
      "add",
      "origin",
      "https://github.com/acme/widgets.git",
    ]);
    expect(calls[2]).toEqual(["config", "credential.helper", "!gh auth git-credential"]);
    expect(checkout.sha).toBe("abc1234");
    expect(checkout.dir).toBe(sourceDir(ref));
  });

  it("reuses an existing clone instead of re-initialising it", async () => {
    const { calls, deps } = fakeGit(true);
    await prepareCheckout(ref, { deps });
    expect(calls.map((c) => c[0])).toEqual(["fetch", "checkout", "clean", "rev-parse"]);
  });

  it("fetches the pull ref shallowly, so fork PRs resolve without extra remotes", async () => {
    const { calls, deps } = fakeGit(true);
    await prepareCheckout(ref, { deps });
    expect(calls[0]).toEqual([
      "fetch",
      "-q",
      "--depth=1",
      "--no-tags",
      "origin",
      "refs/pull/42/head",
    ]);
  });

  it("wipes untracked leftovers from a previous head", async () => {
    const { calls, deps } = fakeGit(true);
    await prepareCheckout(ref, { deps });
    expect(calls).toContainEqual(["clean", "-qfdx"]);
  });

  it("moves agent config the PR ships out of the reviewer's way, keeping it readable", async () => {
    const { renamed, deps } = fakeGit(true, [".claude/settings.json", ".mcp.json"]);
    await prepareCheckout(ref, { deps });

    expect(renamed.map(([from]) => from.replace(sourceDir(ref) + "/", ""))).toEqual([
      ".claude/settings.json",
      ".mcp.json",
    ]);
    // Renamed in place, not deleted: the reviewer can still read and comment on it.
    for (const [from, to] of renamed) expect(to).toBe(from + ".cerber-quarantined");
  });

  it("says nothing about agent config the PR does not ship", async () => {
    const { renamed, deps } = fakeGit(true);
    await prepareCheckout(ref, { deps });
    expect(renamed).toEqual([]);
  });
});

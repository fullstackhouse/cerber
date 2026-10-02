import { describe, expect, it } from "vitest";
import { MAX_RECENT, isLogin, nextRecent, parseRecent } from "./handoff";

describe("isLogin", () => {
  it("takes what GitHub takes", () => {
    expect(isLogin("maks")).toBe(true);
    expect(isLogin("a")).toBe(true);
    expect(isLogin("jtomaszewski")).toBe(true);
    expect(isLogin("dependabot-preview")).toBe(true);
  });

  it("refuses what would reach GitHub as something else", () => {
    // A team is a different request entirely, and the rest would be a write
    // built from whatever happened to be in the box.
    expect(isLogin("acme/reviewers")).toBe(false);
    expect(isLogin("@maks")).toBe(false);
    expect(isLogin("-maks")).toBe(false);
    expect(isLogin("maks-")).toBe(false);
    expect(isLogin("")).toBe(false);
    expect(isLogin("two words")).toBe(false);
  });
});

describe("parseRecent", () => {
  it("reads back what was stored", () => {
    expect(parseRecent(JSON.stringify(["maks", "ewa"]))).toEqual(["maks", "ewa"]);
  });

  it("leaves the box empty rather than putting nonsense in front of a write", () => {
    // Hand-editable like everything else cerber keeps, so every shape it could
    // be edited into has to land somewhere harmless.
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent("")).toEqual([]);
    expect(parseRecent("not json")).toEqual([]);
    expect(parseRecent('"maks"')).toEqual([]);
    expect(parseRecent(JSON.stringify({ to: "maks" }))).toEqual([]);
    expect(parseRecent(JSON.stringify(["maks", 7, null, "acme/team"]))).toEqual(["maks"]);
  });

  it("caps a list that grew past the cap by hand", () => {
    const many = Array.from({ length: MAX_RECENT + 4 }, (_, i) => `person${i}`);
    expect(parseRecent(JSON.stringify(many))).toHaveLength(MAX_RECENT);
  });
});

describe("nextRecent", () => {
  it("puts the person you just picked first", () => {
    expect(nextRecent(["ewa", "maks"], "maks")).toEqual(["maks", "ewa"]);
    expect(nextRecent([], "maks")).toEqual(["maks"]);
  });

  it("treats one person as one person", () => {
    // GitHub logins are case-insensitive, and a list holding both spellings
    // would be a worse suggestion than none.
    expect(nextRecent(["Maks"], "maks")).toEqual(["maks"]);
  });

  it("drops the oldest once it is full", () => {
    const full = Array.from({ length: MAX_RECENT }, (_, i) => `person${i}`);
    const next = nextRecent(full, "maks");
    expect(next).toHaveLength(MAX_RECENT);
    expect(next[0]).toBe("maks");
    expect(next).not.toContain(`person${MAX_RECENT - 1}`);
  });
});

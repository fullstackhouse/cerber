import { describe, expect, it } from "vitest";
import { mapSearchResults } from "../core/gh.js";
import { pool } from "./review.js";

describe("pool", () => {
  it("runs all items and preserves result order", async () => {
    const results = await pool([1, 2, 3, 4, 5], 2, async (n) => {
      await new Promise((r) => setTimeout(r, (6 - n) * 5)); // later items finish sooner
      return n * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it("caps concurrency", async () => {
    let active = 0;
    let peak = 0;
    await pool([1, 2, 3, 4, 5, 6], 2, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("handles empty input", async () => {
    expect(await pool([], 3, async (x) => x)).toEqual([]);
  });
});

describe("mapSearchResults", () => {
  const raw = [
    {
      number: 7,
      title: "A PR",
      url: "https://github.com/a/b/pull/7",
      updatedAt: "2026-08-19T00:00:00Z",
      isDraft: false,
      repository: { nameWithOwner: "a/b" },
    },
    {
      number: 8,
      title: "Draft PR",
      url: "https://github.com/a/b/pull/8",
      updatedAt: "2026-08-19T00:00:00Z",
      isDraft: true,
      repository: { nameWithOwner: "a/b" },
    },
  ];

  // The search is already --review-requested=@me, so a draft here is one whose
  // author explicitly asked for the review. Dropping it would hide a request
  // GitHub is actively making, which is the bug, not the feature.
  it("maps results and keeps drafts, flagged", () => {
    const mapped = mapSearchResults(raw);
    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toMatchObject({ owner: "a", repo: "b", number: 7, title: "A PR", isDraft: false });
    expect(mapped[1]).toMatchObject({ owner: "a", repo: "b", number: 8, title: "Draft PR", isDraft: true });
  });
});

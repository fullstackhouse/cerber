import { describe, expect, it } from "vitest";
import { isOwnPr } from "./own.js";

describe("isOwnPr", () => {
  it("matches the PR's author against your login, case-insensitively", () => {
    expect(isOwnPr({ author: "jtomaszewski" }, "jtomaszewski")).toBe(true);
    expect(isOwnPr({ author: "JTomaszewski" }, "jtomaszewski")).toBe(true);
    expect(isOwnPr({ author: "someone" }, "jtomaszewski")).toBe(false);
  });

  it("claims nothing without a login or an author", () => {
    expect(isOwnPr({ author: "me" }, null)).toBe(false);
    expect(isOwnPr({ author: "" }, "")).toBe(false);
    expect(isOwnPr({ author: "" }, "me")).toBe(false);
  });
});

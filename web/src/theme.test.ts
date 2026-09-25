import { describe, expect, it } from "vitest";
import { applyTheme, parseTheme } from "./theme";

describe("parseTheme", () => {
  it("keeps a pin", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
  });

  it("follows the machine for anything else", () => {
    expect(parseTheme(null)).toBe("system");
    expect(parseTheme("")).toBe("system");
    expect(parseTheme("Dark")).toBe("system");
    expect(parseTheme("system")).toBe("system");
  });
});

describe("applyTheme", () => {
  const root = () => ({ dataset: {} as DOMStringMap }) as HTMLElement;

  it("pins with data-theme", () => {
    const el = root();
    applyTheme("dark", el);
    expect(el.dataset.theme).toBe("dark");
    applyTheme("light", el);
    expect(el.dataset.theme).toBe("light");
  });

  it("clears the pin to follow the machine", () => {
    const el = root();
    applyTheme("dark", el);
    applyTheme("system", el);
    expect("theme" in el.dataset).toBe(false);
  });
});

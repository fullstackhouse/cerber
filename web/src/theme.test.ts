import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEME_KEY, applyTheme, parseTheme, saveTheme } from "./theme";

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

describe("saveTheme", () => {
  const storage = () => {
    const items = new Map<string, string>();
    return {
      items,
      setItem: (k: string, v: string) => void items.set(k, v),
      removeItem: (k: string) => void items.delete(k),
    };
  };

  it("stores a pin", () => {
    const s = storage();
    saveTheme("dark", s);
    expect(s.items.get(THEME_KEY)).toBe("dark");
    saveTheme("light", s);
    expect(s.items.get(THEME_KEY)).toBe("light");
  });

  it("clears the key rather than storing 'system'", () => {
    const s = storage();
    saveTheme("dark", s);
    saveTheme("system", s);
    expect(s.items.has(THEME_KEY)).toBe(false);
  });

  it("shrugs off storage that refuses", () => {
    const refusing = {
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(() => saveTheme("dark", refusing)).not.toThrow();
    expect(() => saveTheme("system", refusing)).not.toThrow();
  });

  // Chrome with site data blocked throws on merely reading
  // `window.localStorage`, before any method is called.
  it("shrugs off storage that can't even be reached", () => {
    const before = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError: access is denied for this document");
      },
    });
    try {
      expect(() => saveTheme("dark")).not.toThrow();
      expect(() => saveTheme("system")).not.toThrow();
    } finally {
      if (before) Object.defineProperty(globalThis, "localStorage", before);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });
});

// index.html applies the pin before the first paint and can't import theme.ts,
// so it repeats the key and the values. A drift on one side alone would bring
// the flash back with the switch still working - nothing else would notice -
// so the script is run, not grepped: a string can stay in it after the
// assignment it fed is gone.
describe("index.html's pre-paint script", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

  /** Run the script against this storage; what it put on <html>, and the keys it read. */
  const run = (stored: Record<string, string>) => {
    const read: string[] = [];
    const localStorage = {
      getItem: (key: string) => {
        read.push(key);
        return stored[key] ?? null;
      },
    };
    const document = { documentElement: { dataset: {} as DOMStringMap } };
    new Function("localStorage", "document", script)(localStorage, document);
    return { theme: document.documentElement.dataset.theme, read };
  };

  it("reads the same key", () => {
    expect(run({}).read).toEqual([THEME_KEY]);
  });

  it("pins what theme.ts stores", () => {
    expect(run({ [THEME_KEY]: "light" }).theme).toBe("light");
    expect(run({ [THEME_KEY]: "dark" }).theme).toBe("dark");
  });

  it("follows the machine for anything else", () => {
    expect(run({}).theme).toBeUndefined();
    expect(run({ [THEME_KEY]: "system" }).theme).toBeUndefined();
    expect(run({ [THEME_KEY]: "Dark" }).theme).toBeUndefined();
  });

  it("shrugs off storage that can't be reached", () => {
    const blocked = {
      getItem: () => {
        throw new Error("SecurityError");
      },
    };
    const document = { documentElement: { dataset: {} as DOMStringMap } };
    expect(() => new Function("localStorage", "document", script)(blocked, document)).not.toThrow();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

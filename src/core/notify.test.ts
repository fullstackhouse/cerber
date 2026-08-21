import { describe, expect, it } from "vitest";
import { Arrival, appleScriptLiteral, notice, notifyCommand } from "./notify.js";

const pr = (number: number, over: Partial<Arrival> = {}): Arrival => ({
  repo: "widgets",
  number,
  title: "feat: add sprockets",
  author: "mira",
  ...over,
});

describe("what one poll's arrivals say", () => {
  it("says nothing when nothing arrived", () => {
    expect(notice([])).toBeNull();
  });

  it("names the one PR that landed, and who wrote it", () => {
    expect(notice([pr(7)])).toEqual({
      title: "widgets#7 awaits your review",
      body: "feat: add sprockets — mira",
    });
  });

  it("folds a batch into one popup rather than five", () => {
    expect(notice([pr(1), pr(2), pr(3)])).toEqual({
      title: "3 PRs await your review",
      body: "widgets#1, widgets#2, widgets#3",
    });
  });

  it("counts the ones it has no room to name", () => {
    expect(notice([pr(1), pr(2), pr(3), pr(4), pr(5)])?.body).toBe(
      "widgets#1, widgets#2, widgets#3 and 2 more",
    );
  });
});

describe("a PR title inside an AppleScript literal", () => {
  it("quotes ordinary text", () => {
    expect(appleScriptLiteral("feat: add sprockets")).toBe('"feat: add sprockets"');
  });

  // The title is somebody else's text and osascript takes a script, not
  // arguments: an unescaped quote would end the string and run what follows.
  it("cannot be closed early by a quote in the title", () => {
    expect(appleScriptLiteral('fix the "wobble"')).toBe('"fix the \\"wobble\\""');
  });

  it("escapes a backslash before it can escape our quote", () => {
    expect(appleScriptLiteral('a\\"b')).toBe('"a\\\\\\"b"');
  });

  it("gives a script-shaped title nothing to run with", () => {
    expect(appleScriptLiteral('" & (do shell script "touch /tmp/pwned") & "')).toBe(
      '"\\" & (do shell script \\"touch /tmp/pwned\\") & \\""',
    );
  });

  it("flattens the newlines a literal cannot hold", () => {
    expect(appleScriptLiteral("first line\nsecond\tline")).toBe('"first line second line"');
  });
});

describe("the command that taps the machine", () => {
  const n = { title: "widgets#7 awaits your review", body: "feat: add sprockets — mira" };

  it("hands macOS one display-notification script", () => {
    const cmd = notifyCommand(n, "darwin");
    expect(cmd?.file).toBe("osascript");
    expect(cmd?.args[1]).toBe(
      'display notification "feat: add sprockets — mira" with title "widgets#7 awaits your review"',
    );
  });

  it("hands Linux the title and body as arguments, never a shell", () => {
    expect(notifyCommand(n, "linux")).toEqual({
      file: "notify-send",
      args: ["--app-name=cerber", "--", n.title, n.body],
    });
  });

  // The PR's title arrives here inside the body — `notice()` writes the summary
  // itself — so the body is the argument that carries somebody else's text.
  it("ends Linux option parsing, so a body starting with a dash is still text", () => {
    const dashed = { title: "widgets#7 awaits your review", body: "--help me — mira" };
    const cmd = notifyCommand(dashed, "linux");
    // The marker sits before both, so neither can be read as a flag.
    expect(cmd?.args.indexOf("--")).toBeLessThan(cmd!.args.indexOf(dashed.body));
    expect(cmd?.args).toEqual(["--app-name=cerber", "--", dashed.title, dashed.body]);
  });

  it("stays quiet on a platform with nothing to tap", () => {
    expect(notifyCommand(n, "win32")).toBeNull();
  });
});

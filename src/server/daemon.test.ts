import { describe, expect, it } from "vitest";
import { ArtifactSchema } from "../core/artifact.js";
import { mapSearchResults } from "../core/gh.js";
import { isPureStub, stubArtifact } from "./daemon.js";

const DISCOVERED = {
  owner: "acme",
  repo: "widgets",
  number: 7,
  title: "feat: add sprockets",
  url: "https://github.com/acme/widgets/pull/7",
  updatedAt: "2026-08-19T00:00:00Z",
  isDraft: false,
  author: "someone",
};

describe("stubArtifact", () => {
  it("produces a schema-valid awaiting artifact from a search hit", () => {
    const stub = stubArtifact(DISCOVERED);
    expect(() => ArtifactSchema.parse(stub)).not.toThrow();
    expect(stub.status).toBe("awaiting");
    expect(stub.id).toBe("acme/widgets#7");
    expect(stub.pr.author).toBe("someone");
    expect(stub.pr.state).toBe("OPEN");
  });

  it("is a pure stub until something touches it", () => {
    const stub = stubArtifact(DISCOVERED);
    expect(isPureStub(stub)).toBe(true);
    // A human comment makes it work worth keeping.
    expect(
      isPureStub({
        ...stub,
        comments: [
          {
            id: "c1",
            path: "a.ts",
            line: 1,
            body: "hm",
            chapterId: null,
            origin: "user",
            status: "draft",
            editedByUser: false,
            originalLine: null,
            drifted: false,
          },
        ],
      }),
    ).toBe(false);
    // An AI run (even a failed one) is history worth keeping too.
    expect(
      isPureStub({
        ...stub,
        run: {
          model: null,
          startedAt: "2026-08-19T00:00:00Z",
          finishedAt: null,
          costUsd: null,
          error: null,
          withSource: false,
          trusted: false,
          sessionId: null,
        },
      }),
    ).toBe(false);
    expect(isPureStub({ ...stub, status: "ready" })).toBe(false);
  });
});

describe("mapSearchResults author", () => {
  it("carries the author login through", () => {
    const [pr] = mapSearchResults([
      {
        number: 7,
        title: "t",
        url: "u",
        updatedAt: "2026-08-19T00:00:00Z",
        isDraft: false,
        repository: { nameWithOwner: "acme/widgets" },
        author: { login: "someone" },
      },
    ]);
    expect(pr?.author).toBe("someone");
  });

  it("tolerates a missing author (bots, deleted users)", () => {
    const [pr] = mapSearchResults([
      {
        number: 7,
        title: "t",
        url: "u",
        updatedAt: "2026-08-19T00:00:00Z",
        isDraft: false,
        repository: { nameWithOwner: "acme/widgets" },
      },
    ]);
    expect(pr?.author).toBe("");
  });
});

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./index.js";

beforeAll(() => {
  // Point state at an empty temp dir so tests never touch ~/.cerber.
  process.env.CERBER_HOME = mkdtempSync(path.join(os.tmpdir(), "cerber-test-"));
});

describe("token auth", () => {
  it("rejects requests without the token", async () => {
    const app = await buildApp({ token: "s3cret" });
    const res = await app.request("/api/reviews");
    expect(res.status).toBe(401);
  });

  it("accepts Bearer header", async () => {
    const app = await buildApp({ token: "s3cret" });
    const res = await app.request("/api/reviews", {
      headers: { authorization: "Bearer s3cret" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("accepts ?token= and sets the cookie", async () => {
    const app = await buildApp({ token: "s3cret" });
    const res = await app.request("/api/reviews?token=s3cret");
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("cerber_token=s3cret");
  });

  it("accepts the cookie on subsequent requests", async () => {
    const app = await buildApp({ token: "s3cret" });
    const res = await app.request("/api/reviews", {
      headers: { cookie: "cerber_token=s3cret" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a wrong token everywhere", async () => {
    const app = await buildApp({ token: "s3cret" });
    const inits: RequestInit[] = [
      { headers: { authorization: "Bearer nope" } },
      { headers: { cookie: "cerber_token=nope" } },
    ];
    for (const init of inits) {
      const res = await app.request("/api/reviews", init);
      expect(res.status).toBe(401);
    }
    expect((await app.request("/api/reviews?token=nope")).status).toBe(401);
  });

  it("requires no auth when no token is configured", async () => {
    const app = await buildApp({});
    const res = await app.request("/api/reviews");
    expect(res.status).toBe(200);
  });

  it("reports daemon status", async () => {
    const app = await buildApp({});
    const res = await app.request("/api/daemon");
    expect(await res.json()).toEqual({ enabled: false });
  });
});

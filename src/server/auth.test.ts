import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp, cockpitUrl } from "./index.js";

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

// Where a desktop notification lands when clicked. The daemon taps the machine
// `serve` runs on, so the address has to be the one that answers from there.
describe("the cockpit's own address", () => {
  it("is loopback when the bind is every interface", () => {
    expect(cockpitUrl({ host: "0.0.0.0", port: 4820 })).toBe("http://127.0.0.1:4820/");
    expect(cockpitUrl({ host: "127.0.0.1", port: 4820 })).toBe("http://127.0.0.1:4820/");
  });

  it("is the interface itself when only one was bound", () => {
    expect(cockpitUrl({ host: "10.0.0.4", port: 80 })).toBe("http://10.0.0.4:80/");
  });

  it("brackets an IPv6 host, so the port is still a port", () => {
    expect(cockpitUrl({ host: "fd00::1", port: 4820 })).toBe("http://[fd00::1]:4820/");
  });

  // Otherwise the click lands on a 401 — the token is the same one `serve`
  // prints on startup, and the query is where the cockpit already takes it.
  it("carries the token, so the click gets in", () => {
    expect(cockpitUrl({ host: "127.0.0.1", port: 4820, token: "hunter 2" })).toBe(
      "http://127.0.0.1:4820/?token=hunter%202",
    );
  });

  it("names nothing while the port is still the OS's to choose", () => {
    expect(cockpitUrl({ host: "127.0.0.1", port: 0 })).toBeNull();
  });
});

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactKey } from "../core/artifact.js";
import { listArtifacts, loadArtifactByKey } from "../core/state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServeOptions {
  port: number;
  host: string;
}

export async function startServer(opts: ServeOptions): Promise<void> {
  const app = new Hono();

  app.get("/api/reviews", async (c) => {
    const artifacts = await listArtifacts();
    return c.json(
      artifacts.map((a) => ({
        id: a.id,
        key: artifactKey(a.id),
        status: a.status,
        updatedAt: a.updatedAt,
        pr: {
          title: a.pr.title,
          url: a.pr.url,
          author: a.pr.author,
          owner: a.pr.owner,
          repo: a.pr.repo,
          number: a.pr.number,
          additions: a.pr.additions,
          deletions: a.pr.deletions,
          changedFiles: a.pr.changedFiles,
        },
        verdict: a.verdict,
        commentCount: a.comments.filter((cm) => cm.status !== "dropped").length,
        costUsd: a.run?.costUsd ?? null,
      })),
    );
  });

  app.get("/api/reviews/:key", async (c) => {
    const artifact = await loadArtifactByKey(c.req.param("key"));
    if (!artifact) return c.json({ error: "not found" }, 404);
    return c.json(artifact);
  });

  // Static cockpit build. In the published package web/dist ships alongside dist/.
  // __dirname is src/server (dev via tsx) or dist/server (built) — both are two levels below the repo root.
  const webDist = path.resolve(__dirname, "../../web/dist");
  const hasWebBuild = await fs
    .access(path.join(webDist, "index.html"))
    .then(() => true)
    .catch(() => false);

  if (hasWebBuild) {
    app.use("/*", serveStatic({ root: path.relative(process.cwd(), webDist) }));
    app.get("*", serveStatic({ path: path.relative(process.cwd(), path.join(webDist, "index.html")) }));
  } else {
    app.get("/", (c) =>
      c.text(
        "cerber API is running, but the web cockpit is not built.\nRun `pnpm build` in the cerber repo, or use the API: GET /api/reviews\n",
      ),
    );
  }

  serve({ fetch: app.fetch, port: opts.port, hostname: opts.host }, (info) => {
    console.log(`cerber cockpit: http://${opts.host}:${info.port}`);
  });
}

import fs from "node:fs";
import path from "node:path";
import { analyze } from "./analyzer.ts";
import { buildRuntime } from "./runtime.ts";
import { getClientBundle } from "./client-bundle.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

export function createServer(rootDir: string, port: number) {
  const publicDir = path.join(import.meta.dir, "..", "public");

  return Bun.serve({
    port,
    development: false,
    async fetch(req: Request) {
      const url = new URL(req.url);
      const route = url.pathname;

      if (route === "/api/graph") {
        try {
          const graph = analyze(rootDir);
          return Response.json(graph);
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 500 });
        }
      }

      if (route === "/api/run" && req.method === "POST") {
        let body: { kind?: string; name?: string; file?: string; args?: unknown[] };
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        try {
          const runtime = buildRuntime(rootDir);
          const result = await runtime.run({
            kind: body.kind === "init" ? "init" : "function",
            name: body.name,
            file: body.file,
            args: body.args,
          });
          return Response.json(result);
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 500 });
        }
      }

      if (route === "/api/meta") {
        return Response.json({ root: rootDir, port });
      }

      if (route === "/app.js") {
        try {
          const js = await getClientBundle();
          return new Response(js, {
            headers: { "Content-Type": "text/javascript; charset=utf-8" },
          });
        } catch (e) {
          return new Response(`/* ts-viz client build error */\n${(e as Error).message}`, {
            status: 500,
            headers: { "Content-Type": "text/javascript; charset=utf-8" },
          });
        }
      }

      const safe = route === "/" ? "/index.html" : route;
      const filePath = path.join(publicDir, path.normalize(safe).replace(/^([/\\])+/, ""));
      if (!filePath.startsWith(publicDir)) {
        return new Response("Forbidden", { status: 403 });
      }
      try {
        const data = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        return new Response(data, {
          headers: { "Content-Type": MIME[ext] ?? "application/octet-stream" },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  });
}

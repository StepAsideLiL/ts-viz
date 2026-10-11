#!/usr/bin/env bun
import path from "node:path";
import { createServer } from "./server.ts";

interface Options {
  dir: string;
  port: number;
  open: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { dir: process.cwd(), port: 4321, open: true };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-open") {
      opts.open = false;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg.startsWith("--port=")) {
      const p = Number(arg.slice("--port=".length));
      if (Number.isFinite(p)) opts.port = p;
    } else if (arg === "--port" || arg === "-p") {
      const p = Number(argv[++i]);
      if (Number.isFinite(p)) opts.port = p;
    } else if (!arg.startsWith("-")) {
      positionals.push(arg);
    }
  }
  if (positionals.length) opts.dir = path.resolve(positionals[0]);
  return opts;
}

function printHelp() {
  console.log(`ts-viz - interactive TypeScript code visualizer

Usage:
  ts-viz [directory] [options]

Options:
  --port, -p <number>   Port to serve on (default: 4321)
  --no-open             Do not open the browser automatically
  --help, -h            Show this help

Examples:
  ts-viz                Visualize TypeScript in the current directory
  ts-viz ./src          Visualize a specific folder
  ts-viz . --port=8080  Use a custom port
`);
}

function openBrowser(url: string) {
  try {
    if (process.platform === "win32") {
      Bun.spawn(["cmd", "/c", "start", "", url], { stdout: "ignore", stderr: "ignore" });
    } else if (process.platform === "darwin") {
      Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
    } else {
      Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" });
    }
  } catch {
    // ignore
  }
}

const opts = parseArgs(Bun.argv.slice(2));
const server = createServer(opts.dir, opts.port);
const url = `http://localhost:${server.port}`;

console.log("");
console.log("  ts-viz  \u2014  TypeScript code visualizer");
console.log("  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
console.log(`  project : ${opts.dir}`);
console.log(`  server  : ${url}`);
console.log("  press Ctrl+C to stop");
console.log("");

if (opts.open) openBrowser(url);

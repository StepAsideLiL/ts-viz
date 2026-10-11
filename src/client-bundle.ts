import path from "node:path";

let bundlePromise: Promise<string> | null = null;

export function getClientBundle(): Promise<string> {
  if (!bundlePromise) {
    bundlePromise = build();
    bundlePromise.catch(() => {
      bundlePromise = null;
    });
  }
  return bundlePromise;
}

async function build(): Promise<string> {
  const entry = path.join(import.meta.dir, "client", "main.ts");
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "iife",
    minify: false,
    sourcemap: "inline",
  });

  if (!result.success) {
    const logs = result.logs.map((l) => l.message).join("\n");
    throw new Error(`client build failed:\n${logs}`);
  }
  return result.outputs[0].text();
}

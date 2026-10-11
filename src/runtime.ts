import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
import { discoverFiles } from "./analyzer.ts";
import type { RunResult, TraceArg, TraceEvent } from "./schema.ts";

export const UNDEFINED_SENTINEL = "\u0000__tsviz_undefined__";

export function serialize(value: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): TraceArg {
  if (value === null) return { t: "null", short: "null" };
  const type = typeof value;
  if (value === undefined) return { t: "undefined", short: "undefined" };
  if (type === "function") {
    return { t: "function", short: `ƒ ${(value as Function).name || "anonymous"}()` };
  }
  if (type !== "object") {
    return { t: type, value: value as string | number | boolean, short: String(value) };
  }
  const obj = value as object;
  if (seen.has(obj)) return { t: "circular", short: "[Circular]" };
  if (depth > 4) {
    return { t: "object", short: Array.isArray(value) ? "[…]" : "{…}" };
  }
  seen.add(obj);
  if (obj instanceof Error) {
    return { t: "error", short: `${obj.name}: ${obj.message}` };
  }
  if (obj instanceof Map) {
    const entries = [...obj.entries()].map(([k, v]) => ({ k: String(k), v: serialize(v, seen, depth + 1) }));
    return { t: "map", entries, short: `Map(${obj.size})` };
  }
  if (obj instanceof Set) {
    const items = [...obj.values()].map((v) => serialize(v, seen, depth + 1));
    return { t: "set", items, short: `Set(${obj.size})` };
  }
  if (Array.isArray(obj)) {
    const items = obj.map((v) => serialize(v, seen, depth + 1));
    return { t: "array", items, short: `[${items.map((i) => i.short).join(", ")}]` };
  }
  if (value instanceof Date) {
    return { t: "date", short: value.toISOString() };
  }
  const entries: { k: string; v: TraceArg }[] = [];
  for (const k of Object.keys(obj)) {
    try {
      entries.push({ k, v: serialize((obj as Record<string, unknown>)[k], seen, depth + 1) });
    } catch {
      entries.push({ k, v: { t: "unknown", short: "<unreadable>" } });
    }
  }
  const short = entries
    .slice(0, 4)
    .map((e) => `${e.k}: ${e.v.short}`)
    .join(", ");
  return { t: "object", entries, short: `{ ${short}${entries.length > 4 ? ", …" : ""} }` };
}

class Tracer {
  events: TraceEvent[] = [];
  private stack: { id: number; start: number }[] = [];
  private enters = new Map<number, TraceEvent>();
  private seq = 0;

  reset() {
    this.events = [];
    this.stack = [];
    this.enters.clear();
    this.seq = 0;
  }

  enter(name: string, file: string, args: unknown[]): number {
    const id = ++this.seq;
    const depth = this.stack.length;
    this.stack.push({ id, start: performance.now() });
    const event: TraceEvent = {
      type: "enter",
      id,
      name,
      file,
      depth,
      args: (args ?? []).map((a) => serialize(a)),
    };
    this.enters.set(id, event);
    this.events.push(event);
    return id;
  }

  exit(id: number, value: unknown) {
    let frame: { id: number; start: number } | undefined;
    while (this.stack.length) {
      frame = this.stack.pop();
      if (frame && frame.id === id) break;
    }
    const base = this.enters.get(id);
    const event: TraceEvent = {
      type: "exit",
      id,
      name: base?.name ?? "",
      file: base?.file ?? "",
      depth: this.stack.length,
      value: serialize(value),
      duration: frame ? Math.round((performance.now() - frame.start) * 1000) / 1000 : 0,
    };
    if (value && typeof (value as { then?: unknown }).then === "function") {
      (value as Promise<unknown>).then(
        (resolved) => {
          event.value = serialize(resolved);
        },
        () => {},
      );
    }
    this.events.push(event);
  }

  error(id: number, err: unknown) {
    let frame: { id: number; start: number } | undefined;
    while (this.stack.length) {
      frame = this.stack.pop();
      if (frame && frame.id === id) break;
    }
    const base = this.enters.get(id);
    const message = err instanceof Error ? err.message : String(err);
    this.events.push({
      type: "exit",
      id,
      name: base?.name ?? "",
      file: base?.file ?? "",
      depth: this.stack.length,
      value: { t: "error", short: message },
      error: message,
      duration: frame ? Math.round((performance.now() - frame.start) * 1000) / 1000 : 0,
    });
  }
}

function hasAsyncModifier(node: ts.Node): boolean {
  const mods = (node as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

function instrumentFactory(relFile: string): ts.TransformerFactory<ts.SourceFile> {
  return (context) => {
    const f = context.factory;
    const regNames: string[] = [];

    const traceCall = (method: string, args: ts.Expression[]) =>
      f.createCallExpression(
        f.createPropertyAccessExpression(f.createIdentifier("__tsviz"), method),
        undefined,
        args,
      );

    const instrumentBody = (
      name: string,
      parameters: ts.NodeArray<ts.ParameterDeclaration>,
      body: ts.Block | ts.Expression,
      isAsync: boolean,
    ): ts.Block => {
      const paramIdents: ts.Expression[] = [];
      for (const p of parameters) {
        if (ts.isIdentifier(p.name)) paramIdents.push(f.createIdentifier(p.name.text));
        else paramIdents.push(f.createIdentifier("undefined"));
      }
      const enter = traceCall("enter", [
        f.createStringLiteral(name),
        f.createStringLiteral(relFile),
        f.createArrayLiteralExpression(paramIdents),
      ]);
      const statements = ts.isBlock(body)
        ? Array.from(body.statements)
        : [f.createReturnStatement(body as ts.Expression)];
      const innerModifiers = isAsync ? [f.createModifier(ts.SyntaxKind.AsyncKeyword)] : undefined;
      const inner = f.createArrowFunction(
        innerModifiers,
        undefined,
        [],
        undefined,
        f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        f.createBlock(statements, true),
      );
      return f.createBlock(
        [
          f.createVariableStatement(
            undefined,
            f.createVariableDeclarationList(
              [f.createVariableDeclaration("__tid", undefined, undefined, enter)],
              ts.NodeFlags.Const,
            ),
          ),
          f.createVariableStatement(
            undefined,
            f.createVariableDeclarationList(
              [f.createVariableDeclaration("__ret")],
              ts.NodeFlags.Let,
            ),
          ),
          f.createTryStatement(
            f.createBlock(
              [
                f.createExpressionStatement(
                  f.createBinaryExpression(
                    f.createIdentifier("__ret"),
                    f.createToken(ts.SyntaxKind.EqualsToken),
                    f.createCallExpression(inner, undefined, []),
                  ),
                ),
              ],
              true,
            ),
            f.createCatchClause(
              f.createVariableDeclaration("__err"),
              f.createBlock(
                [
                  f.createExpressionStatement(
                    traceCall("error", [f.createIdentifier("__tid"), f.createIdentifier("__err")]),
                  ),
                  f.createThrowStatement(f.createIdentifier("__err")),
                ],
                true,
              ),
            ),
            undefined,
          ),
          f.createExpressionStatement(
            traceCall("exit", [f.createIdentifier("__tid"), f.createIdentifier("__ret")]),
          ),
          f.createReturnStatement(f.createIdentifier("__ret")),
        ],
        true,
      );
    };

    const visitStatement = (stmt: ts.Statement, topLevel: boolean): ts.Statement => {
      if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
        const body = instrumentBody(stmt.name.text, stmt.parameters, stmt.body, hasAsyncModifier(stmt));
        if (topLevel) regNames.push(stmt.name.text);
        return f.updateFunctionDeclaration(
          stmt,
          stmt.modifiers,
          stmt.asteriskToken,
          stmt.name,
          stmt.typeParameters,
          stmt.parameters,
          stmt.type,
          body,
        );
      }
      if (ts.isVariableStatement(stmt)) {
        const decls = stmt.declarationList.declarations.map((decl) => {
          const init = decl.initializer;
          if (
            ts.isIdentifier(decl.name) &&
            init &&
            (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
          ) {
            const body = instrumentBody(decl.name.text, init.parameters, init.body, hasAsyncModifier(init));
            if (topLevel) regNames.push(decl.name.text);
            if (ts.isArrowFunction(init)) {
              const newFn = f.updateArrowFunction(
                init,
                init.modifiers,
                init.typeParameters,
                init.parameters,
                init.type,
                init.equalsGreaterThanToken,
                body,
              );
              return f.updateVariableDeclaration(decl, decl.name, decl.exclamationToken, decl.type, newFn);
            }
            const newFn = f.updateFunctionExpression(
              init,
              init.modifiers,
              init.asteriskToken,
              init.name,
              init.typeParameters,
              init.parameters,
              init.type,
              body,
            );
            return f.updateVariableDeclaration(decl, decl.name, decl.exclamationToken, decl.type, newFn);
          }
          return decl;
        });
        return f.updateVariableStatement(
          stmt,
          stmt.modifiers,
          f.updateVariableDeclarationList(stmt.declarationList, decls),
        );
      }
      return ts.visitEachChild(stmt, (child) => visitStatement(child as ts.Statement, false), context);
    };

    return (sourceFile) => {
      const statements = sourceFile.statements.map((s) => visitStatement(s, true));
      const registrations = regNames.map((name) =>
        f.createExpressionStatement(
          traceCall("register", [
            f.createStringLiteral(name),
            f.createIdentifier(name),
            f.createStringLiteral(relFile),
          ]),
        ),
      );
      return f.updateSourceFile(sourceFile, [...statements, ...registrations]);
    };
  };
}

interface Runtime {
  run(op: { kind: "function" | "init"; name?: string; file?: string; args?: unknown[] }): Promise<RunResult>;
  files: string[];
  loadErrors: string[];
}

export function buildRuntime(rootDir: string): Runtime {
  const files = discoverFiles(rootDir);
  const rel = (f: string) => path.relative(rootDir, f).split(path.sep).join("/");
  const tracer = new Tracer();
  const registry = new Map<string, Function>();
  const loadErrors: string[] = [];
  const cache = new Map<string, { exports: Record<string, unknown> }>();
  const nodeRequire = createRequire(path.join(rootDir, "noop.js"));

  const sandbox: Record<string, unknown> = {
    __tsviz: {
      register: (name: string, fn: Function, file: string) => {
        if (typeof fn === "function") {
          registry.set(name, fn);
          registry.set(`${file}::${name}`, fn);
        }
      },
      enter: (name: string, file: string, args: unknown[]) => tracer.enter(name, file, args),
      exit: (id: number, value: unknown) => tracer.exit(id, value),
      error: (id: number, err: unknown) => tracer.error(id, err),
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    fetch,
    AbortController,
    AbortSignal,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    structuredClone,
    Buffer,
    process,
    performance,
    crypto,
  };
  const context = vm.createContext(sandbox);

  const resolveFile = (base: string): string | null => {
    const candidates = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.mts`,
      `${base}.cts`,
      `${base}.js`,
      `${base}.mjs`,
      `${base}.cjs`,
      path.join(base, "index.ts"),
      path.join(base, "index.tsx"),
      path.join(base, "index.js"),
    ];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
      } catch {
        // ignore
      }
    }
    return null;
  };

  const loadModule = (absFile: string): Record<string, unknown> => {
    const cached = cache.get(absFile);
    if (cached) return cached.exports;
    const mod = { exports: {} as Record<string, unknown> };
    cache.set(absFile, mod);

    let source: string;
    try {
      source = fs.readFileSync(absFile, "utf8");
    } catch (e) {
      loadErrors.push(`${rel(absFile)}: ${(e as Error).message}`);
      return mod.exports;
    }

    let js: string;
    try {
      const out = ts.transpileModule(source, {
        fileName: absFile,
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ESNext,
          esModuleInterop: true,
          jsx: ts.JsxEmit.ReactJSX,
          allowJs: true,
        },
        transformers: { before: [instrumentFactory(rel(absFile))] },
      });
      js = out.outputText;
    } catch (e) {
      loadErrors.push(`${rel(absFile)}: ${(e as Error).message}`);
      return mod.exports;
    }

    const localRequire = (request: string): unknown => {
      if (request.startsWith(".") || request.startsWith("/") || path.isAbsolute(request)) {
        const resolved = resolveFile(path.resolve(path.dirname(absFile), request));
        if (resolved) return loadModule(resolved);
        throw new Error(`Cannot find module '${request}'`);
      }
      return nodeRequire(request);
    };

    const wrapper = `(function (exports, require, module, __filename, __dirname) {\n${js}\n})`;
    try {
      const fn = vm.runInContext(wrapper, context, { filename: absFile }) as (
        exports: unknown,
        require: unknown,
        module: unknown,
        filename: string,
        dirname: string,
      ) => void;
      fn.call(mod.exports, mod.exports, localRequire, mod, absFile, path.dirname(absFile));
    } catch (e) {
      loadErrors.push(`${rel(absFile)}: ${(e as Error).message}`);
      cache.delete(absFile);
      return mod.exports;
    }
    return mod.exports;
  };

  for (const file of files) {
    try {
      loadModule(file);
    } catch {
      // errors captured inside loadModule
    }
  }

  const initTrace = tracer.events.slice();

  const run = async (op: {
    kind: "function" | "init";
    name?: string;
    file?: string;
    args?: unknown[];
  }): Promise<RunResult> => {
    if (op.kind === "init") {
      return { trace: initTrace, initTrace, result: { t: "void", short: "void" }, loadErrors };
    }

    tracer.reset();
    const key = op.file ? `${op.file}::${op.name}` : op.name ?? "";
    const entry = registry.get(key) ?? registry.get(op.name ?? "");
    if (!entry) {
      return { trace: [], initTrace, error: `Function '${op.name}' not found`, loadErrors };
    }

    const args = (op.args ?? []).map((a) => (a === UNDEFINED_SENTINEL ? undefined : a));
    let result: unknown;
    let error: string | undefined;
    try {
      result = await entry(...args);
    } catch (e) {
      error = e instanceof Error ? e.stack ?? e.message : String(e);
    }
    return { trace: tracer.events.slice(), result: serialize(result), error, initTrace, loadErrors };
  };

  return { run, files, loadErrors };
}

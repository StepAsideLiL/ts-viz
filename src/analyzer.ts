import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { FunctionInfo, Graph, GraphEdge, ParamInfo, PropertySchema, TypeSchema } from "./schema.ts";

const EXCLUDE_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".turbo", "coverage", ".cache"]);
const SOURCE_EXT = new Set([".ts", ".tsx", ".mts", ".cts"]);

export function discoverFiles(rootDir: string, max = 400): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= max) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= max) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || EXCLUDE_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (SOURCE_EXT.has(ext) && !entry.name.endsWith(".d.ts")) out.push(full);
      }
    }
  };
  walk(rootDir);
  return out;
}

const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  strict: false,
  skipLibCheck: true,
  noEmit: true,
  allowJs: false,
  types: [],
};

function loadCompilerOptions(rootDir: string): ts.CompilerOptions {
  try {
    const configPath = ts.findConfigFile(rootDir, ts.sys.fileExists, "tsconfig.json");
    if (!configPath) return DEFAULT_COMPILER_OPTIONS;
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error || !read.config) return DEFAULT_COMPILER_OPTIONS;
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, rootDir);
    return {
      ...parsed.options,
      noEmit: true,
      skipLibCheck: true,
      allowJs: false,
      declaration: false,
      composite: false,
      incremental: false,
    };
  } catch {
    return DEFAULT_COMPILER_OPTIONS;
  }
}

interface Candidate {
  name: string;
  node: ts.FunctionLikeDeclaration & { name?: ts.Identifier };
  kind: "function" | "arrow";
  exported: boolean;
  file: string;
}

export function analyze(rootDir: string): Graph {
  const files = discoverFiles(rootDir);
  const options = loadCompilerOptions(rootDir);

  let program: ts.Program;
  try {
    program = ts.createProgram({ rootNames: files, options });
  } catch {
    return { root: rootDir, functions: [], edges: [] };
  }
  const checker = program.getTypeChecker();

  const functions: FunctionInfo[] = [];
  const edgesMap = new Map<string, GraphEdge>();
  const candidates: Candidate[] = [];
  const nodeToInfo = new Map<ts.Node, FunctionInfo>();

  const rel = (f: string) => path.relative(rootDir, f).split(path.sep).join("/");

  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    const relFile = rel(file);

    const collect = (node: ts.Node, inTopLevel: boolean) => {
      let candidate: Candidate | null = null;

      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        candidate = {
          name: node.name.text,
          node,
          kind: "function",
          exported: hasExport(node),
          file: relFile,
        };
      } else if (ts.isVariableStatement(node) || ts.isVariableDeclarationList(node)) {
        // handled below at statement level
      }

      if (candidate) {
        const info = buildInfo(candidate, checker, sf, relFile);
        functions.push(info);
        nodeToInfo.set(node, info);
        candidates.push(candidate);
        // recurse into body for nested but don't double-register top-level
      }

      // variable declarations with arrow/function initializers
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const init = node.initializer;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          const parentStmt = findVariableStatement(node);
          const cand: Candidate = {
            name: node.name.text,
            node: init as unknown as Candidate["node"],
            kind: "arrow",
            exported: parentStmt ? hasExport(parentStmt) : false,
            file: relFile,
          };
          const info = buildInfo(cand, checker, sf, relFile);
          functions.push(info);
          nodeToInfo.set(init, info);
          candidates.push(cand);
        }
      }

      ts.forEachChild(node, (child) => collect(child, false));
    };

    ts.forEachChild(sf, (node) => collect(node, true));
  }

  const byName = new Map<string, FunctionInfo[]>();
  for (const fn of functions) {
    const list = byName.get(fn.name) ?? [];
    list.push(fn);
    byName.set(fn.name, list);
  }

  const resolve = (name: string, callerFile: string): FunctionInfo | undefined => {
    const list = byName.get(name);
    if (!list || list.length === 0) return undefined;
    return list.find((f) => f.file === callerFile) ?? list[0];
  };

  const addEdge = (from: string, to: string, name: string) => {
    const key = `${from}->${to}`;
    const existing = edgesMap.get(key);
    if (existing) existing.count++;
    else edgesMap.set(key, { from, to, name, count: 1 });
  };

  // Collect call edges per function (nearest named enclosing function owns the call).
  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    const relFile = rel(file);

    const topLevelCalls: string[] = [];

    const visit = (node: ts.Node, current: FunctionInfo | null) => {
      let next = current;
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        next = nodeToInfo.get(node) ?? current;
      } else if (
        (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
        nodeToInfo.has(node)
      ) {
        next = nodeToInfo.get(node) ?? current;
      }

      if (ts.isCallExpression(node)) {
        const calleeName = calleeIdentifier(node);
        if (calleeName) {
          const target = resolve(calleeName, relFile);
          if (target) {
            if (next) addEdge(next.id, target.id, calleeName);
            else topLevelCalls.push(calleeName);
          }
        }
      }
      ts.forEachChild(node, (child) => visit(child, next));
    };

    for (const stmt of sf.statements) {
      visit(stmt, null);
    }

    // module init node
    if (topLevelCalls.length) {
      const initId = `${relFile}::__init__`;
      functions.push({
        id: initId,
        name: "app init",
        file: relFile,
        line: 1,
        kind: "init",
        exported: false,
        async: false,
        params: [],
        returnType: "void",
        returnSchema: { kind: "void" },
      });
      for (const callName of topLevelCalls) {
        const target = resolve(callName, relFile);
        if (target) addEdge(initId, target.id, callName);
      }
    }
  }

  return {
    root: rootDir,
    functions,
    edges: [...edgesMap.values()],
  };
}

function hasExport(node: ts.Node): boolean {
  const mods = (node as ts.HasModifiers).modifiers;
  if (!mods) return false;
  return mods.some(
    (m) =>
      m.kind === ts.SyntaxKind.ExportKeyword ||
      m.kind === ts.SyntaxKind.DefaultKeyword,
  );
}

function findVariableStatement(node: ts.Node): ts.VariableStatement | undefined {
  let cur: ts.Node | undefined = node;
  while (cur) {
    if (ts.isVariableStatement(cur)) return cur;
    cur = cur.parent;
  }
  return undefined;
}

function calleeIdentifier(call: ts.CallExpression): string | null {
  const expr = call.expression;
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) return expr.name.text;
  return null;
}

function buildInfo(
  cand: Candidate,
  checker: ts.TypeChecker,
  sf: ts.SourceFile,
  relFile: string,
): FunctionInfo {
  const node = cand.node;
  const params: ParamInfo[] = [];
  let returnType = "unknown";
  let returnSchema: TypeSchema = { kind: "unknown" };

  let signature: ts.Signature | undefined;
  try {
    signature = checker.getSignatureFromDeclaration(node as ts.SignatureDeclaration);
  } catch {
    signature = undefined;
  }
  let paramSymbols: ts.Symbol[] = [];
  try {
    paramSymbols = signature?.getParameters() ?? [];
  } catch {
    paramSymbols = [];
  }

  const paramNodes = node.parameters ?? [];
  for (let i = 0; i < paramNodes.length; i++) {
    const p = paramNodes[i];
    const name = p.name.getText(sf);
    const hasDefault = !!p.initializer;
    let schema: TypeSchema = { kind: "any" };
    let typeText = p.type ? p.type.getText(sf) : "any";
    let optional = !!p.questionToken || hasDefault;
    try {
      const sym = paramSymbols[i];
      if (sym) {
        const t = checker.getTypeOfSymbolAtLocation(sym, p);
        schema = typeToSchema(t, checker, p);
        typeText = checker.typeToString(t) || typeText;
        if (t.flags & ts.TypeFlags.Undefined) optional = true;
      }
    } catch {
      // keep fallback
    }
    params.push({
      name,
      typeText,
      schema,
      optional,
      hasDefault,
      defaultValue: p.initializer ? p.initializer.getText(sf) : undefined,
    });
  }

  try {
    if (signature) {
      const rt = signature.getReturnType();
      returnType = checker.typeToString(rt);
      returnSchema = typeToSchema(rt, checker, node);
    } else if (node.type) {
      returnType = node.type.getText(sf);
    }
  } catch {
    // ignore
  }

  const start = node.getStart(sf);
  const line = sf.getLineAndCharacterOfPosition(start).line + 1;

  return {
    id: `${relFile}::${cand.name}`,
    name: cand.name,
    file: relFile,
    line,
    kind: cand.kind,
    exported: cand.exported,
    async: !!(node as unknown as { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
    ),
    params,
    returnType,
    returnSchema,
  };
}

export function typeToSchema(
  type: ts.Type,
  checker: ts.TypeChecker,
  ref: ts.Node,
  depth = 0,
  seen: Set<number> = new Set(),
): TypeSchema {
  try {
    if (depth > 6) return { kind: "any" };
    const flags = type.flags;

    if (flags & ts.TypeFlags.Any) return { kind: "any" };
    if (flags & ts.TypeFlags.Unknown) return { kind: "unknown" };
    if (flags & ts.TypeFlags.Never) return { kind: "never" };
    if (flags & ts.TypeFlags.Void) return { kind: "void" };
    if (flags & ts.TypeFlags.Undefined) return { kind: "undefined" };
    if (flags & ts.TypeFlags.Null) return { kind: "null" };

    if (flags & ts.TypeFlags.StringLiteral) {
      return { kind: "literal", value: (type as ts.StringLiteralType).value, literalType: "string" };
    }
    if (flags & ts.TypeFlags.NumberLiteral) {
      return { kind: "literal", value: (type as ts.NumberLiteralType).value, literalType: "number" };
    }
    if (flags & ts.TypeFlags.BooleanLiteral) {
      return {
        kind: "literal",
        value: (type as unknown as { intrinsicName: string }).intrinsicName === "true",
        literalType: "boolean",
      };
    }

    if (type.isUnion()) {
      const opts = type.types;
      if (opts.length === 2 && opts.every((t) => t.flags & ts.TypeFlags.BooleanLiteral)) {
        return { kind: "primitive", name: "boolean" };
      }
      return { kind: "union", options: opts.map((t) => typeToSchema(t, checker, ref, depth + 1, seen)) };
    }

    if (flags & ts.TypeFlags.String) return { kind: "primitive", name: "string" };
    if (flags & ts.TypeFlags.Number) return { kind: "primitive", name: "number" };
    if (flags & ts.TypeFlags.Boolean) return { kind: "primitive", name: "boolean" };
    if (flags & ts.TypeFlags.BigInt) return { kind: "primitive", name: "bigint" };
    if (flags & ts.TypeFlags.ESSymbol) return { kind: "primitive", name: "symbol" };

    if (checker.isTupleType(type)) {
      const args = checker.getTypeArguments(type as ts.TypeReference);
      if (args.length === 0) return { kind: "array", element: { kind: "any" } };
      return {
        kind: "tuple",
        elements: args.map((t) => typeToSchema(t, checker, ref, depth + 1, seen)),
      };
    }

    if (checker.isArrayType(type)) {
      const args = checker.getTypeArguments(type as ts.TypeReference);
      return {
        kind: "array",
        element: args[0] ? typeToSchema(args[0], checker, ref, depth + 1, seen) : { kind: "any" },
      };
    }

    if (type.getCallSignatures().length > 0 && !(flags & ts.TypeFlags.Object)) {
      return { kind: "function", name: typeName(type, checker) };
    }

    if (flags & ts.TypeFlags.Object) {
      const id = (type as unknown as { id: number }).id;
      const name = typeName(type, checker);
      if (type.getCallSignatures().length > 0 && type.getProperties().length === 0) {
        return { kind: "function", name };
      }
      if (seen.has(id)) return { kind: "reference", name };
      seen.add(id);

      const props = checker.getPropertiesOfType(type);
      const properties: PropertySchema[] = [];
      for (const p of props) {
        const decl = p.valueDeclaration ?? p.declarations?.[0];
        if (!decl) continue;
        if (decl.getSourceFile().isDeclarationFile) continue;
        let propType: ts.Type;
        try {
          propType = checker.getTypeOfSymbolAtLocation(p, decl);
        } catch {
          continue;
        }
        if (propType.getCallSignatures().length > 0) {
          // function-typed property: keep as function schema
        }
        properties.push({
          name: p.getName(),
          type: typeToSchema(propType, checker, decl, depth + 1, seen),
          typeText: checker.typeToString(propType),
          optional: !!(p.flags & ts.SymbolFlags.Optional),
        });
      }
      return { kind: "object", name, properties };
    }

    return { kind: "any" };
  } catch {
    return { kind: "any" };
  }
}

function typeName(type: ts.Type, checker: ts.TypeChecker): string {
  const alias = (type as ts.Type).aliasSymbol?.getName();
  if (alias) return alias;
  const sym = type.symbol?.getName();
  if (sym && sym !== "__type" && sym !== "__object") return sym;
  const text = checker.typeToString(type);
  if (text.length <= 24) return text;
  return "object";
}

export type TypeSchema =
  | { kind: "primitive"; name: "string" | "number" | "boolean" | "bigint" | "symbol" }
  | { kind: "any" }
  | { kind: "unknown" }
  | { kind: "never" }
  | { kind: "void" }
  | { kind: "null" }
  | { kind: "undefined" }
  | { kind: "literal"; value: string | number | boolean; literalType: "string" | "number" | "boolean" | "bigint" }
  | { kind: "union"; options: TypeSchema[] }
  | { kind: "array"; element: TypeSchema }
  | { kind: "tuple"; elements: TypeSchema[] }
  | { kind: "object"; name: string; properties: PropertySchema[] }
  | { kind: "function"; name: string }
  | { kind: "reference"; name: string };

export interface PropertySchema {
  name: string;
  type: TypeSchema;
  typeText: string;
  optional: boolean;
}

export interface ParamInfo {
  name: string;
  typeText: string;
  schema: TypeSchema;
  optional: boolean;
  hasDefault: boolean;
  defaultValue?: string;
}

export interface FunctionInfo {
  id: string;
  name: string;
  file: string;
  line: number;
  kind: "function" | "arrow" | "init";
  exported: boolean;
  async: boolean;
  params: ParamInfo[];
  returnType: string;
  returnSchema: TypeSchema;
}

export interface GraphEdge {
  from: string;
  to: string;
  name: string;
  count: number;
}

export interface Graph {
  root: string;
  functions: FunctionInfo[];
  edges: GraphEdge[];
  loadErrors?: string[];
}

export interface TraceArg {
  t: string;
  value?: string | number | boolean | null;
  short: string;
  items?: TraceArg[];
  entries?: { k: string; v: TraceArg }[];
}

export interface TraceEvent {
  type: "enter" | "exit";
  id: number;
  name: string;
  file: string;
  depth: number;
  args?: TraceArg[];
  value?: TraceArg;
  error?: string;
  duration?: number;
}

export interface RunResult {
  trace: TraceEvent[];
  result?: TraceArg;
  error?: string;
  loadErrors?: string[];
  initTrace: TraceEvent[];
}

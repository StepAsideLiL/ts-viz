import type {
  FunctionInfo,
  Graph,
  GraphEdge,
  PropertySchema,
  RunResult,
  TraceArg,
  TraceEvent,
  TypeSchema,
} from "../schema.ts";

const UNDEF = "\u0000__tsviz_undefined__";
const OMIT: unique symbol = Symbol("omit");
const SVGNS = "http://www.w3.org/2000/svg";

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */
interface Editor {
  node: HTMLElement;
  read: () => unknown;
}

interface EditorCtx {
  name: string;
  optional: boolean;
  value?: unknown;
}

interface SelectOpts {
  focus?: boolean;
  keepFocus?: boolean;
  values?: unknown[] | null;
}

interface NodePos {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DragState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  moved: boolean;
}

interface PlaybackState {
  timer: ReturnType<typeof setTimeout> | null;
  events: TraceEvent[];
  items: HTMLElement[];
  index: number;
}

interface AppState {
  graph: Graph;
  pos: Map<string, NodePos>;
  byId: Map<string, FunctionInfo>;
  selected: FunctionInfo | null;
  focusId: string | null;
  edgeEls: Map<string, SVGPathElement>;
  view: { x: number; y: number; k: number };
  playback: PlaybackState;
  formRead: Editor[];
}

type PrimitiveSchema = Extract<TypeSchema, { kind: "primitive" }>;
type LiteralSchema = Extract<TypeSchema, { kind: "literal" }>;
type UnionSchema = Extract<TypeSchema, { kind: "union" }>;
type ArraySchema = Extract<TypeSchema, { kind: "array" }>;
type TupleSchema = Extract<TypeSchema, { kind: "tuple" }>;
type ObjectSchema = Extract<TypeSchema, { kind: "object" }>;
type FunctionSchema = Extract<TypeSchema, { kind: "function" }>;

const state: AppState = {
  graph: { root: "", functions: [], edges: [] },
  pos: new Map(),
  byId: new Map(),
  selected: null,
  focusId: null,
  edgeEls: new Map(),
  view: { x: 0, y: 0, k: 1 },
  playback: { timer: null, events: [], items: [], index: -1 },
  formRead: [],
};

/* ------------------------------------------------------------------ */
/* dom helpers                                                         */
/* ------------------------------------------------------------------ */
function $<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(sel);
  if (!found) throw new Error(`ts-viz: element not found: ${sel}`);
  return found;
}

function q<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(sel);
}

function $$<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(sel));
}

type AttrValue = string | number | boolean | ((e: Event) => void) | null | undefined;
interface ElAttrs {
  class?: string;
  html?: string;
  [key: string]: AttrValue;
}
type Child = Node | string | null | undefined;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: ElAttrs = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === "class") node.className = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else if (typeof value === "function") node.addEventListener(key.slice(2), value as EventListener);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortType(t: string): string {
  return t.length > 34 ? t.slice(0, 33) + "…" : t;
}

/* ------------------------------------------------------------------ */
/* schema helpers                                                      */
/* ------------------------------------------------------------------ */
function schemaLabel(s: TypeSchema | undefined): string {
  if (!s) return "unknown";
  switch (s.kind) {
    case "primitive":
      return s.name;
    case "literal":
      return typeof s.value === "string" ? JSON.stringify(s.value) : String(s.value);
    case "array":
      return `${schemaLabel(s.element)}[]`;
    case "tuple":
      return `[${s.elements.map(schemaLabel).join(", ")}]`;
    case "object":
      return s.name || "object";
    case "union":
      return s.options.map(schemaLabel).join(" | ");
    case "function":
      return s.name || "function";
    case "reference":
      return s.name || "ref";
    default:
      return s.kind;
  }
}

function stringSuggestions(name: string): string[] {
  const n = name.toLowerCase();
  if (/mail/.test(n)) return ["ada@example.com", "grace@navy.mil", "user@test.dev"];
  if (/url|uri|href|link/.test(n)) return ["https://example.com", "https://api.dev/v1"];
  if (/id$|^id|uuid|key|slug/.test(n)) return ["a1b2c3", "user_42", "sku-001"];
  if (/first_?name|given/.test(n)) return ["Ada", "Grace", "Alan"];
  if (/last_?name|surname|family/.test(n)) return ["Lovelace", "Hopper", "Turing"];
  if (/name/.test(n)) return ["Ada Lovelace", "Grace Hopper", "Alan Turing"];
  if (/color|colour/.test(n)) return ["blue", "#7c9cff", "crimson"];
  if (/date|time|day/.test(n)) return ["2026-01-01", "2026-10-11T09:00:00Z"];
  if (/phone|tel|mobile/.test(n)) return ["+1-555-0100"];
  if (/city|town/.test(n)) return ["Berlin", "Tokyo", "Lisbon"];
  if (/country/.test(n)) return ["DE", "JP", "US"];
  if (/address|street/.test(n)) return ["42 Main St", "1 Infinite Loop"];
  if (/path|file|dir/.test(n)) return ["/tmp/data.json", "src/index.ts"];
  if (/message|msg|text|body|desc|title|label|content/.test(n)) return ["Hello world", "A short message"];
  if (/status|state/.test(n)) return ["active", "pending", "done"];
  if (/type|kind|category/.test(n)) return ["basic", "premium", "admin"];
  return ["hello", "world", "example"];
}

function numberSuggestions(name: string): number[] {
  const n = name.toLowerCase();
  if (/age/.test(n)) return [21, 30, 42];
  if (/qty|quantity|count|size|num|amount/.test(n)) return [0, 1, 3, 10];
  if (/price|cost|fee|salary|total/.test(n)) return [9.99, 19.5, 100];
  if (/year/.test(n)) return [2024, 2025, 2026];
  if (/percent|rate|ratio/.test(n)) return [0.5, 1, 10];
  return [0, 1, 2, 42, 100];
}

function sampleValue(schema: TypeSchema, name: string): unknown {
  switch (schema.kind) {
    case "primitive":
      if (schema.name === "string") return stringSuggestions(name)[0];
      if (schema.name === "number") return numberSuggestions(name)[1] ?? 42;
      if (schema.name === "boolean") return true;
      return 0;
    case "literal":
      return schema.value;
    case "union": {
      const lit = schema.options.find((o) => o.kind === "literal") as LiteralSchema | undefined;
      if (lit) return lit.value;
      const first = schema.options.find((o) => o.kind !== "undefined" && o.kind !== "null");
      return first ? sampleValue(first, name) : undefined;
    }
    case "array": {
      const v = sampleValue(schema.element, name);
      return schema.element.kind === "primitive" && (schema.element as PrimitiveSchema).name !== "string"
        ? [v]
        : [v, sampleValue(schema.element, name)];
    }
    case "tuple":
      return schema.elements.map((e) => sampleValue(e, name));
    case "object": {
      const obj: Record<string, unknown> = {};
      for (const p of schema.properties) obj[p.name] = sampleValue(p.type, p.name);
      return obj;
    }
    case "null":
      return null;
    default:
      return "value";
  }
}

/* ------------------------------------------------------------------ */
/* form editor                                                         */
/* ------------------------------------------------------------------ */
function makeNumberList(id: string, values: (string | number)[]): HTMLDataListElement {
  return el(
    "datalist",
    { id },
    values.map((v) => el("option", { value: String(v) })),
  );
}

function primitiveEditor(type: PrimitiveSchema["name"], ctx: EditorCtx): Editor {
  if (type === "boolean") {
    const sel = el(
      "select",
      {},
      el("option", { value: "true" }, "true"),
      el("option", { value: "false" }, "false"),
    );
    sel.value = ctx.value === false ? "false" : String(ctx.value ?? true);
    return { node: sel, read: () => sel.value === "true" };
  }
  if (type === "symbol") {
    return { node: el("div", { class: "obj-note" }, "symbol — not passable"), read: () => OMIT };
  }
  const isNum = type === "number" || type === "bigint";
  const input = el("input", {
    type: isNum ? "number" : "text",
    ...(isNum ? { step: "any" } : {}),
  });
  const suggestions: (string | number)[] = isNum ? numberSuggestions(ctx.name) : stringSuggestions(ctx.name);
  const listId = `dl-${Math.random().toString(36).slice(2)}`;
  input.setAttribute("list", listId);
  if (!isNum) input.placeholder = String(suggestions[0] ?? "");
  if (ctx.value !== undefined && ctx.value !== null) input.value = String(ctx.value);
  const wrap = el("div", { class: "field-row" }, input, makeNumberList(listId, suggestions));
  return {
    node: wrap,
    read: () => {
      const raw = input.value.trim();
      if (raw === "") {
        if (ctx.optional) return OMIT;
        return isNum ? 0 : "";
      }
      return isNum ? Number(raw) : raw;
    },
  };
}

function literalEditor(schema: LiteralSchema): Editor {
  return {
    node: el("div", { class: "obj-note" }, `fixed value: ${schemaLabel(schema)}`),
    read: () => schema.value,
  };
}

function unionEditor(schema: UnionSchema, ctx: EditorCtx): Editor {
  const options = schema.options;
  const pickable = options.filter((o) => o.kind !== "undefined");
  if (pickable.length === 1 && pickable[0].kind === "literal") {
    return literalEditor(pickable[0] as LiteralSchema);
  }
  const sel = el("select", {});
  for (const o of pickable) sel.appendChild(el("option", { value: "" }, schemaLabel(o)));
  if (options.some((o) => o.kind === "undefined")) sel.appendChild(el("option", { value: "__undefined" }, "undefined"));
  if (options.some((o) => o.kind === "null")) sel.appendChild(el("option", { value: "__null" }, "null"));

  const body = el("div");
  let current: Editor | null = null;
  const render = (): void => {
    body.innerHTML = "";
    const choice = pickable[sel.selectedIndex];
    if (!choice) {
      const isUndef = options.some((o) => o.kind === "undefined");
      current = { node: document.createElement("span"), read: () => (isUndef ? undefined : null) };
      return;
    }
    current = editor(choice, { ...ctx, value: ctx.value });
    body.appendChild(current.node);
  };
  sel.addEventListener("change", render);
  render();
  const wrap = el("div", { class: "arr" }, sel, body);
  return { node: wrap, read: () => (current ? current.read() : undefined) };
}

function arrayEditor(schema: ArraySchema, ctx: EditorCtx): Editor {
  const list = el("div", { class: "arr-list" });
  const readings: Editor[] = [];

  const renumber = (): void => {
    $$(".arr-index", list).forEach((n, i) => {
      n.textContent = String(i);
    });
  };

  const addItem = (value: unknown): void => {
    const sub = editor(schema.element, { name: ctx.name, optional: false, value });
    const removeBtn = el("button", { class: "x-btn", type: "button", title: "remove" }, "×");
    const row = el(
      "div",
      { class: "arr-item" },
      el("span", { class: "arr-index" }, String(readings.length)),
      el("div", { class: "item-body" }, sub.node),
      removeBtn,
    );
    removeBtn.addEventListener("click", () => {
      const i = readings.indexOf(sub);
      if (i >= 0) readings.splice(i, 1);
      row.remove();
      renumber();
    });
    readings.push(sub);
    list.appendChild(row);
  };

  const initial = Array.isArray(ctx.value) ? (ctx.value as unknown[]) : [];
  if (initial.length) initial.forEach(addItem);
  else if (!ctx.optional) addItem(undefined);

  const addBtn = el("button", { class: "mini-btn", type: "button" }, "+ add item");
  addBtn.addEventListener("click", () => addItem(undefined));

  const wrap = el("div", { class: "arr" }, list, addBtn);
  return {
    node: wrap,
    read: () => {
      const out: unknown[] = [];
      for (const r of readings) {
        const v = r.read();
        if (v !== OMIT) out.push(v);
      }
      return out;
    },
  };
}

function tupleEditor(schema: TupleSchema, ctx: EditorCtx): Editor {
  const values = Array.isArray(ctx.value) ? (ctx.value as unknown[]) : [];
  const readings = schema.elements.map((e, i) =>
    editor(e, { name: `${ctx.name}[${i}]`, optional: false, value: values[i] }),
  );
  const wrap = el(
    "div",
    { class: "arr" },
    readings.map((r, i) =>
      el(
        "div",
        { class: "arr-item" },
        el("span", { class: "arr-index" }, String(i)),
        el("div", { class: "item-body" }, r.node),
      ),
    ),
  );
  return {
    node: wrap,
    read: () =>
      readings.map((r) => {
        const v = r.read();
        return v === OMIT ? undefined : v;
      }),
  };
}

function objectEditor(schema: ObjectSchema, ctx: EditorCtx): Editor {
  if (schema.properties.length === 0) return anyEditor(schema, ctx);

  interface FieldRead {
    prop: PropertySchema;
    includeBox: HTMLInputElement | null;
    sub: Editor;
  }
  const readings: FieldRead[] = [];
  const children: HTMLElement[] = [];
  const objValue =
    ctx.value && typeof ctx.value === "object" && !Array.isArray(ctx.value)
      ? (ctx.value as Record<string, unknown>)
      : null;

  for (const prop of schema.properties) {
    const initial = objValue ? objValue[prop.name] : undefined;
    const optional = prop.optional;
    let includeBox: HTMLInputElement | null = null;
    if (optional) {
      includeBox = el("input", { type: "checkbox" });
      includeBox.checked = initial !== undefined;
    }
    const sub = editor(prop.type, { name: prop.name, optional, value: initial });
    const field = el(
      "div",
      { class: "field" },
      el(
        "div",
        { class: "field-label" },
        el("span", { class: "fl-name" }, prop.name),
        el("span", { class: "fl-type" }, shortType(prop.typeText)),
        optional ? el("span", { class: "fl-opt" }, "optional") : null,
      ),
      sub.node,
    );
    const rowChildren: Child[] = [];
    if (includeBox) rowChildren.push(el("label", { class: "include-toggle" }, includeBox, "include"));
    const row = el("div", {}, ...rowChildren, field);
    children.push(row);
    readings.push({ prop, includeBox, sub });
  }

  const wrap = el(
    "div",
    { class: "obj" },
    el(
      "div",
      { class: "obj-title" },
      el("span", { class: "tag" }, schema.name || "object"),
      el("span", {}, `{ ${schema.properties.length} field${schema.properties.length > 1 ? "s" : ""} }`),
    ),
    ...children,
  );
  return {
    node: wrap,
    read: () => {
      const out: Record<string, unknown> = {};
      for (const r of readings) {
        if (r.includeBox && !r.includeBox.checked) continue;
        const v = r.sub.read();
        if (v === OMIT) continue;
        out[r.prop.name] = v;
      }
      return out;
    },
  };
}

function functionEditor(schema: FunctionSchema): Editor {
  return {
    node: el(
      "div",
      { class: "obj function-typed" },
      el("div", { class: "obj-title" }, "ƒ ", el("span", { class: "tag" }, schema.name || "function")),
      el("div", { class: "obj-note" }, "callbacks can't be sent as data — will be undefined"),
    ),
    read: () => OMIT,
  };
}

function anyEditor(_schema: TypeSchema, ctx: EditorCtx): Editor {
  const ta = el("textarea", { rows: "2", placeholder: 'JSON value, e.g. {"a": 1} or "text"' });
  if (ctx.value !== undefined) ta.value = typeof ctx.value === "string" ? ctx.value : JSON.stringify(ctx.value);
  return {
    node: ta,
    read: () => {
      const raw = ta.value.trim();
      if (raw === "") return ctx.optional ? OMIT : undefined;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return raw;
      }
    },
  };
}

function voidEditor(schema: TypeSchema, _ctx: EditorCtx): Editor {
  const label = schema.kind === "never" ? "never — nothing to pass" : `${schema.kind} — no value needed`;
  return { node: el("div", { class: "obj-note" }, label), read: () => undefined };
}

function editor(schema: TypeSchema | undefined, ctx: EditorCtx): Editor {
  if (!schema) return anyEditor({ kind: "any" }, ctx);
  switch (schema.kind) {
    case "primitive":
      return primitiveEditor(schema.name, ctx);
    case "literal":
      return literalEditor(schema);
    case "union":
      return unionEditor(schema, ctx);
    case "array":
      return arrayEditor(schema, ctx);
    case "tuple":
      return tupleEditor(schema, ctx);
    case "object":
      return objectEditor(schema, ctx);
    case "function":
      return functionEditor(schema);
    case "any":
    case "unknown":
    case "reference":
      return anyEditor(schema, ctx);
    default:
      return voidEditor(schema, ctx);
  }
}

/* ------------------------------------------------------------------ */
/* signature + node card rendering                                     */
/* ------------------------------------------------------------------ */
function signatureHTML(fn: FunctionInfo): string {
  const params = fn.params
    .map(
      (p) =>
        `<span class="s-pname">${esc(p.name)}</span>${p.optional ? "?" : ""}<span class="s-type">: ${esc(shortType(p.typeText))}</span>`,
    )
    .join(", ");
  return `<span class="s-name">${esc(fn.name)}</span>(${params})<span class="s-type">: </span><span class="s-ret">${esc(shortType(fn.returnType))}</span>`;
}

function nodeCardHTML(fn: FunctionInfo): string {
  const params = fn.params.length
    ? fn.params
        .map(
          (p) =>
            `<div class="node-param"><span class="pname">${esc(p.name)}</span><span class="pcolon">${p.optional ? "?:" : ":"}</span><span class="ptype">${esc(shortType(p.typeText))}</span></div>`,
        )
        .join("")
    : `<div class="node-empty-params">no parameters</div>`;
  const kindLabel = fn.kind === "init" ? "init" : fn.async ? "async" : "fn";
  return `
    <div class="node kind-${fn.kind}" data-id="${esc(fn.id)}">
      <div class="node-head">
        <span class="node-name">${esc(fn.name)}</span>
        <span class="node-kind">${kindLabel}</span>
      </div>
      <div class="node-params">${params}</div>
      <div class="node-return"><span class="rarrow">→</span><span class="rtype">${esc(shortType(fn.returnType))}</span></div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* layout                                                              */
/* ------------------------------------------------------------------ */
const NODE_W = 258;
const GAP_X = 96;
const GAP_Y = 34;
const HEAD = 56;
const ROW = 19;

function nodeHeight(fn: FunctionInfo): number {
  const rows = Math.max(1, fn.params.length);
  return HEAD + rows * ROW + 34;
}

function computeLayout(): void {
  const fns = state.graph.functions;
  const edges = state.graph.edges.filter(
    (e) => state.byId.has(e.from) && state.byId.has(e.to) && e.from !== e.to,
  );

  const out = new Map<string, string[]>(fns.map((f) => [f.id, []]));
  const indeg = new Map<string, number>(fns.map((f) => [f.id, 0]));
  const parents = new Map<string, string[]>(fns.map((f) => [f.id, []]));
  for (const e of edges) {
    out.get(e.from)!.push(e.to);
    indeg.set(e.to, indeg.get(e.to)! + 1);
    parents.get(e.to)!.push(e.from);
  }

  const layer = new Map<string, number>(fns.map((f) => [f.id, 0]));
  const deg = new Map(indeg);
  const queue = fns.filter((f) => deg.get(f.id) === 0).map((f) => f.id);
  const seen = new Set<string>();
  while (queue.length) {
    const u = queue.shift()!;
    seen.add(u);
    for (const v of out.get(u)!) {
      layer.set(v, Math.max(layer.get(v)!, layer.get(u)! + 1));
      deg.set(v, deg.get(v)! - 1);
      if (deg.get(v) === 0) queue.push(v);
    }
  }

  const groups = new Map<number, FunctionInfo[]>();
  for (const f of fns) {
    const l = layer.get(f.id)!;
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l)!.push(f);
  }
  const layerKeys = [...groups.keys()].sort((a, b) => a - b);

  const rank = new Map<string, number>(fns.map((f) => [f.id, 0]));
  for (let pass = 0; pass < 4; pass++) {
    for (const l of layerKeys) {
      const arr = groups.get(l)!;
      arr.forEach((f, i) => rank.set(f.id, i * 10));
      arr.sort((a, b) => bary(a, parents, rank) - bary(b, parents, rank));
    }
  }

  const pos = new Map<string, NodePos>();
  for (let li = 0; li < layerKeys.length; li++) {
    const arr = groups.get(layerKeys[li])!;
    let total = 0;
    for (const f of arr) total += nodeHeight(f) + GAP_Y;
    total = Math.max(0, total - GAP_Y);
    let y = -total / 2;
    for (const f of arr) {
      const h = nodeHeight(f);
      pos.set(f.id, { x: li * (NODE_W + GAP_X), y, w: NODE_W, h });
      y += h + GAP_Y;
    }
  }
  state.pos = pos;
}

function bary(fn: FunctionInfo, parents: Map<string, string[]>, rank: Map<string, number>): number {
  const ps = parents.get(fn.id) || [];
  if (!ps.length) return rank.get(fn.id) ?? 0;
  return ps.reduce((s, p) => s + (rank.get(p) ?? 0), 0) / ps.length;
}

/* ------------------------------------------------------------------ */
/* render                                                              */
/* ------------------------------------------------------------------ */
function render(): void {
  const nodesG = $<SVGGElement>("#nodes");
  const edgesG = $<SVGGElement>("#edges");
  nodesG.innerHTML = "";
  edgesG.innerHTML = "";

  $("#empty").classList.toggle("hidden", state.graph.functions.length > 0);

  const edgeEls = new Map<string, SVGPathElement>();
  for (const e of state.graph.edges) {
    const a = state.pos.get(e.from);
    const b = state.pos.get(e.to);
    if (!a || !b) continue;
    const path = svg("path", { class: "edge", d: edgePath(a, b) });
    path.appendChild(svg("title")).textContent = `${e.name}${e.count > 1 ? ` ×${e.count}` : ""}`;
    edgesG.appendChild(path);
    edgeEls.set(`${e.from}->${e.to}`, path);
  }
  state.edgeEls = edgeEls;

  for (const fn of state.graph.functions) {
    const p = state.pos.get(fn.id);
    if (!p) continue;
    const fo = svg("foreignObject", {
      x: p.x,
      y: p.y,
      width: p.w,
      height: p.h,
      class: `node-fo${fn.kind === "init" ? " init-fo" : ""}`,
      "data-id": fn.id,
    });
    fo.innerHTML = nodeCardHTML(fn);
    nodesG.appendChild(fo);
  }

  applyView();
  if (state.focusId && state.byId.has(state.focusId)) applyReachability(state.focusId);
}

function edgePath(a: NodePos, b: NodePos): string {
  const x1 = a.x + a.w;
  const y1 = a.y + a.h / 2;
  const x2 = b.x;
  const y2 = b.y + b.h / 2;
  const dist = Math.abs(x2 - x1);
  const dx = Math.max(46, dist * 0.5);
  if (x2 >= x1) {
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }
  const bow = 90;
  const midY = Math.max(a.y + a.h, b.y + b.h) + 60;
  return `M ${x1} ${y1} C ${x1 + bow} ${y1}, ${x1 + bow} ${midY}, ${(x1 + x2) / 2} ${midY} S ${x2 - bow} ${y2}, ${x2} ${y2}`;
}

/* ------------------------------------------------------------------ */
/* view / interaction                                                  */
/* ------------------------------------------------------------------ */
function applyView(): void {
  $<SVGGElement>("#viewport").setAttribute(
    "transform",
    `translate(${state.view.x},${state.view.y}) scale(${state.view.k})`,
  );
}

function fit(): void {
  const rect = $<SVGSVGElement>("#canvas").getBoundingClientRect();
  if (!state.pos.size) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of state.pos.values()) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + p.w);
    maxY = Math.max(maxY, p.y + p.h);
  }
  const pad = 90;
  const w = maxX - minX + pad * 2;
  const h = maxY - minY + pad * 2;
  const k = Math.min(rect.width / w, rect.height / h, 1.15);
  state.view.k = Math.max(0.2, k);
  state.view.x = rect.width / 2 - ((minX + maxX) / 2) * state.view.k;
  state.view.y = rect.height / 2 - ((minY + maxY) / 2) * state.view.k;
  applyView();
}

let dragging: DragState | null = null;
let backgroundDown = false;

function initCanvas(): void {
  const canvas = $<SVGSVGElement>("#canvas");

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const nk = Math.min(2.6, Math.max(0.18, state.view.k * factor));
      const wx = (mx - state.view.x) / state.view.k;
      const wy = (my - state.view.y) / state.view.k;
      state.view.x = mx - wx * nk;
      state.view.y = my - wy * nk;
      state.view.k = nk;
      applyView();
    },
    { passive: false },
  );

  canvas.addEventListener("mousedown", (e) => {
    const target = (e.target as Element | null)?.closest?.(".node") ?? null;
    if (target) return;
    dragging = { x: e.clientX, y: e.clientY, vx: state.view.x, vy: state.view.y, moved: false };
    backgroundDown = true;
    canvas.classList.add("grabbing");
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - dragging.x;
    const dy = e.clientY - dragging.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragging.moved = true;
    state.view.x = dragging.vx + dx;
    state.view.y = dragging.vy + dy;
    applyView();
  });

  window.addEventListener("mouseup", () => {
    const wasClick = backgroundDown && dragging !== null && !dragging.moved;
    dragging = null;
    backgroundDown = false;
    canvas.classList.remove("grabbing");
    if (wasClick) clearReachability();
  });

  $<SVGGElement>("#nodes").addEventListener("click", (e) => {
    const node = (e.target as Element | null)?.closest?.(".node") ?? null;
    if (!node) return;
    const id = node.getAttribute("data-id");
    if (id) selectNode(id);
  });

  $<HTMLButtonElement>("#btn-fit").addEventListener("click", fit);
  $<HTMLButtonElement>("#btn-reload").addEventListener("click", () => void loadGraph());
  $<HTMLButtonElement>("#btn-run").addEventListener("click", () => void runSelected());
  $<HTMLButtonElement>("#btn-clear").addEventListener("click", () => {
    if (state.selected) selectNode(state.selected.id, {});
  });
  $<HTMLButtonElement>("#btn-sample").addEventListener("click", autoFillForm);
  $<HTMLButtonElement>("#btn-init").addEventListener("click", () => void runInit());
  $<HTMLButtonElement>("#btn-play").addEventListener("click", () =>
    playTrace(state.playback.events, state.playback.items, true),
  );
  $<HTMLButtonElement>("#focus-clear").addEventListener("click", clearReachability);
  initSearch();
}

/* ------------------------------------------------------------------ */
/* search combobox                                                     */
/* ------------------------------------------------------------------ */
let searchResults: FunctionInfo[] = [];
let searchIndex = -1;

function highlightMatch(text: string, q: string): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx < 0) return esc(text);
  return (
    esc(text.slice(0, idx)) +
    "<mark>" +
    esc(text.slice(idx, idx + q.length)) +
    "</mark>" +
    esc(text.slice(idx + q.length))
  );
}

function renderSearchResults(q: string): void {
  const drop = $("#search-drop");
  drop.innerHTML = "";
  searchResults.forEach((fn, i) => {
    const item = el("div", {
      class: `sd-item${i === searchIndex ? " active" : ""}`,
      "data-index": String(i),
      role: "option",
    });
    item.appendChild(el("span", { class: "sd-name", html: highlightMatch(fn.name, q) }));
    if (fn.kind === "init") item.appendChild(el("span", { class: "sd-kind" }, "init"));
    item.appendChild(
      el("span", { class: "sd-params" }, fn.params.length ? `(${fn.params.map((p) => p.name).join(", ")})` : "()"),
    );
    item.appendChild(el("span", { class: "sd-file" }, fn.file));
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      chooseSearch(i);
    });
    item.addEventListener("mouseenter", () => {
      searchIndex = i;
      $$(".sd-item", drop).forEach((n, j) => n.classList.toggle("active", j === i));
    });
    drop.appendChild(item);
  });
}

function openSearch(query: string): void {
  const q = query.trim().toLowerCase();
  const drop = $("#search-drop");
  const input = $<HTMLInputElement>("#search-input");
  if (!q) {
    closeSearch();
    return;
  }
  searchResults = state.graph.functions
    .filter((f) => f.name.toLowerCase().includes(q) || f.file.toLowerCase().includes(q))
    .sort((a, b) => {
      const an = a.name.toLowerCase();
      const bn = b.name.toLowerCase();
      const ap = an.startsWith(q) ? 0 : 1;
      const bp = bn.startsWith(q) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return an.localeCompare(bn) || a.file.localeCompare(b.file);
    })
    .slice(0, 40);

  if (!searchResults.length) {
    drop.innerHTML = '<div class="sd-empty">no matching functions</div>';
    drop.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
    searchIndex = -1;
    return;
  }
  searchIndex = searchIndex < 0 || searchIndex >= searchResults.length ? 0 : searchIndex;
  renderSearchResults(q);
  drop.classList.remove("hidden");
  input.setAttribute("aria-expanded", "true");
}

function closeSearch(): void {
  $("#search-drop").classList.add("hidden");
  $<HTMLInputElement>("#search-input").setAttribute("aria-expanded", "false");
  searchIndex = -1;
}

function moveSearch(delta: number): void {
  if (!searchResults.length) return;
  searchIndex = (searchIndex + delta + searchResults.length) % searchResults.length;
  renderSearchResults($<HTMLInputElement>("#search-input").value.trim().toLowerCase());
  const active = q(".sd-item.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function chooseSearch(i: number): void {
  const fn = searchResults[i];
  if (!fn) return;
  closeSearch();
  const input = $<HTMLInputElement>("#search-input");
  input.value = fn.name;
  input.blur();
  selectNode(fn.id, { focus: true, keepFocus: true });
  applyReachability(fn.id);
}

function initSearch(): void {
  const input = $<HTMLInputElement>("#search-input");
  input.addEventListener("input", () => openSearch(input.value));
  input.addEventListener("focus", () => {
    if (input.value.trim()) openSearch(input.value);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if ($("#search-drop").classList.contains("hidden")) openSearch(input.value);
      else moveSearch(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveSearch(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (searchIndex >= 0) chooseSearch(searchIndex);
      else if (searchResults.length) chooseSearch(0);
    } else if (e.key === "Escape") {
      closeSearch();
      input.blur();
    }
  });
  input.addEventListener("blur", () => {
    setTimeout(closeSearch, 120);
  });

  document.addEventListener("click", (e) => {
    const target = e.target as Element | null;
    if (!target?.closest?.("#search")) closeSearch();
  });

  document.addEventListener("keydown", (e) => {
    const active = document.activeElement;
    const typing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement;
    if (e.key === "/" && !typing) {
      e.preventDefault();
      input.focus();
    }
  });
}

/* ------------------------------------------------------------------ */
/* selection + form                                                    */
/* ------------------------------------------------------------------ */
function selectNode(id: string, opts: SelectOpts = {}): void {
  const fn = state.byId.get(id);
  if (!fn) return;
  state.selected = fn;

  if (!opts.keepFocus) clearReachability();

  $$(".node").forEach((n) => n.classList.toggle("selected", n.getAttribute("data-id") === id));

  $("#panel-empty").classList.add("hidden");
  $("#panel-content").classList.remove("hidden");
  $("#fn-name").textContent = fn.name;
  $("#fn-file").textContent = `${fn.file}:${fn.line}`;
  const badge = $("#fn-badge");
  badge.textContent = fn.kind === "init" ? "app init" : fn.async ? "async" : fn.exported ? "exported fn" : "function";
  badge.classList.remove("hidden");
  $("#fn-sig").innerHTML = signatureHTML(fn);
  $("#run-output").innerHTML = "";

  buildForm(fn, opts.values ?? null);
  if (opts.focus) focusNode(id);
}

function focusNode(id: string): void {
  const p = state.pos.get(id);
  if (!p) return;
  const rect = $<SVGSVGElement>("#canvas").getBoundingClientRect();
  state.view.x = rect.width / 2 - (p.x + p.w / 2) * state.view.k;
  state.view.y = rect.height / 2 - (p.y + p.h / 2) * state.view.k;
  applyView();
}

/* ---- reachability focus (dim functions not called from the picked one) ---- */
function reachableFrom(id: string): Set<string> {
  const out = new Map<string, string[]>();
  for (const e of state.graph.edges) {
    const list = out.get(e.from);
    if (list) list.push(e.to);
    else out.set(e.from, [e.to]);
  }
  const set = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const u = stack.pop()!;
    if (set.has(u)) continue;
    set.add(u);
    for (const v of out.get(u) ?? []) stack.push(v);
  }
  return set;
}

function applyReachability(id: string): void {
  const fn = state.byId.get(id);
  if (!fn) return;
  state.focusId = id;
  const set = reachableFrom(id);

  $$(".node[data-id]").forEach((n) => {
    const nid = n.getAttribute("data-id");
    n.classList.toggle("dim", !nid || !set.has(nid));
  });
  for (const e of state.graph.edges) {
    const pathEl = state.edgeEls.get(`${e.from}->${e.to}`);
    if (pathEl) pathEl.classList.toggle("dim", !(set.has(e.from) && set.has(e.to)));
  }

  $("#focus-name").textContent = fn.name;
  $("#focus-banner").classList.remove("hidden");
}

function clearReachability(): void {
  if (!state.focusId) return;
  state.focusId = null;
  $$(".node.dim").forEach((n) => n.classList.remove("dim"));
  $$(".edge.dim").forEach((e) => e.classList.remove("dim"));
  $("#focus-banner").classList.add("hidden");
}

function buildForm(fn: FunctionInfo, values: unknown[] | null): void {
  const form = $("#fn-form");
  form.innerHTML = "";
  state.formRead = [];

  if (fn.params.length === 0) {
    form.appendChild(
      el("div", { class: "obj-note" }, fn.kind === "init" ? "Runs the app's top-level initialization." : "This function takes no parameters."),
    );
    return;
  }

  fn.params.forEach((p, i) => {
    const sub = editor(p.schema, {
      name: p.name,
      optional: p.optional,
      value: values ? values[i] : undefined,
    });
    const label = el(
      "div",
      { class: "field-label" },
      el("span", { class: "fl-name" }, p.name),
      el("span", { class: "fl-type" }, shortType(p.typeText)),
      p.optional ? el("span", { class: "fl-opt" }, "optional") : null,
      p.hasDefault ? el("span", { class: "fl-opt" }, `= ${p.defaultValue ?? ""}`) : null,
    );
    const field = el("div", { class: "field" }, label, sub.node);
    state.formRead.push(sub);
    form.appendChild(field);
  });
}

function autoFillForm(): void {
  const fn = state.selected;
  if (!fn) return;
  const values = fn.params.map((p) => sampleValue(p.schema, p.name));
  buildForm(fn, values);
}

async function runSelected(): Promise<void> {
  const fn = state.selected;
  if (!fn) return;
  if (fn.kind === "init") return runInit();

  const args = state.formRead.map((r) => {
    const v = r.read();
    return v === OMIT ? UNDEF : v;
  });

  setRunBusy(true);
  $("#run-output").innerHTML = "";
  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "function", name: fn.name, file: fn.file, args }),
    });
    const data = (await res.json()) as RunResult;
    showRunResult(data);
    playTrace(data.trace ?? [], null, true);
    showLoadErrors(data.loadErrors);
  } catch (e) {
    $("#run-output").innerHTML = `<div class="result-box error">${esc((e as Error).message)}</div>`;
  } finally {
    setRunBusy(false);
  }
}

async function runInit(): Promise<void> {
  setRunBusy(true);
  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "init" }),
    });
    const data = (await res.json()) as RunResult;
    playTrace(data.trace ?? data.initTrace ?? [], null, true);
    showLoadErrors(data.loadErrors);
  } catch (e) {
    $("#run-output").innerHTML = `<div class="result-box error">${esc((e as Error).message)}</div>`;
  } finally {
    setRunBusy(false);
  }
}

function setRunBusy(busy: boolean): void {
  const btn = q<HTMLButtonElement>("#btn-run");
  if (btn) {
    btn.disabled = busy;
    btn.textContent = busy ? "Running…" : "Run";
  }
}

function showRunResult(data: RunResult): void {
  const out = $("#run-output");
  out.innerHTML = "";
  if (data.error) {
    out.appendChild(el("div", { class: "result-box error", html: `<span class="rlabel">threw</span>${esc(data.error)}` }));
    return;
  }
  const box = el("div", { class: "result-box" });
  box.appendChild(el("span", { class: "rlabel" }, "return value"));
  box.appendChild(document.createTextNode(prettyArg(data.result, 0)));
  out.appendChild(box);
}

function showLoadErrors(errors?: string[]): void {
  if (!errors || !errors.length) return;
  const out = $("#run-output");
  out.appendChild(el("div", { class: "err-box" }, "load warnings:\n" + errors.join("\n")));
}

function prettyArg(arg: TraceArg | undefined, indent: number): string {
  if (!arg) return "undefined";
  const pad = "  ".repeat(indent);
  const pad2 = "  ".repeat(indent + 1);
  if (arg.entries) {
    const body = arg.entries.map((e) => `${pad2}${e.k}: ${prettyArg(e.v, indent + 1)}`).join("\n");
    return `{\n${body}\n${pad}}`;
  }
  if (arg.items) {
    const body = arg.items.map((e) => `${pad2}${prettyArg(e, indent + 1)}`).join("\n");
    return `[\n${body}\n${pad}]`;
  }
  return arg.short;
}

/* ------------------------------------------------------------------ */
/* trace playback                                                      */
/* ------------------------------------------------------------------ */
function nodeIdFor(file: string, name: string): string | null {
  const qualified = `${file}::${name}`;
  if (state.byId.has(qualified)) return qualified;
  for (const fn of state.graph.functions) if (fn.name === name) return fn.id;
  return null;
}

function clearTraceHighlights(): void {
  $$(".node").forEach((n) => n.classList.remove("active", "current", "done"));
  $$(".edge").forEach((e) => e.classList.remove("active", "current", "dim"));
  $$(".trace-item").forEach((t) => t.classList.remove("current"));
}

function playTrace(events: TraceEvent[], _items: HTMLElement[] | null, _animate: boolean): void {
  if (state.playback.timer) clearTimeout(state.playback.timer);
  state.playback.events = events;
  state.playback.index = -1;
  renderTraceList(events);
  clearTraceHighlights();
  if (!events.length) return;

  const list = $("#trace-list");
  const items = $$(".trace-item", list);
  state.playback.items = items;
  $<HTMLButtonElement>("#btn-play").disabled = false;

  const stack: { nid: string | null }[] = [];
  const stepMs = Math.max(110, Math.min(600, Math.round(5000 / events.length)));

  const step = (i: number): void => {
    if (i >= events.length) return;
    const ev = events[i];
    state.playback.index = i;
    items.forEach((it, idx) => it.classList.toggle("current", idx === i));
    items[i]?.scrollIntoView({ block: "nearest", behavior: "smooth" });

    const nid = nodeIdFor(ev.file, ev.name);
    if (ev.type === "enter") {
      const parent = stack[stack.length - 1];
      stack.push({ nid });
      if (parent?.nid && nid) {
        const edge = state.edgeEls.get(`${parent.nid}->${nid}`);
        if (edge) edge.classList.add("active");
      }
      if (nid) {
        const node = q<HTMLElement>(`.node[data-id="${cssEscape(nid)}"]`);
        if (node) {
          node.classList.add("active", "current");
          $$(".node.current").forEach((n) => {
            if (n !== node) n.classList.remove("current");
          });
        }
      }
    } else {
      stack.pop();
      if (nid) {
        const node = q<HTMLElement>(`.node[data-id="${cssEscape(nid)}"]`);
        if (node) {
          node.classList.remove("current");
          node.classList.add("done");
        }
      }
    }
    state.playback.timer = setTimeout(() => step(i + 1), stepMs);
  };

  step(0);
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}

function renderTraceList(events: TraceEvent[]): void {
  const list = $("#trace-list");
  list.innerHTML = "";
  $("#trace-count").textContent = events.length ? `${events.length} events` : "";
  if (!events.length) {
    list.appendChild(el("div", { class: "trace-empty" }, "No calls were traced for this run."));
    return;
  }
  events.forEach((ev, i) => {
    const indent = "· ".repeat(Math.min(ev.depth, 8));
    const head = el("div", { class: "ti-head" });
    head.appendChild(el("span", { class: "ti-depth" }, indent || "•"));
    head.appendChild(el("span", { class: "ti-kind" }, ev.type === "enter" ? "call" : "ret "));
    head.appendChild(el("span", { class: "ti-name" }, ev.name || ""));
    const item = el("div", {
      class: `trace-item ${ev.type}${ev.error ? " error" : ""}`,
      "data-index": String(i),
    });
    item.appendChild(head);

    if (ev.type === "enter" && ev.args && ev.args.length) {
      item.appendChild(el("div", { class: "ti-val" }, "args: " + ev.args.map((a) => a.short).join(", ")));
    }
    if (ev.type === "exit") {
      const txt = ev.error ? `⚠ ${ev.error}` : `→ ${prettyArg(ev.value, 0).replace(/\n/g, " ")}`;
      item.appendChild(el("div", { class: "ti-val" }, txt));
      if (ev.duration != null) item.appendChild(el("div", { class: "ti-meta" }, `${ev.duration} ms`));
    }
    item.addEventListener("click", () => {
      const nid = nodeIdFor(ev.file, ev.name);
      if (nid) selectNode(nid, { focus: true });
    });
    list.appendChild(item);
  });
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */
async function loadGraph(): Promise<void> {
  try {
    const res = await fetch("/api/graph");
    const graph = (await res.json()) as Graph;
    state.graph = graph;
    state.byId = new Map((graph.functions || []).map((f: FunctionInfo) => [f.id, f]));
    state.focusId = null;
    $("#focus-banner").classList.add("hidden");
    computeLayout();
    render();
    setTimeout(fit, 30);
  } catch (e) {
    console.error(e);
  }
}

async function boot(): Promise<void> {
  initCanvas();
  try {
    const meta = (await (await fetch("/api/meta")).json()) as { root: string; port: number };
    $("#project-name").textContent = meta.root;
  } catch {
    /* ignore */
  }
  await loadGraph();
}

void boot();

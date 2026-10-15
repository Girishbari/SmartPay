import type { Parameters, ParamType, Step, TargetMap } from "@lba/shared";

// Turns Playwright codegen output (--target playwright-test) into a Draft: Steps + Target Map + Parameters.
// Closed on purpose: only fill / click / "is visible" / "has text" are learned. Anything else is reported, never guessed.
// The recording is parsed as text; it is never evaluated or executed.

export type Draft = { steps: Step[]; target_map: TargetMap; parameters: Parameters; examples: Record<string, string>; problems: string[] };
type Call = { name: string; args: unknown[] };
type Locator = { by: string; name: string; role?: string };

// ---- tiny scanner for `a.b('x', { k: 'v' }).c()` ----
class Scan {
  i = 0;
  constructor(readonly s: string) {}
  ws() {
    while (/\s/.test(this.s[this.i] ?? "")) this.i++;
  }
  peek() {
    this.ws();
    return this.s[this.i];
  }
  eat(ch: string) {
    if (this.peek() !== ch) throw new Error(`expected "${ch}" at ${this.i}`);
    this.i++;
  }
  ident() {
    this.ws();
    const m = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i));
    if (!m) throw new Error(`expected a name at ${this.i}`);
    this.i += m[0].length;
    return m[0];
  }
  str(): string {
    const q = this.peek()!;
    this.i++;
    let out = "";
    while (this.i < this.s.length && this.s[this.i] !== q) {
      if (this.s[this.i] === "\\") this.i++;
      out += this.s[this.i++];
    }
    this.i++; // closing quote
    return out;
  }
  value(): unknown {
    const c = this.peek();
    if (c === "'" || c === '"' || c === "`") return this.str();
    if (c === "{") {
      this.i++;
      const obj: Record<string, unknown> = {};
      while (this.peek() !== "}") {
        const key = this.peek() === "'" || this.peek() === '"' ? this.str() : this.ident();
        this.eat(":");
        obj[key] = this.value();
        if (this.peek() === ",") this.i++;
      }
      this.i++;
      return obj;
    }
    const m = /^(true|false|-?[0-9.]+)/.exec(this.s.slice(this.i));
    if (!m) throw new Error(`unsupported argument at ${this.i}`);
    this.i += m[0].length;
    return m[0] === "true" ? true : m[0] === "false" ? false : Number(m[0]);
  }
  /** Parses `page.x(..).y(..)` (or any a.b() chain) into calls, skipping the leading `page`. */
  chain(): Call[] {
    const calls: Call[] = [];
    this.ident(); // page
    while (this.peek() === ".") {
      this.i++;
      const name = this.ident();
      this.eat("(");
      const args: unknown[] = [];
      while (this.peek() !== ")") {
        args.push(this.value());
        if (this.peek() === ",") this.i++;
      }
      this.i++;
      calls.push({ name, args });
    }
    return calls;
  }
}

const parseChain = (src: string) => new Scan(src).chain();

function toLocator(c: Call): Locator | null {
  const [a, b] = c.args;
  switch (c.name) {
    case "getByLabel": return { by: "label", name: String(a) };
    case "getByPlaceholder": return { by: "placeholder", name: String(a) };
    case "getByTestId": return { by: "testid", name: String(a) };
    case "getByText": return { by: "text", name: String(a) };
    case "getByRole": return { by: "role", role: String(a), name: String((b as { name?: string } | undefined)?.name ?? "") };
    case "locator": return { by: "css", name: String(a) };
    default: return null;
  }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const snake = (s: string) => s.replace(/-/g, "_");
const inferType = (v: string): ParamType =>
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v) ? "date" : v.trim() !== "" && Number.isFinite(Number(v)) ? "number" : "string";

type Raw = { line: number; kind: "fill" | "click" | "verify" | "read"; loc: Locator; value?: string };

export function convertRecording(code: string): Draft {
  const problems: string[] = [];
  const raws: Raw[] = [];

  code.split("\n").forEach((text, idx) => {
    const line = idx + 1;
    const st = text.trim().replace(/;$/, "");
    if (!st.startsWith("await ")) return; // imports, test(...) wrapper, braces, comments
    const body = st.slice(6);
    try {
      if (body.startsWith("page.goto(")) return; // the Agent opens the Target Instance's own URL
      if (body.startsWith("expect(")) {
        // expect(<page.locator chain>).toBeVisible() / .toHaveText('x')
        let depth = 0, end = -1;
        for (let k = 6; k < body.length; k++) {
          if (body[k] === "(") depth++;
          else if (body[k] === ")" && --depth === 0) { end = k; break; }
        }
        const inner = parseChain(body.slice(7, end));
        const check = parseChain(`x${body.slice(end + 1)}`)[0];
        const loc = inner.length === 1 ? toLocator(inner[0]) : null;
        if (!loc) return void problems.push(`line ${line}: unsupported locator in assertion`);
        if (check?.name === "toBeVisible") raws.push({ line, kind: "verify", loc });
        else if (check?.name === "toHaveText" || check?.name === "toContainText") raws.push({ line, kind: "read", loc, value: String(check.args[0]) });
        else problems.push(`line ${line}: unsupported assertion "${check?.name}" (use "assert visible" or "assert text")`);
        return;
      }
      const calls = parseChain(body);
      const loc = calls.length === 2 ? toLocator(calls[0]) : null;
      const act = calls[1];
      if (!loc || !act) return void problems.push(`line ${line}: unsupported statement (chained or unknown locator)`);
      if (act.name === "fill") raws.push({ line, kind: "fill", loc, value: String(act.args[0] ?? "") });
      else if (act.name === "click") raws.push({ line, kind: "click", loc });
      else problems.push(`line ${line}: "${act.name}" is not an approved action (only fill, click, assert visible, assert text)`);
    } catch (e) {
      problems.push(`line ${line}: could not read "${st.slice(0, 60)}" (${(e as Error).message})`);
    }
  });

  const steps: Step[] = [];
  const target_map: TargetMap = {};
  const parameters: Parameters = {};
  const examples: Record<string, string> = {};

  const nameFor = (loc: Locator) => {
    // Text with digits is dynamic (e.g. "Invoice INV-1004 created"): keep only the stable part before the first digit.
    if (loc.by === "text") {
      const stable = loc.name.split(/[0-9]/)[0].trim();
      if (stable) loc = { ...loc, name: stable };
    }
    const base = slug(loc.name) || slug(loc.role ?? loc.by);
    let name = base, n = 2;
    while (name in target_map && JSON.stringify(target_map[name]) !== JSON.stringify(loc)) name = `${base}-${n++}`;
    target_map[name] = loc;
    return name;
  };

  raws.forEach((r, i) => {
    const next = raws[i + 1];
    // codegen clicks a field before filling it; the click carries no meaning of its own
    if (r.kind === "click" && next?.kind === "fill" && JSON.stringify(next.loc) === JSON.stringify(r.loc)) return;
    const target = nameFor(r.loc);
    if (r.kind === "fill") {
      const p = snake(target);
      if (p in parameters) return void problems.push(`line ${r.line}: "${target}" is filled twice`);
      parameters[p] = { type: inferType(r.value ?? ""), required: true };
      examples[p] = r.value ?? "";
      steps.push({ action: "fill", target, value: `{{${p}}}` });
    } else if (r.kind === "click") steps.push({ action: "click", target });
    else if (r.kind === "verify") steps.push({ action: "verify", target });
    else steps.push({ action: "read", target, into: snake(target) });
  });

  // Commit Step: the last click before the first check, else the last click. A person can still change it at review.
  const firstCheck = steps.findIndex((s) => s.action === "verify" || s.action === "read");
  const upTo = firstCheck < 0 ? steps.length : firstCheck;
  for (let k = upTo - 1; k >= 0; k--)
    if (steps[k].action === "click") { steps[k].commit = true; break; }

  if (!steps.length && !problems.length) problems.push("the recording has no steps");
  return { steps, target_map, parameters, examples, problems };
}

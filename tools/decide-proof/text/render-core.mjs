// Template renderer core (contract section 5): parses a template (optional front matter with a `literals:` list, then words and
// {{<fact id>|<fmt>}} slots), fills each slot with the display text stored in facts.json, and returns the text plus the provenance
// spans [{start, end, fact, fmt, text}] (offsets in Unicode code points, end exclusive). Refuses unknown facts, unknown formats,
// malformed slots, unknown front-matter keys and any run of digits that is neither a slot nor inside a declared literal.
// Used by render.mjs and the tests; never reads a clock or a recording.
import { ALL_FORMATS, FactsError } from "../facts/facts-util.mjs";

const SLOT = /^\{\{\s*([^\s|{}]+)\s*\|\s*([A-Za-z0-9_]+)\s*\}\}/;
const BOM = String.fromCharCode(0xfeff);
const DIGITS = /\p{Nd}+/gu;

const where = (text, index) => {
  const before = text.slice(0, index);
  const line = before.split("\n").length;
  return `line ${line}, column ${index - (before.lastIndexOf("\n") + 1) + 1}`;
};

function unquote(item, label) {
  const s = item.trim();
  if (s.length >= 2 && s[0] === '"' && s.endsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      throw new FactsError(`${label}: bad double-quoted literal ${s}`);
    }
  }
  if (s.length >= 2 && s[0] === "'" && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function flowItems(inner, label) {
  const items = [];
  let cur = "";
  let quote = null;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      items.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (quote) throw new FactsError(`${label}: unclosed quote in the literals list`);
  items.push(cur);
  return items.filter((x) => x.trim() !== "");
}

// -> {literals: string[], body: string}
export function parseTemplate(text, label = "template") {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const open = /^---[ \t]*\r?\n/.exec(src);
  if (!open) return { literals: [], body: src };
  const rest = src.slice(open[0].length);
  const close = /(^|\n)---[ \t]*(\r?\n|$)/.exec(rest);
  if (!close) throw new FactsError(`${label}: front matter opened with --- is never closed`);
  const head = rest.slice(0, close.index + (close[1] ? 1 : 0));
  const body = rest.slice(close.index + close[0].length);
  const literals = [];
  let inList = false;
  for (const raw of head.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const key = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (key && !line.startsWith(" ") && !line.startsWith("\t")) {
      if (key[1] !== "literals") throw new FactsError(`${label}: unknown front-matter key ${JSON.stringify(key[1])} (only literals: is allowed)`);
      inList = true;
      const value = key[2].trim();
      if (value === "") continue;
      if (value === "[]") continue;
      if (!value.startsWith("[") || !value.endsWith("]")) throw new FactsError(`${label}: literals: takes a [a, b] list or a block of - items`);
      for (const item of flowItems(value.slice(1, -1), label)) literals.push(unquote(item, label));
      inList = false;
      continue;
    }
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (!inList || !item) throw new FactsError(`${label}: cannot read front-matter line ${JSON.stringify(line)}`);
    literals.push(unquote(item[1], label));
  }
  if (literals.some((l) => l === "")) throw new FactsError(`${label}: an empty literal`);
  return { literals, body };
}

const cpLength = (s) => {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
};

// Digit runs of `text` that are not wholly inside a slot span or a declared literal. Offsets are UTF-16 indexes here.
export function findUncoveredDigits(text, slotRanges, literals) {
  const covered = [...slotRanges];
  for (const literal of literals) {
    for (let i = text.indexOf(literal); i >= 0; i = text.indexOf(literal, i + 1)) covered.push([i, i + literal.length]);
  }
  const bad = [];
  for (const m of text.matchAll(DIGITS)) {
    const a = m.index;
    const b = a + m[0].length;
    if (!covered.some(([s, e]) => s <= a && b <= e)) bad.push({ index: a, run: m[0] });
  }
  return bad;
}

// facts: the parsed facts.json. -> {text, spans, literals}
export function renderTemplate(templateText, facts, label = "template") {
  if (!facts || facts.schema !== 1 || typeof facts.facts !== "object" || facts.facts === null) throw new FactsError("facts.json: schema 1 with a facts object is required");
  const { literals, body } = parseTemplate(templateText, label);
  let out = "";
  let cp = 0;
  const spans = [];
  const ranges = [];
  let i = 0;
  const plain = (chunk, offset) => {
    const stray = /\{\{|\}\}/.exec(chunk);
    if (stray) throw new FactsError(`${label}: stray ${stray[0]} at ${where(body, offset + stray.index)}`);
    out += chunk;
    cp += cpLength(chunk);
  };
  for (let open = body.indexOf("{{"); open >= 0; open = body.indexOf("{{", i)) {
    plain(body.slice(i, open), i);
    const m = SLOT.exec(body.slice(open));
    if (!m) throw new FactsError(`${label}: malformed slot at ${where(body, open)}; a slot is {{<fact id>|<fmt>}}`);
    const [, id, fmt] = m;
    if (!ALL_FORMATS.includes(fmt)) throw new FactsError(`${label}: unknown format ${JSON.stringify(fmt)} at ${where(body, open)}; formats are ${ALL_FORMATS.join(", ")}`);
    if (!Object.hasOwn(facts.facts, id)) throw new FactsError(`${label}: unknown fact ${JSON.stringify(id)} at ${where(body, open)}`);
    const display = facts.facts[id].display ?? {};
    if (!Object.hasOwn(display, fmt) || typeof display[fmt] !== "string") throw new FactsError(`${label}: fact ${id} has no display ${fmt} (it has: ${Object.keys(display).join(", ") || "none"}) at ${where(body, open)}`);
    const text = display[fmt];
    ranges.push([out.length, out.length + text.length]);
    spans.push({ start: cp, end: cp + cpLength(text), fact: id, fmt, text });
    out += text;
    cp += cpLength(text);
    i = open + m[0].length;
  }
  plain(body.slice(i), i);
  const bad = findUncoveredDigits(out, ranges, literals);
  if (bad.length > 0) {
    const shown = bad.slice(0, 5).map((b) => `${JSON.stringify(b.run)} at ${where(out, b.index)}`).join("; ");
    throw new FactsError(`${label}: digits that are neither a fact slot nor inside a declared literal: ${shown}${bad.length > 5 ? `; and ${bad.length - 5} more` : ""}`);
  }
  return { text: out, spans, literals };
}

// AD/text/<name>.md for the template file <name>[.tpl|.tmpl|.template][.md|.txt]
export function templateName(path) {
  const base = path.split(/[\\/]/).pop();
  const name = base.replace(/\.(tpl|tmpl|template)$/, "").replace(/\.(md|txt)$/, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new FactsError(`template file name ${JSON.stringify(base)} cannot become an output name`);
  return name;
}

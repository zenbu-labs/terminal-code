/**
 * 
 * ill definitely need to look into how we are writing to the ghostty config 
 * file that is quite an important step that we don't want to mess up
 * 
 * also ideally we have at least also kitty, will test that when i do linux reivew
 */
function skipLineComment(source: string, at: number): number {
  const end = source.indexOf("\n", at);
  return end < 0 ? source.length : end;
}

function skipBlockComment(source: string, at: number): number {
  const end = source.indexOf("*/", at + 2);
  return end < 0 ? source.length : end + 2;
}

function readString(source: string, at: number): { value: string; end: number } {
  let index = at + 1;
  let value = "";
  while (index < source.length) {
    const ch = source[index];
    if (ch === "\\") {
      value += source[index + 1] ?? "";
      index += 2;
      continue;
    }
    if (ch === '"') return { value, end: index + 1 };
    value += ch;
    index += 1;
  }
  return { value, end: index };
}

function skipTrivia(source: string, at: number): number {
  let index = at;
  while (index < source.length) {
    const ch = source[index];
    if (ch === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index);
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index);
      continue;
    }
    if (!/\s/.test(ch)) return index;
    index += 1;
  }
  return index;
}

function containerEnd(source: string, at: number): number {
  let index = at;
  let depth = 0;
  while (index < source.length) {
    const ch = source[index];
    if (ch === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index);
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index);
      continue;
    }
    if (ch === '"') {
      index = readString(source, index).end;
      continue;
    }
    if (ch === "{" || ch === "[") depth += 1;
    if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return index;
}

function valueEnd(source: string, at: number): number {
  const ch = source[at];
  if (ch === '"') return readString(source, at).end;
  if (ch === "{" || ch === "[") return containerEnd(source, at);
  let index = at;
  while (index < source.length) {
    const current = source[index];
    if (/\s/.test(current) || ",}]".includes(current)) break;
    if (current === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) break;
    index += 1;
  }
  return index;
}

function locate(source: string, key: string): { start: number; end: number } | null {
  let index = 0;
  let depth = 0;
  let found: { start: number; end: number } | null = null;
  while (index < source.length) {
    const ch = source[index];
    if (ch === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index);
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index);
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth += 1;
      index += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth -= 1;
      index += 1;
      continue;
    }
    if (ch === '"') {
      const literal = readString(source, index);
      if (depth === 1 && literal.value === key) {
        const colon = skipTrivia(source, literal.end);
        if (source[colon] === ":") {
          const start = skipTrivia(source, colon + 1);
          found = { start, end: valueEnd(source, start) };
        }
      }
      index = literal.end;
      continue;
    }
    index += 1;
  }
  return found;
}

function rootBrace(source: string): number {
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    if (ch === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index);
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index);
      continue;
    }
    if (ch === "{") return index;
    index += 1;
  }
  return -1;
}

function indentOf(source: string, afterBrace: number): string {
  const match = source.slice(afterBrace).match(/\n([ \t]+)\S/);
  return match ? match[1] : "  ";
}

export function setKey(source: string, key: string, value: unknown): string {
  const encoded = JSON.stringify(value);
  const text = source.trim() === "" ? "{}" : source;
  const found = locate(text, key);
  if (found) return text.slice(0, found.start) + encoded + text.slice(found.end);
  const brace = rootBrace(text);
  if (brace < 0) return `{\n  ${JSON.stringify(key)}: ${encoded}\n}\n`;
  const indent = indentOf(text, brace + 1);
  const empty = text[skipTrivia(text, brace + 1)] === "}";
  const line = `\n${indent}${JSON.stringify(key)}: ${encoded}${empty ? "" : ","}`;
  const rest = text.slice(brace + 1);
  const gap = empty && !rest.startsWith("\n") ? "\n" : "";
  return `${text.slice(0, brace + 1)}${line}${gap}${rest}`;
}

export function setKeys(source: string, entries: Record<string, unknown>): string {
  let text = source;
  for (const [key, value] of Object.entries(entries)) text = setKey(text, key, value);
  return text;
}

/** Reads a settings or keybindings file, which are json with comments and often
 * a trailing comma or two. */
export function parseJsonc<T = unknown>(source: string): T | null {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    if (ch === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index);
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index);
      continue;
    }
    if (ch === '"') {
      const end = readString(source, index).end;
      out += source.slice(index, end);
      index = end;
      continue;
    }
    // a trailing comma is one whose next real token closes the container;
    // strings were copied whole above, so a comma inside one never gets here
    if (ch === ",") {
      const next = source[skipTrivia(source, index + 1)];
      if (next === "}" || next === "]") {
        index += 1;
        continue;
      }
    }
    out += ch;
    index += 1;
  }
  try {
    return JSON.parse(out) as T;
  } catch {
    return null;
  }
}

export function readKey(source: string, key: string): unknown {
  const found = locate(source, key);
  if (!found) return undefined;
  try {
    return JSON.parse(source.slice(found.start, found.end));
  } catch {
    return undefined;
  }
}

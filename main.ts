// mend: apply the edits AI models write, in four formats, to a tree of text files.
// See SPEC.md for the whole specification. Node 22+, standard library only.
//
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// When MAKEFUN_ENV_URL is set, the trial is handed over to runner.ts instead.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { runTrial } from './runner.ts';

if (process.env.MAKEFUN_ENV_URL) {
  await runTrial(process.env.MAKEFUN_ENV_URL);
  process.exit(0);
}

/** A parse fault, carrying the 1-based patch line to report. */
class ParseErr extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

/** A usage error (SPEC section 1). */
class UsageErr extends Error {}

function out(s: string): void {
  process.stdout.write(s + '\n');
}

/* ------------------------------------------------------------------ */
/* Lines                                                               */
/* ------------------------------------------------------------------ */

/** A patch's lines: split at \n, one trailing \r removed from each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  const parts = text.split('\n');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].endsWith('\r')) parts[i] = parts[i].slice(0, -1);
  }
  if (text.endsWith('\n')) parts.pop();
  return parts;
}

interface FileLines {
  lines: string[];
  br: string; // '\n' or '\r\n'
  ends: boolean; // the file ends with a line break
}

/** Split a file's text at its own line break (CRLF when its first LF follows a CR, else LF). */
function splitLines(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const firstLF = text.indexOf('\n');
  const br = firstLF > 0 && text[firstLF - 1] === '\r' ? '\r\n' : '\n';
  const ends = text.endsWith(br);
  const body = ends ? text.slice(0, -br.length) : text;
  return { lines: body.split(br), br, ends };
}

function joinLines(f: FileLines): string {
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}

const rtrimWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWS = (s: string): string => /^[ \t]*/.exec(s)![0];

/* ------------------------------------------------------------------ */
/* Matching (SPEC section 5)                                           */
/* ------------------------------------------------------------------ */

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimWS(a) === rtrimWS(b);
  return trimWS(a) === trimWS(b);
}

/** All start positions where O matches lines at the tier, searching from `from`. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j], o[j], tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface NewLine {
  text: string;
  ctx: boolean; // a context line: written as the file's own matched line
  oIdx: number; // for a context line, its index into O
}

/** Build the replacement lines for N: context lines come from the file, other lines are re-indented at tier 2. */
function buildReplacement(n: NewLine[], fileLines: string[], occ: number, o: string[], tier: number): string[] {
  const out: string[] = [];
  let p = '';
  let f = '';
  if (tier === 2 && o.length > 0) {
    p = leadingWS(o[0]);
    f = leadingWS(fileLines[occ]);
  }
  for (const nl of n) {
    if (nl.ctx) {
      out.push(fileLines[occ + nl.oIdx]);
      continue;
    }
    let t = nl.text;
    if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/** Split hunk/chunk body lines into O (context + old) and N (context + new). */
function splitBody(body: string[]): { o: string[]; n: NewLine[]; bsAfterLast: boolean; bsAfterLastPlus: boolean } {
  const o: string[] = [];
  const n: NewLine[] = [];
  let lastCtxOrNew = -1;
  let lastPlus = -1;
  for (let bi = 0; bi < body.length; bi++) {
    const l = body[bi];
    if (l === '') {
      o.push('');
      n.push({ text: '', ctx: true, oIdx: o.length - 1 });
      lastCtxOrNew = bi;
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      o.push(t);
      n.push({ text: t, ctx: true, oIdx: o.length - 1 });
      lastCtxOrNew = bi;
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1), ctx: false, oIdx: -1 });
      lastCtxOrNew = bi;
      lastPlus = bi;
    }
    // a '\' line names no line of its own
  }
  const bsAfter = (idx: number): boolean =>
    idx !== -1 && idx + 1 < body.length && body[idx + 1].length > 0 && body[idx + 1][0] === '\\';
  return { o, n, bsAfterLast: bsAfter(lastCtxOrNew), bsAfterLastPlus: bsAfter(lastPlus) };
}

/* ------------------------------------------------------------------ */
/* The tree                                                            */
/* ------------------------------------------------------------------ */

class Tree {
  private map = new Map<string, { initial: string | null; current: string | null }>();

  private ensure(p: string): { initial: string | null; current: string | null } {
    let e = this.map.get(p);
    if (!e) {
      let initial: string | null = null;
      try {
        initial = readFileSync(p, 'utf8');
      } catch {
        initial = null;
      }
      e = { initial, current: initial };
      this.map.set(p, e);
    }
    return e;
  }

  get(p: string): string | null {
    return this.ensure(p).current;
  }

  initial(p: string): string | null {
    return this.ensure(p).initial;
  }

  set(p: string, text: string): void {
    this.ensure(p).current = text;
  }

  del(p: string): void {
    this.ensure(p).current = null;
  }

  touched(): string[] {
    return [...this.map.keys()];
  }

  writeAll(): void {
    for (const [p, e] of this.map) {
      if (e.current === e.initial) continue;
      if (e.current === null) {
        try {
          rmSync(p, { force: true });
        } catch {
          /* a path that cannot be removed is left alone */
        }
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, e.current);
      }
    }
  }
}

/** A path is safe when it is not empty, does not start with /, holds no \, and no segment is empty, . or ... */
function isSafe(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Edits                                                               */
/* ------------------------------------------------------------------ */

interface Failed {
  code: string;
  path: string;
}

interface Ctx {
  strict: boolean;
  moves: { old: string; nw: string }[];
}

interface Edit {
  paths: string[];
  apply(tree: Tree, ctx: Ctx): Failed | null;
}

/** Apply a list of hunks/chunks to a file's lines. Returns 'no-match' when some O is not found. */
function applyHunks(f: FileLines, hunks: { a: number; o: string[]; n: NewLine[]; bsAfterLast: boolean }[], strict: boolean): string | null {
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const idx = Math.min(h.a + d, f.lines.length);
      const atEnd = idx === f.lines.length;
      const ins = h.n.map((nl) => nl.text);
      f.lines.splice(idx, 0, ...ins);
      if (atEnd) f.ends = !h.bsAfterLast;
      d += h.n.length;
      continue;
    }
    const found = findTier(f.lines, h.o, strict);
    if (!found) return 'no-match';
    const target = h.a - 1 + d;
    let best = found.occ[0];
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const atEnd = best + h.o.length === f.lines.length;
    const rep = buildReplacement(h.n, f.lines, best, h.o, found.tier);
    f.lines.splice(best, h.o.length, ...rep);
    if (atEnd) f.ends = !h.bsAfterLast;
    d += h.n.length - h.o.length;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Command line (SPEC section 1)                                       */
/* ------------------------------------------------------------------ */

const FORMATS = ['unified', 'search-replace', 'v4a', 'json', 'auto'];

function parseArgs(argv: string[]): { format: string; check: boolean; strict: boolean; patch: string | null } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let seenCheck = false;
  let seenStrict = false;
  let seenFormat = false;
  const pos: string[] = [];
  let endOpts = false;
  for (const a of argv) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seenCheck) throw new UsageErr();
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) throw new UsageErr();
        seenStrict = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) throw new UsageErr();
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) throw new UsageErr();
        format = v;
      } else {
        throw new UsageErr();
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) throw new UsageErr();
  return { format: format ?? 'auto', check, strict, patch: pos.length === 1 ? pos[0] : null };
}

/* ------------------------------------------------------------------ */
/* Format detection (SPEC section 4)                                   */
/* ------------------------------------------------------------------ */

function detectFormat(lines: string[]): string | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const m = /\S/.exec(lines[first]);
  if (m && (m[0] === '[' || m[0] === '{')) return 'json';
  for (const l of lines) {
    if (rtrimWS(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC section 6)                                      */
/* ------------------------------------------------------------------ */

interface UniHunk {
  a: number;
  body: string[];
}

interface UniSection {
  diffOld: string | undefined;
  diffNew: string | undefined;
  dashOld: string | null | undefined; // null = /dev/null
  dashNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  hasDashPair: boolean;
  creationFlag: boolean;
  deletionFlag: boolean;
  hunks: UniHunk[];
}

/** The path after `--- ` / `+++ `: text after four characters, up to the first tab, spaces removed. */
function dashPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab !== -1) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

function diffGitPaths(line: string): [string, string] | null {
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  return m ? [m[1], m[2]] : null;
}

function parseHunkHeader(line: string, idx: number): number {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) throw new ParseErr(idx + 1);
  return parseInt(m[1], 10);
}

/** A hunk's body: lines starting with ' ', '-', '+' or '\', or empty; ends at the first other line. */
function parseHunkBody(lines: string[], start: number): { body: string[]; next: number } {
  const body: string[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      i++;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, next: i };
}

function parseUnified(lines: string[]): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;

  const startSection = (): UniSection => {
    if (cur) sections.push(cur);
    cur = {
      diffOld: undefined,
      diffNew: undefined,
      dashOld: undefined,
      dashNew: undefined,
      renameOld: undefined,
      renameNew: undefined,
      hasDashPair: false,
      creationFlag: false,
      deletionFlag: false,
      hunks: [],
    };
    inHeader = true;
    return cur;
  };

  const startDiffSection = (line: string, idx: number): void => {
    const paths = diffGitPaths(line);
    if (!paths) throw new ParseErr(idx + 1);
    const s = startSection();
    s.diffOld = paths[0];
    s.diffNew = paths[1];
  };

  const startDashSection = (line: string, nextLine: string): void => {
    const s = startSection();
    s.dashOld = dashPath(line);
    s.dashNew = dashPath(nextLine);
    s.hasDashPair = true;
  };

  const addHunk = (line: string, idx: number, i: number): number => {
    const a = parseHunkHeader(line, idx);
    const { body, next } = parseHunkBody(lines, i + 1);
    cur!.hunks.push({ a, body });
    inHeader = false;
    return next;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (cur === null) {
      if (line.startsWith('diff --git ')) {
        startDiffSection(line, i);
        i++;
      } else if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        startDashSection(line, lines[i + 1]);
        i += 2;
      } else if (line.startsWith('@@')) {
        throw new ParseErr(i + 1);
      } else {
        i++; // prose, code fences and anything else outside a section is ignored
      }
    } else if (inHeader) {
      if (line.startsWith('diff --git ')) {
        startDiffSection(line, i);
        i++;
      } else if (line.startsWith('--- ')) {
        if (i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
          if (cur.hasDashPair) {
            startDashSection(line, lines[i + 1]);
          } else {
            cur.dashOld = dashPath(line);
            cur.dashNew = dashPath(lines[i + 1]);
            cur.hasDashPair = true;
          }
          i += 2;
        } else {
          throw new ParseErr(i + 2);
        }
      } else if (line.startsWith('@@')) {
        i = addHunk(line, i, i);
      } else if (line.startsWith('rename from ')) {
        cur.renameOld = line.slice('rename from '.length).trim();
        i++;
      } else if (line.startsWith('rename to ')) {
        cur.renameNew = line.slice('rename to '.length).trim();
        i++;
      } else if (line.startsWith('new file mode')) {
        cur.creationFlag = true;
        i++;
      } else if (line.startsWith('deleted file mode')) {
        cur.deletionFlag = true;
        i++;
      } else {
        i++; // index, modes, similarity lines and anything else in a header is ignored
      }
    } else {
      // between hunks of the same section
      if (line.startsWith('@@')) {
        i = addHunk(line, i, i);
      } else if (line.startsWith('diff --git ')) {
        startDiffSection(line, i);
        i++;
      } else if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        startDashSection(line, lines[i + 1]);
        i += 2;
      } else {
        i++; // prose and anything else between hunks is ignored
      }
    }
  }
  if (cur) sections.push(cur);

  return sections.map((sec) => makeUnifiedEdit(sec));
}

function makeUnifiedEdit(sec: UniSection): Edit {
  const oldPath = sec.dashOld !== undefined ? sec.dashOld : sec.renameOld !== undefined ? sec.renameOld : sec.diffOld;
  const newPath = sec.dashNew !== undefined ? sec.dashNew : sec.renameNew !== undefined ? sec.renameNew : sec.diffNew;
  const creation = sec.creationFlag || oldPath === null;
  const deletion = !creation && (sec.deletionFlag || newPath === null);
  const move = !creation && !deletion && oldPath !== undefined && newPath !== undefined && oldPath !== null && newPath !== null && oldPath !== newPath;
  const paths: string[] = [];
  if (creation && newPath) paths.push(newPath);
  else if (deletion && oldPath) paths.push(oldPath);
  else if (move) paths.push(oldPath as string, newPath as string);
  else if (oldPath) paths.push(oldPath);

  const hunks = sec.hunks.map((h) => {
    const s = splitBody(h.body);
    return { a: h.a, o: s.o, n: s.n, bsAfterLast: s.bsAfterLast };
  });

  return {
    paths,
    apply(tree: Tree, ctx: Ctx): Failed | null {
      if (creation) {
        if (!newPath) return null; // both paths are /dev/null: no file to create
        const p = newPath as string;
        if (tree.get(p) !== null) return { code: 'exists', path: p };
        const plus: string[] = [];
        let ends = false;
        let foundPlus = false;
        for (const h of sec.hunks) {
          const s = splitBody(h.body);
          for (const nl of s.n) if (!nl.ctx) plus.push(nl.text);
          if (s.n.some((nl) => !nl.ctx)) {
            foundPlus = true;
            ends = !s.bsAfterLastPlus;
          }
        }
        if (!foundPlus) ends = false;
        tree.set(p, plus.length === 0 ? '' : plus.join('\n') + (ends ? '\n' : ''));
        return null;
      }
      if (deletion) {
        const p = oldPath as string;
        if (tree.get(p) === null) return { code: 'missing', path: p };
        tree.del(p);
        return null;
      }
      if (move) {
        const op = oldPath as string;
        const np = newPath as string;
        if (tree.get(op) === null) return { code: 'missing', path: op };
        if (tree.get(np) !== null) return { code: 'exists', path: np };
        const f = splitLines(tree.get(op)!);
        const fail = applyHunks(f, hunks, ctx.strict);
        if (fail) return { code: fail, path: op };
        tree.del(op);
        tree.set(np, joinLines(f));
        ctx.moves.push({ old: op, nw: np });
        return null;
      }
      // change of one path (both paths null, or equal paths, with no creation/deletion flag)
      const p = (oldPath ?? newPath) as string | undefined;
      if (p === undefined) return null; // no file is named: nothing to change
      if (tree.get(p) === null) return { code: 'missing', path: p };
      const f = splitLines(tree.get(p)!);
      const fail = applyHunks(f, hunks, ctx.strict);
      if (fail) return { code: fail, path: p };
      tree.set(p, joinLines(f));
      return null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC section 7)                              */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (rtrimWS(lines[i]) !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const sIdx = i;
    let path: string | null = null;
    for (let j = sIdx - 1; j > prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new ParseErr(sIdx + 1);
    }
    let eq = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      const t = rtrimWS(lines[j]);
      if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') break;
      if (t === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new ParseErr(sIdx + 1);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = rtrimWS(lines[j]);
      if (t === '<<<<<<< SEARCH') break;
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new ParseErr(sIdx + 1);
    const oldLines = lines.slice(sIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push({
      paths: [p],
      apply(tree: Tree, ctx: Ctx): Failed | null {
        if (oldLines.length === 0) {
          if (tree.get(p) !== null) return { code: 'exists', path: p };
          tree.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
          return null;
        }
        const cur = tree.get(p);
        if (cur === null) return { code: 'missing', path: p };
        const f = splitLines(cur);
        const found = findTier(f.lines, oldLines, ctx.strict);
        if (!found) return { code: 'no-match', path: p };
        if (found.occ.length > 1) return { code: 'ambiguous', path: p };
        const rep = buildReplacement(
          newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 })),
          f.lines,
          found.occ[0],
          oldLines,
          found.tier,
        );
        f.lines.splice(found.occ[0], oldLines.length, ...rep);
        tree.set(p, joinLines(f));
        return null;
      },
    });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC section 8)                                        */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number; // 1-based line of the section's start line
  moveTo: string | undefined;
  addLines: string[];
  chunks: VChunk[];
}

function parseV4A(lines: string[]): Edit[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) throw new ParseErr(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  if (lines[last].trim() !== '*** End Patch') throw new ParseErr(lines.length + 1);

  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let openChunk: VChunk | null = null;
  let sawEof = false; // the current chunk was closed by *** End of File

  const finalize = (): void => {
    if (!cur) return;
    if (cur.kind === 'add') {
      while (cur.addLines.length > 0 && cur.addLines[cur.addLines.length - 1] === '') cur.addLines.pop();
    } else if (cur.kind === 'update') {
      if (cur.chunks.length > 0) {
        const body = cur.chunks[cur.chunks.length - 1].body;
        while (body.length > 0 && body[body.length - 1] === '') body.pop();
      }
      if (cur.chunks.length === 0 && cur.moveTo === undefined) throw new ParseErr(cur.line);
    }
    cur = null;
    openChunk = null;
    sawEof = false;
  };

  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

  let i = first + 1;
  while (i < last) {
    const l = lines[i];
    if (l.trim() === '') {
      // A blank line inside a section is content (a file line, or an empty context line of a chunk);
      // between sections it is ignored. Trailing ones are dropped when the section is finalised.
      if (cur) {
        if (cur.kind === 'add') cur.addLines.push('');
        else if (cur.kind === 'update') {
          if (!openChunk) {
            if (cur.chunks.length === 0 && !sawEof) {
              openChunk = { anchor: null, body: [], eof: false };
              cur.chunks.push(openChunk);
              openChunk.body.push('');
            }
            // Otherwise the blank line is at the end of the section (or between
            // chunks): it is not part of any chunk and is ignored.
          } else {
            openChunk.body.push('');
          }
        }
        // in a Delete section a blank line is nothing
      }
      i++;
      continue;
    }
    if (isSectionStart(l)) {
      finalize();
      const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : 'update';
      const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
      cur = { kind, path: l.slice(prefix.length).trim(), line: i + 1, moveTo: undefined, addLines: [], chunks: [] };
      sections.push(cur);
      openChunk = null;
      sawEof = false;
      i++;
      continue;
    }
    if (cur === null) throw new ParseErr(i + 1);
    if (cur.kind === 'add') {
      if (l.startsWith('+')) cur.addLines.push(l.slice(1));
      else throw new ParseErr(i + 1);
      i++;
      continue;
    }
    if (cur.kind === 'delete') {
      throw new ParseErr(i + 1);
    }
    // update section
    if (l.startsWith('*** Move to: ')) {
      if (cur.moveTo !== undefined || cur.chunks.length > 0 || openChunk !== null) throw new ParseErr(i + 1);
      cur.moveTo = l.slice('*** Move to: '.length).trim();
      i++;
      continue;
    }
    if (l === '*** End of File') {
      if (!openChunk) throw new ParseErr(i + 1);
      openChunk.eof = true;
      openChunk = null;
      sawEof = true;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      openChunk = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      cur.chunks.push(openChunk);
      sawEof = false;
      i++;
      continue;
    }
    if (l === ' ' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (!openChunk) {
        if (cur.chunks.length === 0 && !sawEof) {
          openChunk = { anchor: null, body: [], eof: false };
          cur.chunks.push(openChunk);
        } else throw new ParseErr(i + 1);
      }
      openChunk.body.push(l);
      i++;
      continue;
    }
    throw new ParseErr(i + 1);
  }
  finalize();

  return sections.map((sec) => makeV4AEdit(sec));
}

function makeV4AEdit(sec: VSection): Edit {
  const paths: string[] = [sec.path];
  if (sec.moveTo !== undefined) paths.push(sec.moveTo);
  return {
    paths,
    apply(tree: Tree, ctx: Ctx): Failed | null {
      if (sec.kind === 'add') {
        if (tree.get(sec.path) !== null) return { code: 'exists', path: sec.path };
        tree.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
        return null;
      }
      if (sec.kind === 'delete') {
        if (tree.get(sec.path) === null) return { code: 'missing', path: sec.path };
        tree.del(sec.path);
        return null;
      }
      // update
      const cur = tree.get(sec.path);
      if (cur === null) return { code: 'missing', path: sec.path };
      if (sec.moveTo !== undefined && tree.get(sec.moveTo) !== null) return { code: 'exists', path: sec.moveTo };
      const f = splitLines(cur);
      let cursor = 0;
      for (const ch of sec.chunks) {
        if (ch.anchor !== null) {
          let foundIdx = -1;
          const maxTier = ctx.strict ? 0 : 2;
          for (let t = 0; t <= maxTier && foundIdx === -1; t++) {
            for (let k = cursor; k < f.lines.length; k++) {
              if (lineEq(f.lines[k], ch.anchor, t)) {
                foundIdx = k;
                break;
              }
            }
          }
          if (foundIdx === -1) return { code: 'no-match', path: sec.path };
          cursor = foundIdx + 1;
        }
        const s = splitBody(ch.body);
        if (s.o.length === 0) {
          const insPos = ch.eof ? f.lines.length : cursor;
          const ins = s.n.map((nl) => nl.text);
          f.lines.splice(insPos, 0, ...ins);
          cursor = insPos + ins.length;
          continue;
        }
        let occ: number;
        let tier: number;
        if (ch.eof) {
          // only an occurrence that ends at the file's last line
          const start = f.lines.length - s.o.length;
          if (start < cursor) return { code: 'no-match', path: sec.path };
          let hit: number | null = null;
          const maxTier = ctx.strict ? 0 : 2;
          for (let t = 0; t <= maxTier; t++) {
            let ok = true;
            for (let j = 0; j < s.o.length; j++) {
              if (!lineEq(f.lines[start + j], s.o[j], t)) {
                ok = false;
                break;
              }
            }
            if (ok) {
              hit = t;
              break;
            }
          }
          if (hit === null) return { code: 'no-match', path: sec.path };
          occ = start;
          tier = hit;
        } else {
          const found = findTier(f.lines, s.o, ctx.strict, cursor);
          if (!found) return { code: 'no-match', path: sec.path };
          occ = found.occ[0];
          tier = found.tier;
        }
        const rep = buildReplacement(s.n, f.lines, occ, s.o, tier);
        f.lines.splice(occ, s.o.length, ...rep);
        cursor = occ + rep.length;
      }
      const text = joinLines(f);
      if (sec.moveTo !== undefined) {
        tree.del(sec.path);
        tree.set(sec.moveTo, text);
        ctx.moves.push({ old: sec.path, nw: sec.moveTo });
      } else {
        tree.set(sec.path, text);
      }
      return null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC section 9)                                         */
/* ------------------------------------------------------------------ */

type JEdit =
  | { command: 'create'; path: string; file_text: string }
  | { command: 'str_replace'; path: string; old_str: string; new_str: string }
  | { command: 'insert'; path: string; insert_line: number; new_str: string };

function validateJSONEdit(obj: unknown, line: number): JEdit {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new ParseErr(line);
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') throw new ParseErr(line);
  if (typeof o.command !== 'string') throw new ParseErr(line);
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throw new ParseErr(line);
    return { command: 'create', path: o.path, file_text: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') throw new ParseErr(line);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw new ParseErr(line);
    return { command: 'str_replace', path: o.path, old_str: o.old_str, new_str: typeof o.new_str === 'string' ? o.new_str : '' };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) throw new ParseErr(line);
    if (typeof o.new_str !== 'string') throw new ParseErr(line);
    return { command: 'insert', path: o.path, insert_line: o.insert_line, new_str: o.new_str };
  }
  throw new ParseErr(line);
}

function parseJSON(lines: string[], rawText: string): Edit[] {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) return [];
  const firstChar = /\S/.exec(lines[firstIdx])![0];
  const edits: JEdit[] = [];
  if (firstChar === '[') {
    let arr: unknown;
    try {
      arr = JSON.parse(rawText);
    } catch {
      throw new ParseErr(firstIdx + 1);
    }
    if (!Array.isArray(arr)) throw new ParseErr(firstIdx + 1);
    for (const el of arr) edits.push(validateJSONEdit(el, firstIdx + 1));
  } else {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() === '') continue;
      let obj: unknown;
      try {
        obj = JSON.parse(l);
      } catch {
        throw new ParseErr(i + 1);
      }
      edits.push(validateJSONEdit(obj, i + 1));
    }
  }
  return edits.map((e) => makeJSONEdit(e));
}

function makeJSONEdit(e: JEdit): Edit {
  return {
    paths: [e.path],
    apply(tree: Tree): Failed | null {
      if (e.command === 'create') {
        if (tree.get(e.path) !== null) return { code: 'exists', path: e.path };
        tree.set(e.path, e.file_text);
        return null;
      }
      if (e.command === 'str_replace') {
        const cur = tree.get(e.path);
        if (cur === null) return { code: 'missing', path: e.path };
        const f = splitLines(cur);
        let text = cur;
        let oldS = e.old_str;
        let newS = e.new_str;
        if (f.br === '\r\n') {
          text = cur.replace(/\r\n/g, '\n');
          oldS = e.old_str.replace(/\r\n/g, '\n');
          newS = e.new_str.replace(/\r\n/g, '\n');
        }
        let count = 0;
        let first = -1;
        let idx = 0;
        while (count < 2) {
          const p = text.indexOf(oldS, idx);
          if (p === -1) break;
          count++;
          if (first === -1) first = p;
          idx = p + 1;
        }
        if (count === 0) return { code: 'no-match', path: e.path };
        if (count > 1) return { code: 'ambiguous', path: e.path };
        let res = text.slice(0, first) + newS + text.slice(first + oldS.length);
        if (f.br === '\r\n') res = res.replace(/\n/g, '\r\n');
        tree.set(e.path, res);
        return null;
      }
      // insert
      const cur = tree.get(e.path);
      if (cur === null) return { code: 'missing', path: e.path };
      const f = splitLines(cur);
      if (e.insert_line < 0 || e.insert_line > f.lines.length) return { code: 'no-match', path: e.path };
      const nl = e.new_str === '' ? [] : patchLines(e.new_str);
      f.lines.splice(e.insert_line, 0, ...nl);
      tree.set(e.path, joinLines(f));
      return null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Main (SPEC sections 1, 2, 10)                                       */
/* ------------------------------------------------------------------ */

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** The exit-0 change lines, in byte order of the paths (a move line sorts by its new path). */
function changeLines(tree: Tree, moves: { old: string; nw: string }[]): string[] {
  const lines: { key: string; text: string }[] = [];
  const accountedOld = new Set<string>();
  const accountedNew = new Set<string>();
  for (const m of moves) {
    const initOld = tree.initial(m.old);
    const finOld = tree.get(m.old);
    const initNew = tree.initial(m.nw);
    const finNew = tree.get(m.nw);
    if (initOld !== null && finOld === null && initNew === null && finNew !== null) {
      lines.push({ key: m.nw, text: `R ${m.old} -> ${m.nw}` });
      accountedOld.add(m.old);
      accountedNew.add(m.nw);
    }
  }
  for (const p of tree.touched()) {
    const init = tree.initial(p);
    const fin = tree.get(p);
    if (init === fin) continue;
    if (accountedOld.has(p) || accountedNew.has(p)) continue;
    if (init === null) lines.push({ key: p, text: `A ${p}` });
    else if (fin === null) lines.push({ key: p, text: `D ${p}` });
    else lines.push({ key: p, text: `M ${p}` });
  }
  lines.sort((a, b) => byteCompare(a.key, b.key));
  return lines.map((l) => l.text);
}

function main(): number {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageErr) {
      out('error: usage');
      return 2;
    }
    throw err;
  }

  let patchText: string;
  if (args.patch === null || args.patch === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(args.patch, 'utf8');
    } catch {
      out('error: no-patch');
      return 2;
    }
  }

  const lines = patchLines(patchText);
  let fmt = args.format;
  if (fmt === 'auto') {
    const detected = detectFormat(lines);
    if (!detected) {
      out('error: format');
      return 2;
    }
    fmt = detected;
  }

  let edits: Edit[];
  try {
    if (fmt === 'unified') edits = parseUnified(lines);
    else if (fmt === 'search-replace') edits = parseSearchReplace(lines);
    else if (fmt === 'v4a') edits = parseV4A(lines);
    else edits = parseJSON(lines, patchText);
  } catch (err) {
    if (err instanceof ParseErr) {
      out(`error: parse ${err.line}`);
      return 2;
    }
    throw err;
  }
  if (edits.length === 0) {
    out('error: parse 1');
    return 2;
  }

  const tree = new Tree();
  const ctx: Ctx = { strict: args.strict, moves: [] };
  const failures: Failed[] = [];
  for (const ed of edits) {
    let unsafePath: string | null = null;
    for (const p of ed.paths) {
      if (!isSafe(p)) {
        unsafePath = p;
        break;
      }
    }
    if (unsafePath !== null) {
      failures.push({ code: 'unsafe', path: unsafePath });
      continue;
    }
    const f = ed.apply(tree, ctx);
    if (f) failures.push(f);
  }

  if (failures.length > 0) {
    for (const f of failures) out(`error: ${f.code} ${f.path}`);
    out(`failed: ${failures.length} of ${edits.length} edits`);
    return 1;
  }

  const changes = changeLines(tree, ctx.moves);
  for (const l of changes) out(l);
  out(`ok: ${changes.length} file${changes.length === 1 ? '' : 's'}`);
  if (!args.check) tree.writeAll();
  return 0;
}

process.exit(main());

// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves that succeeded, as [old, new] pairs, for the `R` output lines. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** A file's text as its line break, its lines, and whether it ends with a break (section 3). */
interface Parts { br: string; lines: string[]; fin: boolean }
function parts(text: string): Parts {
  if (text === '') return { br: '\n', lines: [], fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const fin = text.endsWith(br);
  if (fin) lines.pop();
  return { br, lines, fin };
}
function joinParts(br: string, lines: string[], fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}
const leadWS = (s: string): string => /^[ \t]*/.exec(s)![0]!;
const onlyWS = (s: string): boolean => /^[ \t]*$/.test(s);
/** A line at a matching tier (section 5). */
function norm(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
/** Positions at or after `from` where O matches the file's lines at the tier. */
function occAt(O: string[], file: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + O.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (norm(O[j]!, tier) !== norm(file[i + j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}
/** The first tier at which O occurs at or after `from`, and its occurrences, or null. */
function matchAt(O: string[], file: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occAt(O, file, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}
/** One body line of a hunk or chunk: context, old, or new; `bs` when a `\` line follows it. */
interface BodyLine { k: ' ' | '-' | '+'; t: string; bs: boolean }
/** A body's old lines O, new lines N, and for each line of N the offset in O of its context line, or null. */
function onFrom(body: BodyLine[]): { O: string[]; N: string[]; ctx: (number | null)[] } {
  const O: string[] = [];
  const N: string[] = [];
  const ctx: (number | null)[] = [];
  for (const b of body) {
    if (b.k === ' ') { ctx.push(O.length); O.push(b.t); N.push(b.t); }
    else if (b.k === '-') O.push(b.t);
    else { ctx.push(null); N.push(b.t); }
  }
  return { O, N, ctx };
}
/** The lines that replace a matched block: context lines are the file's own; at tier 2 the rest are re-indented. */
function replaced(N: string[], ctx: (number | null)[], O: string[], file: string[], pos: number, tier: number): string[] {
  if (tier !== 2 || O.length === 0) return N.map((n, j) => (ctx[j] === null ? n : file[pos + ctx[j]!]!));
  const F = leadWS(file[pos]!);
  const P = leadWS(O[0]!);
  return N.map((n, j) => {
    if (ctx[j] !== null) return file[pos + ctx[j]!]!;
    if (onlyWS(n)) return n;
    return n.startsWith(P) ? F + n.slice(P.length) : n;
  });
}
/** Whether a `\` line follows the body's last context or `+` line. */
function lastBs(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    const b = body[i]!;
    if (b.k === ' ' || b.k === '+') return b.bs;
  }
  return false;
}

/** A unified hunk: its old start line (1-based) and its body. */
interface Hunk { a: number; body: BodyLine[] }
/** A unified section, with the paths each header line named. */
interface Section {
  gitOld?: string; gitNew?: string;
  pairOld?: string; pairNew?: string;
  renOld?: string; renNew?: string;
  isNew: boolean; isDel: boolean;
  hunks: Hunk[];
}
const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
/** A section's hunks applied in order to a file's text (section 6). */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const { br, lines, fin } = parts(before);
  const cur = [...lines];
  let finalBreak = fin;
  let d = 0;
  for (const h of hunks) {
    const { O, N, ctx } = onFrom(h.body);
    if (O.length > 0) {
      const m = matchAt(O, cur, 0, strict);
      if (m === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = m.occ[0]!;
      for (const pos of m.occ) if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
      const atEnd = best + O.length === cur.length;
      cur.splice(best, O.length, ...replaced(N, ctx, O, cur, best, m.tier));
      if (atEnd) finalBreak = !lastBs(h.body);
      d += N.length - O.length;
    } else {
      const ins = Math.min(h.a + d, cur.length);
      const atEnd = ins === cur.length;
      cur.splice(ins, 0, ...replaced(N, ctx, O, cur, ins, 0));
      if (atEnd) finalBreak = !lastBs(h.body);
      d += N.length;
    }
  }
  return joinParts(br, cur, finalBreak);
}
function unifiedEdits(sections: Section[], strict: boolean): Edit[] {
  return sections.map((sec) => {
    const oldRaw = sec.pairOld ?? sec.renOld ?? sec.gitOld;
    const newRaw = sec.pairNew ?? sec.renNew ?? sec.gitNew;
    const oldP = oldRaw === undefined || oldRaw === '/dev/null' ? null : oldRaw;
    const newP = newRaw === undefined || newRaw === '/dev/null' ? null : newRaw;
    if (oldP === null || sec.isNew) {
      const np = newP ?? '/dev/null';
      return (tree: Tree): void => {
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = [];
        for (const h of sec.hunks) for (const b of h.body) if (b.k === '+') plus.push(b.t);
        let bs = false;
        outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
          const body = sec.hunks[hi]!.body;
          for (let bi = body.length - 1; bi >= 0; bi--) {
            if (body[bi]!.k === '+') { bs = body[bi]!.bs; break outer; }
          }
        }
        tree.now.set(np, joinParts('\n', plus, !bs));
      };
    }
    if (newP === null || sec.isDel) {
      const op = oldP;
      return (tree: Tree): void => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
      };
    }
    if (oldP !== newP) {
      const op = oldP;
      const np = newP;
      return (tree: Tree): void => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (!safe(np)) throw new Fail('unsafe', np);
        const before = tree.get(op);
        if (before === null) throw new Fail('missing', op);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const result = applyHunks(before, sec.hunks, strict, op);
        tree.now.set(op, null);
        tree.now.set(np, result);
        tree.moves.push([op, np]);
      };
    }
    const p = oldP;
    return (tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
    };
  });
}
/** Read a patch as unified diffs (section 6) into one edit per section. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let state: 'outside' | 'header' | 'body' | 'between' = 'outside';
  let body: BodyLine[] = [];
  let hunkA = 0;
  const newSection = (): Section => {
    const s: Section = { isNew: false, isDel: false, hunks: [] };
    sections.push(s);
    cur = s;
    state = 'header';
    return s;
  };
  const flushBody = (): void => {
    if (state === 'body' && cur !== null) {
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.k === ' ' && last.t === '' && !last.bs) body.pop();
        else break;
      }
      cur.hunks.push({ a: hunkA, body });
      body = [];
    }
    state = 'between';
  };
  const headerPath = (line: string): string => stripAB(line.slice(4).split('\t')[0]!.trim());
  const gitPaths = (line: string): [string, string] | null => {
    const m = /^diff --git a\/(.*) b\/(.+)$/.exec(line);
    return m ? [m[1]!, m[2]!] : null;
  };
  const hunkHead = (line: string): number | null => {
    const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    return m ? parseInt(m[1]!, 10) : null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (state === 'body') {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        flushBody();
      } else if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '') {
        if (line.startsWith('\\')) {
          if (body.length > 0) body[body.length - 1]!.bs = true;
        } else {
          body.push({ k: line === '' ? ' ' : (line[0] as ' ' | '-' | '+'), t: line === '' ? '' : line.slice(1), bs: false });
        }
        continue;
      } else {
        flushBody();
      }
    }
    if (line.startsWith('diff --git')) {
      const gp = gitPaths(line);
      if (gp === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.gitOld = gp[0];
      s.gitNew = gp[1];
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = hunkHead(line);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      hunkA = a;
      body = [];
      state = 'body';
      continue;
    }
    if (state === 'header' && cur !== null) {
      if (line.startsWith('--- ')) {
        const next = lines[i + 1];
        if (next === undefined || !next.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        const o = headerPath(line);
        const n = headerPath(next);
        if (cur.pairOld === undefined) {
          cur.pairOld = o;
          cur.pairNew = n;
        } else {
          const s = newSection();
          s.pairOld = o;
          s.pairNew = n;
        }
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) { cur.renOld = line.slice(12).trim(); continue; }
      if (line.startsWith('rename to ')) { cur.renNew = line.slice(10).trim(); continue; }
      if (line.startsWith('new file mode')) { cur.isNew = true; continue; }
      if (line.startsWith('deleted file mode')) { cur.isDel = true; continue; }
      continue;
    }
    if (state === 'between' && cur !== null) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const s = newSection();
        s.pairOld = headerPath(line);
        s.pairNew = headerPath(lines[i + 1]!);
        i++;
        continue;
      }
      continue;
    }
    if (state === 'outside') {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const s = newSection();
        s.pairOld = headerPath(line);
        s.pairNew = headerPath(lines[i + 1]!);
        i++;
        continue;
      }
      continue;
    }
  }
  if (state === 'body') flushBody();
  return unifiedEdits(sections, strict);
}

/** Read a patch as SEARCH/REPLACE blocks (section 7) into one edit per block. */
function parseSR(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${i + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') { sep = j; break; }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${i + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { end = j; break; }
    }
    if (end < 0) throw new Exit2(`error: parse ${i + 1}`);
    const old = lines.slice(i + 1, sep);
    const nw = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (old.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinParts('\n', nw, true));
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const { br, lines: file, fin } = parts(before);
      const m = matchAt(old, file, 0, strict);
      if (m === null) throw new Fail('no-match', p);
      if (m.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = m.occ[0]!;
      const cur = [...file];
      cur.splice(pos, old.length, ...replaced(nw, nw.map(() => null), old, file, pos, m.tier));
      tree.now.set(p, joinParts(br, cur, fin));
    });
    prevPath = path;
    prevEnd = end + 1;
    i = end;
  }
  return edits;
}
/** One V4A chunk: its anchor (null: none), whether it is anchored to the end of the file, and its body. */
interface VChunk { anchor: string | null; eof: boolean; body: BodyLine[] }
/** One V4A section. */
interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: VChunk[];
  updLine: number;
}
function vEdit(s: VSection, strict: boolean): Edit {
  if (s.kind === 'add') {
    return (tree: Tree): void => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, joinParts('\n', s.lines, true));
    };
  }
  if (s.kind === 'del') {
    return (tree: Tree): void => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
    };
  }
  return (tree: Tree): void => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null) {
      if (!safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
      if (tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    }
    const { br, lines, fin } = parts(before);
    const cur = [...lines];
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        let found = -1;
        for (const t of strict ? [0] : [0, 1, 2]) {
          for (let i = cursor; i < cur.length; i++) {
            if (norm(ch.anchor, t) === norm(cur[i]!, t)) { found = i; break; }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', s.path);
        cursor = found + 1;
      }
      const { O, N, ctx } = onFrom(ch.body);
      if (O.length === 0) {
        const pos = ch.eof ? cur.length : cursor;
        const rep = replaced(N, ctx, O, cur, pos, 0);
        cur.splice(pos, 0, ...rep);
        cursor = pos + rep.length;
      } else {
        let hit: { tier: number; pos: number } | null = null;
        for (const t of strict ? [0] : [0, 1, 2]) {
          const occ = occAt(O, cur, t, cursor);
          const use = ch.eof ? occ.filter((p) => p + O.length === cur.length) : occ;
          if (use.length > 0) { hit = { tier: t, pos: use[0]! }; break; }
        }
        if (hit === null) throw new Fail('no-match', s.path);
        const rep = replaced(N, ctx, O, cur, hit.pos, hit.tier);
        cur.splice(hit.pos, O.length, ...rep);
        cursor = hit.pos + rep.length;
      }
    }
    const result = joinParts(br, cur, fin);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, result);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, result);
    }
  };
}
/** Read a patch as a V4A patch (section 8) into one edit per section. */
function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) { last = i; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let chunk: VChunk | null = null;
  let chunkClosed = false;
  const endSection = (): void => {
    if (cur === null) return;
    if (cur.kind === 'add') {
      while (cur.lines.length > 0 && cur.lines[cur.lines.length - 1] === '') cur.lines.pop();
    } else if (cur.kind === 'upd' && chunk !== null && !chunkClosed) {
      while (chunk.body.length > 0) {
        const l = chunk.body[chunk.body.length - 1]!;
        if (l.k === ' ' && l.t === '' && !l.bs) chunk.body.pop();
        else break;
      }
    }
    if (cur.kind === 'upd' && cur.chunks.length === 0 && cur.moveTo === null) throw new Exit2(`error: parse ${cur.updLine}`);
    cur = null;
    chunk = null;
    chunkClosed = false;
  };
  for (let i = first + 1; i < last; i++) {
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      endSection();
      const kind = line.startsWith('*** Add') ? 'add' : line.startsWith('*** Delete') ? 'del' : 'upd';
      const pfx = kind === 'add' ? '*** Add File: ' : kind === 'del' ? '*** Delete File: ' : '*** Update File: ';
      cur = { kind, path: line.slice(pfx.length).trim(), moveTo: null, lines: [], chunks: [], updLine: i + 1 };
      sections.push(cur);
      chunk = null;
      chunkClosed = false;
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'add') {
      if (line.startsWith('+')) { cur.lines.push(line.slice(1)); continue; }
      if (line === '') { cur.lines.push(''); continue; }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'del') {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (line.startsWith('*** Move to: ') && cur.chunks.length === 0 && chunk === null && cur.moveTo === null) {
      cur.moveTo = line.slice('*** Move to: '.length).trim();
      continue;
    }
    if (line === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${i + 1}`);
      chunk.eof = true;
      chunkClosed = true;
      chunk = null;
      continue;
    }
    if (line.startsWith('@@')) {
      chunk = { anchor: line.slice(2).trim(), eof: false, body: [] };
      cur.chunks.push(chunk);
      chunkClosed = false;
      continue;
    }
    if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line === '') {
      if (chunk === null) {
        if (chunkClosed) {
          if (line === '') continue;
          throw new Exit2(`error: parse ${i + 1}`);
        }
        chunk = { anchor: null, eof: false, body: [] };
        cur.chunks.push(chunk);
      }
      chunk.body.push({ k: line === '' ? ' ' : (line[0] as ' ' | '-' | '+'), t: line === '' ? '' : line.slice(1), bs: false });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  endSection();
  return sections.map((s) => vEdit(s, strict));
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSR(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const covered = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      covered.add(o);
      covered.add(n);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

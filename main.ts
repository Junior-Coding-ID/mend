// mend: applies an edit an AI model wrote to a tree of text files.
// Written fresh from SPEC.md (version 1). Node 22+, standard library only.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runTrial } from './runner.ts';

interface FileState { lines: string[]; ends: boolean; br: '\r\n' | '\n'; }

function parseFileText(text: string): FileState {
  let br: '\r\n' | '\n' = '\n';
  const firstNl = text.indexOf('\n');
  if (firstNl > 0 && text[firstNl - 1] === '\r') br = '\r\n';
  let lines = text.split(br);
  let ends = false;
  if (text.length > 0 && text.endsWith(br)) { lines.pop(); ends = true; }
  if (text.length === 0) { lines = []; ends = false; }
  return { lines, ends, br };
}

// SPEC section 3: a file of no lines is written empty.
function joinLines(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}

function isSafe(p: string): boolean {
  if (p.length === 0) return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const s of p.split('/')) if (s === '' || s === '.' || s === '..') return false;
  return true;
}

// ---- matching (SPEC section 5) ----

function tierLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function findOccurrences(fileLines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (tierLine(fileLines[i + j], tier) !== tierLine(o[j], tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(fileLines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = findOccurrences(fileLines, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

// A line of N: text from the patch, or a context line taken from the file.
interface NewLine { text: string; ctx: number | null; }

function resolveNew(nl: NewLine[], fileLines: string[], pos: number, o: string[], tier: number): string[] {
  const f = fileLines.length > pos ? leadingWs(fileLines[pos]) : '';
  const p = o.length > 0 ? leadingWs(o[0]) : '';
  return nl.map((e) => {
    if (e.ctx !== null) return fileLines[pos + e.ctx];
    if (tier === 2) {
      const t = e.text;
      if (t === '' || /^[ \t]+$/.test(t)) return t;
      if (t.startsWith(p)) return f + t.slice(p.length);
      return t;
    }
    return e.text;
  });
}

// ---- the tree ----

class Tree {
  files = new Map<string, FileState>();
  initial = new Map<string, string>();
  moves: { old: string; nw: string }[] = [];

  load(dir: string): void {
    const walk = (d: string, prefix: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = prefix === '' ? e.name : prefix + '/' + e.name;
        const full = join(d, e.name);
        if (e.isDirectory()) walk(full, p);
        else if (e.isFile()) {
          const text = readFileSync(full, 'utf8');
          this.files.set(p, parseFileText(text));
          this.initial.set(p, text);
        }
      }
    };
    walk(dir, '');
  }

  // Deletions first, then writes (SPEC section 10 fix: a delete must land
  // before a create at the same path, or the write can fail EISDIR).
  writeAll(dir: string): void {
    for (const p of this.initial.keys()) {
      if (!this.files.has(p)) {
        try { rmSync(join(dir, ...p.split('/')), { force: true }); } catch { /* already gone */ }
      }
    }
    const toWrite: string[] = [];
    for (const [p, f] of this.files) {
      if (this.initial.get(p) !== joinLines(f)) toWrite.push(p);
    }
    toWrite.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
    for (const p of toWrite) {
      const full = join(dir, ...p.split('/'));
      try {
        if (statSync(full).isDirectory()) rmSync(full, { recursive: true, force: true });
      } catch { /* not there */ }
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, joinLines(this.files.get(p)!));
    }
  }
}

function computeChanges(tree: Tree): string[] {
  interface Out { key: string; line: string; }
  const outs: Out[] = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  const rSources = new Set<string>();
  const rTargets = new Set<string>();
  for (const m of tree.moves) {
    if (tree.initial.has(m.old) && !tree.files.has(m.old) && !tree.initial.has(m.nw) && tree.files.has(m.nw)
      && !usedOld.has(m.old) && !usedNew.has(m.nw)) {
      usedOld.add(m.old); usedNew.add(m.nw);
      rSources.add(m.old); rTargets.add(m.nw);
      outs.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
    }
  }
  for (const p of tree.initial.keys()) {
    if (!tree.files.has(p) && !rSources.has(p)) outs.push({ key: p, line: `D ${p}` });
  }
  for (const p of tree.files.keys()) {
    if (!tree.initial.has(p) && !rTargets.has(p)) outs.push({ key: p, line: `A ${p}` });
  }
  for (const [p, f] of tree.files) {
    if (tree.initial.has(p) && tree.initial.get(p) !== joinLines(f)) outs.push({ key: p, line: `M ${p}` });
  }
  outs.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  return outs.map((o) => o.line);
}

type Fail = { code: string; path: string } | null;
type EditFn = (tree: Tree) => Fail;
interface ParseResult { edits: EditFn[]; parseError?: number; }

function splitPatch(text: string): string[] {
  const ls = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (text.endsWith('\n')) ls.pop();
  return ls;
}

// ---- unified diffs (SPEC section 6) ----

interface Hunk { a: number; body: string[]; }

interface Section {
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFileMode: boolean;
  deletedFileMode: boolean;
  gitOld: string | undefined;
  gitNew: string | undefined;
  hunks: Hunk[];
}

function dashPath(raw: string): string | null {
  let t = raw.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseDiffGit(line: string): { x: string; y: string } | null {
  if (!line.startsWith('diff --git a/')) return null;
  const rest = line.slice('diff --git a/'.length);
  const idx = rest.lastIndexOf(' b/');
  if (idx < 0) return null;
  return { x: rest.slice(0, idx), y: rest.slice(idx + 3) };
}

function unifiedEdit(sec: Section, strict: boolean): EditFn | null {
  const oldP = sec.oldPath !== undefined ? sec.oldPath : (sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld);
  const newP = sec.newPath !== undefined ? sec.newPath : (sec.renameTo !== undefined ? sec.renameTo : sec.gitNew);
  if (oldP === null && newP === null) return null;
  const o = oldP ?? '';
  const n = newP ?? '';
  const isCreation = oldP === null || sec.newFileMode;
  const isDeletion = !isCreation && (newP === null || sec.deletedFileMode);

  if (isCreation) {
    return (tree: Tree): Fail => {
      if (!isSafe(n)) return { code: 'unsafe', path: n };
      if (tree.files.has(n)) return { code: 'exists', path: n };
      const lines: string[] = [];
      let ends = true;
      for (const h of sec.hunks) {
        for (let bi = 0; bi < h.body.length; bi++) {
          const bl = h.body[bi];
          if (bl.startsWith('+')) {
            lines.push(bl.slice(1));
            ends = !(bi + 1 < h.body.length && h.body[bi + 1].startsWith('\\'));
          }
        }
      }
      tree.files.set(n, { lines, ends, br: '\n' });
      return null;
    };
  }

  if (isDeletion) {
    return (tree: Tree): Fail => {
      if (!isSafe(o)) return { code: 'unsafe', path: o };
      if (!tree.files.has(o)) return { code: 'missing', path: o };
      tree.files.delete(o);
      return null;
    };
  }

  return (tree: Tree): Fail => {
    const paths = o === n ? [o] : [o, n];
    for (const p of paths) if (!isSafe(p)) return { code: 'unsafe', path: p };
    const f = tree.files.get(o);
    if (!f) return { code: 'missing', path: o };
    if (o !== n && tree.files.has(n)) return { code: 'exists', path: n };
    let lines = [...f.lines];
    let ends = f.ends;
    let d = 0;
    for (const h of sec.hunks) {
      const ol: string[] = [];
      const nl: NewLine[] = [];
      let lastCtxOrPlus = -1;
      h.body.forEach((bl, bi) => {
        if (bl.startsWith(' ')) { ol.push(bl.slice(1)); nl.push({ text: bl.slice(1), ctx: ol.length - 1 }); lastCtxOrPlus = bi; }
        else if (bl.startsWith('-')) { ol.push(bl.slice(1)); }
        else if (bl.startsWith('+')) { nl.push({ text: bl.slice(1), ctx: null }); lastCtxOrPlus = bi; }
        else if (bl === '') { ol.push(''); nl.push({ text: '', ctx: ol.length - 1 }); lastCtxOrPlus = bi; }
      });
      const noBreak = lastCtxOrPlus >= 0 && lastCtxOrPlus + 1 < h.body.length && h.body[lastCtxOrPlus + 1].startsWith('\\');
      if (ol.length > 0) {
        const found = findTier(lines, ol, strict);
        if (!found) return { code: 'no-match', path: o };
        const target = h.a - 1 + d;
        let best = found.pos[0];
        for (const p of found.pos) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
        const resolved = resolveNew(nl, lines, best, ol, found.tier);
        const runsToEnd = best + ol.length === lines.length;
        lines.splice(best, ol.length, ...resolved);
        if (runsToEnd) ends = !noBreak;
        d += nl.length - ol.length;
      } else {
        const at = Math.min(h.a + d, lines.length);
        const resolved = resolveNew(nl, lines, at, ol, 0);
        lines.splice(at, 0, ...resolved);
        if (at === lines.length) ends = !noBreak;
        d += nl.length;
      }
    }
    const state: FileState = { lines, ends, br: f.br };
    if (o === n) tree.files.set(o, state);
    else {
      tree.files.set(n, state);
      tree.files.delete(o);
      tree.moves.push({ old: o, nw: n });
    }
    return null;
  };
}

function parseUnified(lines: string[], strict: boolean): ParseResult {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const dg = parseDiffGit(line);
      if (!dg) return { edits: [], parseError: i + 1 };
      cur = { oldPath: undefined, newPath: undefined, renameFrom: undefined, renameTo: undefined, newFileMode: false, deletedFileMode: false, gitOld: dg.x, gitNew: dg.y, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const nextIsPlus = i + 1 < lines.length && lines[i + 1].startsWith('+++ ');
      if (nextIsPlus) {
        if (cur !== null && inHeader) {
          cur.oldPath = dashPath(line);
          cur.newPath = dashPath(lines[i + 1]);
        } else {
          cur = { oldPath: dashPath(line), newPath: dashPath(lines[i + 1]), renameFrom: undefined, renameTo: undefined, newFileMode: false, deletedFileMode: false, gitOld: undefined, gitNew: undefined, hunks: [] };
          sections.push(cur);
          inHeader = true;
        }
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) return { edits: [], parseError: i + 2 };
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) return { edits: [], parseError: i + 1 };
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) return { edits: [], parseError: i + 1 };
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j];
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) { body.push(bl); j++; continue; }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a: parseInt(m[1], 10), body });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line === 'new file mode' || line.startsWith('new file mode ')) cur.newFileMode = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) cur.deletedFileMode = true;
    }
    i++;
  }
  const edits: EditFn[] = [];
  for (const sec of sections) {
    const e = unifiedEdit(sec, strict);
    if (e) edits.push(e);
  }
  if (edits.length === 0) return { edits: [], parseError: 1 };
  return { edits };
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

// Marker lines are matched with trailing whitespace removed (SPEC: "trailing
// whitespace", so /\s+$/ here, unlike the [ \t] matching tiers of section 5).
function marker(line: string): string {
  return line.replace(/\s+$/, '');
}

function parseSearchReplace(lines: string[], strict: boolean): ParseResult {
  interface Block { path: string; oldLines: string[]; newLines: string[]; }
  const blocks: Block[] = [];
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (marker(lines[i]) !== '<<<<<<< SEARCH') { i++; continue; }
    const s = i;
    // path: nearest line before SEARCH, after the previous block's end, that
    // is not blank and does not start with three backticks.
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) return { edits: [], parseError: s + 1 };
    // find ======= then >>>>>>> REPLACE
    let sep = -1;
    let end = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (marker(lines[j]) === '=======') { sep = j; break; }
    }
    if (sep >= 0) {
      for (let j = sep + 1; j < lines.length; j++) {
        if (marker(lines[j]) === '>>>>>>> REPLACE') { end = j; break; }
      }
    }
    if (sep < 0 || end < 0) return { edits: [], parseError: s + 1 };
    blocks.push({ path, oldLines: lines.slice(s + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  if (blocks.length === 0) return { edits: [], parseError: 1 };
  const edits: EditFn[] = blocks.map((b) => (tree: Tree): Fail => {
    if (!isSafe(b.path)) return { code: 'unsafe', path: b.path };
    if (b.oldLines.length === 0) {
      if (tree.files.has(b.path)) return { code: 'exists', path: b.path };
      tree.files.set(b.path, { lines: [...b.newLines], ends: true, br: '\n' });
      return null;
    }
    const f = tree.files.get(b.path);
    if (!f) return { code: 'missing', path: b.path };
    const found = findTier(f.lines, b.oldLines, strict);
    if (!found) return { code: 'no-match', path: b.path };
    if (found.pos.length > 1) return { code: 'ambiguous', path: b.path };
    const pos = found.pos[0];
    const nl: NewLine[] = b.newLines.map((t) => ({ text: t, ctx: null }));
    const resolved = resolveNew(nl, f.lines, pos, b.oldLines, found.tier);
    const lines = [...f.lines];
    lines.splice(pos, b.oldLines.length, ...resolved);
    tree.files.set(b.path, { lines, ends: f.ends, br: f.br });
    return null;
  });
  return { edits };
}

// ---- V4A patches (SPEC section 8) ----

interface VChunk { anchor: string | null; eof: boolean; body: { text: string; no: number }[]; }

function parseV4A(lines: string[], strict: boolean): ParseResult {
  let first = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].trim() !== '') { first = i; break; }
  if (first < 0) return { edits: [], parseError: 1 };
  if (lines[first].trim() !== '*** Begin Patch') return { edits: [], parseError: first + 1 };
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim() !== '') { last = i; break; }
  if (lines[last].trim() !== '*** End Patch') return { edits: [], parseError: lines.length + 1 };

  interface VSection { kind: 'add' | 'delete' | 'update'; path: string; lineNo: number; raw: { text: string; no: number }[]; }
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) { kind = 'add'; path = line.slice('*** Add File: '.length).trim(); }
    else if (line.startsWith('*** Delete File: ')) { kind = 'delete'; path = line.slice('*** Delete File: '.length).trim(); }
    else if (line.startsWith('*** Update File: ')) { kind = 'update'; path = line.slice('*** Update File: '.length).trim(); }
    else return { edits: [], parseError: i + 1 };
    const sec: VSection = { kind, path, lineNo: i + 1, raw: [] };
    sections.push(sec);
    i++;
    while (i < last) {
      const l = lines[i];
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      sec.raw.push({ text: l, no: i + 1 });
      i++;
    }
  }
  if (sections.length === 0) return { edits: [], parseError: 1 };

  const edits: EditFn[] = [];
  for (const sec of sections) {
    const raw = sec.raw;
    while (raw.length > 0 && raw[raw.length - 1].text.trim() === '') raw.pop();

    if (sec.kind === 'add') {
      // A '+' line is an explicit line (even when its rest is empty); a bare
      // empty line is a file line too. Only non-explicit trailing empties go.
      const fileLines: { text: string; explicit: boolean }[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push({ text: r.text.slice(1), explicit: true });
        else if (r.text === '') fileLines.push({ text: '', explicit: false });
        else return { edits: [], parseError: r.no };
      }
      while (fileLines.length > 0) {
        const l = fileLines[fileLines.length - 1];
        if (!l.explicit && l.text === '') fileLines.pop(); else break;
      }
      const path = sec.path;
      const ls = fileLines.map((e) => e.text);
      edits.push((tree: Tree): Fail => {
        if (!isSafe(path)) return { code: 'unsafe', path };
        if (tree.files.has(path)) return { code: 'exists', path };
        tree.files.set(path, { lines: [...ls], ends: true, br: '\n' });
        return null;
      });
      continue;
    }

    if (sec.kind === 'delete') {
      if (raw.length > 0) return { edits: [], parseError: raw[0].no };
      const path = sec.path;
      edits.push((tree: Tree): Fail => {
        if (!isSafe(path)) return { code: 'unsafe', path };
        if (!tree.files.has(path)) return { code: 'missing', path };
        tree.files.delete(path);
        return null;
      });
      continue;
    }

    // update
    let moveTo: string | undefined;
    let startIdx = 0;
    if (raw.length > 0 && raw[0].text.startsWith('*** Move to: ')) {
      moveTo = raw[0].text.slice('*** Move to: '.length).trim();
      startIdx = 1;
    }
    const chunks: VChunk[] = [];
    let open: VChunk | null = null;
    for (let k = startIdx; k < raw.length; k++) {
      const r = raw[k];
      const l = r.text;
      if (l.startsWith('@@')) {
        const a = l.slice(2).trim();
        open = { anchor: a === '' ? null : a, eof: false, body: [] };
        chunks.push(open);
        continue;
      }
      if (l.trim() === '*** End of File') {
        if (open === null) return { edits: [], parseError: r.no };
        open.eof = true;
        open = null;
        continue;
      }
      if (l.startsWith('*** ')) return { edits: [], parseError: r.no };
      // Body lines first, blank lines after (SPEC section 8 fix): a line
      // starting with ' ', '-' or '+' is a body line even when it is only
      // whitespace; a bare empty line is an empty context line.
      if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
        if (open === null) {
          if (chunks.length > 0) return { edits: [], parseError: r.no };
          open = { anchor: null, eof: false, body: [] };
          chunks.push(open);
        }
        open.body.push(r);
        continue;
      }
      return { edits: [], parseError: r.no };
    }
    if (chunks.length === 0 && moveTo === undefined) return { edits: [], parseError: sec.lineNo };
    const path = sec.path;
    const mv = moveTo;
    const chs = chunks;
    edits.push((tree: Tree): Fail => {
      const paths = mv !== undefined ? [path, mv] : [path];
      for (const p of paths) if (!isSafe(p)) return { code: 'unsafe', path: p };
      const f = tree.files.get(path);
      if (!f) return { code: 'missing', path };
      if (mv !== undefined && tree.files.has(mv)) return { code: 'exists', path: mv };
      let lines = [...f.lines];
      let cursor = 0;
      for (const ch of chs) {
        if (ch.anchor !== null) {
          let foundAt = -1;
          for (let t = 0; t <= (strict ? 0 : 2); t++) {
            for (let idx = cursor; idx < lines.length; idx++) {
              if (tierLine(lines[idx], t) === tierLine(ch.anchor, t)) { foundAt = idx; break; }
            }
            if (foundAt >= 0) break;
          }
          if (foundAt < 0) return { code: 'no-match', path };
          cursor = foundAt + 1;
        }
        const ol: string[] = [];
        const nl: NewLine[] = [];
        for (const bl of ch.body) {
          const l = bl.text;
          if (l.startsWith(' ')) { ol.push(l.slice(1)); nl.push({ text: l.slice(1), ctx: ol.length - 1 }); }
          else if (l.startsWith('-')) { ol.push(l.slice(1)); }
          else if (l.startsWith('+')) { nl.push({ text: l.slice(1), ctx: null }); }
          else if (l === '') { ol.push(''); nl.push({ text: '', ctx: ol.length - 1 }); }
        }
        if (ol.length > 0) {
          let found: { tier: number; pos: number } | null = null;
          for (let t = 0; t <= (strict ? 0 : 2); t++) {
            const occ = findOccurrences(lines, ol, t).filter((p) => p >= cursor);
            if (ch.eof) {
              const e = occ.filter((p) => p + ol.length === lines.length);
              if (e.length > 0) { found = { tier: t, pos: e[0] }; break; }
            } else if (occ.length > 0) { found = { tier: t, pos: occ[0] }; break; }
          }
          if (!found) return { code: 'no-match', path };
          const resolved = resolveNew(nl, lines, found.pos, ol, found.tier);
          lines.splice(found.pos, ol.length, ...resolved);
          cursor = found.pos + resolved.length;
        } else {
          const at = ch.eof ? lines.length : cursor;
          const resolved = resolveNew(nl, lines, at, ol, 0);
          lines.splice(at, 0, ...resolved);
          cursor = at + resolved.length;
        }
      }
      const state: FileState = { lines, ends: f.ends, br: f.br };
      if (mv !== undefined) {
        tree.files.set(mv, state);
        tree.files.delete(path);
        tree.moves.push({ old: path, nw: mv });
      } else {
        tree.files.set(path, state);
      }
      return null;
    });
  }
  return { edits };
}

// ---- JSON edits (SPEC section 9) ----

function validEditObject(v: unknown): { path: string; command: string; [k: string]: unknown } | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
  } else if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
  } else if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
  } else return null;
  return o as { path: string; command: string; [k: string]: unknown };
}

function jsonEdit(e: { path: string; command: string; [k: string]: unknown }): EditFn {
  const path = e.path;
  if (e.command === 'create') {
    const text = e.file_text as string;
    return (tree: Tree): Fail => {
      if (!isSafe(path)) return { code: 'unsafe', path };
      if (tree.files.has(path)) return { code: 'exists', path };
      tree.files.set(path, parseFileText(text));
      return null;
    };
  }
  if (e.command === 'str_replace') {
    const oldS = e.old_str as string;
    const newS = (e.new_str === undefined ? '' : e.new_str) as string;
    return (tree: Tree): Fail => {
      if (!isSafe(path)) return { code: 'unsafe', path };
      const f = tree.files.get(path);
      if (!f) return { code: 'missing', path };
      const raw = joinLines(f);
      let text = raw;
      let oldT = oldS;
      let newT = newS;
      if (f.br === '\r\n') {
        text = raw.replace(/\r\n/g, '\n');
        oldT = oldS.replace(/\r\n/g, '\n');
        newT = newS.replace(/\r\n/g, '\n');
      }
      let count = 0;
      let idx = 0;
      while (true) {
        const p = text.indexOf(oldT, idx);
        if (p < 0) break;
        count++;
        idx = p + 1;
        if (count > 1) break;
      }
      if (count === 0) return { code: 'no-match', path };
      if (count > 1) return { code: 'ambiguous', path };
      const p = text.indexOf(oldT);
      let result = text.slice(0, p) + newT + text.slice(p + oldT.length);
      if (f.br === '\r\n') result = result.replace(/\n/g, '\r\n');
      tree.files.set(path, parseFileText(result));
      return null;
    };
  }
  const line = e.insert_line as number;
  const newS = e.new_str as string;
  return (tree: Tree): Fail => {
    if (!isSafe(path)) return { code: 'unsafe', path };
    const f = tree.files.get(path);
    if (!f) return { code: 'missing', path };
    if (line < 0 || line > f.lines.length) return { code: 'no-match', path };
    const ins = newS === '' ? [] : splitPatch(newS);
    const lines = [...f.lines];
    lines.splice(line, 0, ...ins);
    tree.files.set(path, { lines, ends: f.ends, br: f.br });
    return null;
  };
}

function parseJSON(lines: string[]): ParseResult {
  let first = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].trim() !== '') { first = i; break; }
  if (first < 0) return { edits: [], parseError: 1 };
  const firstChar = lines[first].trimStart()[0];
  const edits: EditFn[] = [];
  if (firstChar === '[') {
    let arr: unknown;
    try { arr = JSON.parse(lines.join('\n')); } catch { return { edits: [], parseError: first + 1 }; }
    if (!Array.isArray(arr)) return { edits: [], parseError: first + 1 };
    for (const el of arr) {
      const e = validEditObject(el);
      if (!e) return { edits: [], parseError: first + 1 };
      edits.push(jsonEdit(e));
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '') continue;
      let v: unknown;
      try { v = JSON.parse(lines[i]); } catch { return { edits: [], parseError: i + 1 }; }
      const e = validEditObject(v);
      if (!e) return { edits: [], parseError: i + 1 };
      edits.push(jsonEdit(e));
    }
  }
  if (edits.length === 0) return { edits: [], parseError: 1 };
  return { edits };
}

// ---- format detection (SPEC section 4) ----

function detectFormat(lines: string[]): string | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].trim() !== '') { first = i; break; }
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const fc = lines[first].trimStart()[0];
  if (fc === '[' || fc === '{') return 'json';
  for (const l of lines) if (marker(l) === '<<<<<<< SEARCH') return 'search-replace';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---- invocation (SPEC section 1) and main (SPEC section 2) ----

interface Args { format: string | null; check: boolean; strict: boolean; patch: string | null; }

function parseArgs(argv: string[]): Args | null {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let patch: string | null = null;
  const seen = new Set<string>();
  let endOpts = false;
  for (const a of argv) {
    if (!endOpts && a === '--') { endOpts = true; continue; }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seen.has('check')) return null;
        seen.add('check'); check = true;
      } else if (a === '--strict') {
        if (seen.has('strict')) return null;
        seen.add('strict'); strict = true;
      } else if (a.startsWith('--format=')) {
        if (seen.has('format')) return null;
        seen.add('format');
        const v = a.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') return null;
        format = v;
      } else return null;
    } else {
      if (patch !== null) return null;
      patch = a;
    }
  }
  return { format, check, strict, patch };
}

function out(line: string): void {
  process.stdout.write(line + '\n');
}

async function main(): Promise<number> {
  // The kit's runner: when the trial env hands us its URL, drive the trial
  // instead of the CLI (runner.ts's header comment).
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl) {
    await runTrial(envUrl);
    return 0;
  }
  const args = parseArgs(process.argv.slice(2));
  if (args === null) { out('error: usage'); return 2; }
  let patchText: string;
  try {
    patchText = args.patch === null || args.patch === '-' ? readFileSync(0, 'utf8') : readFileSync(args.patch, 'utf8');
  } catch {
    out('error: no-patch');
    return 2;
  }
  const lines = splitPatch(patchText);
  let format = args.format;
  if (format === null || format === 'auto') {
    const d = detectFormat(lines);
    if (d === null) { out('error: format'); return 2; }
    format = d;
  }
  let parsed: ParseResult;
  if (format === 'unified') parsed = parseUnified(lines, args.strict);
  else if (format === 'search-replace') parsed = parseSearchReplace(lines, args.strict);
  else if (format === 'v4a') parsed = parseV4A(lines, args.strict);
  else parsed = parseJSON(lines);
  if (parsed.parseError !== undefined) { out(`error: parse ${parsed.parseError}`); return 2; }
  const tree = new Tree();
  tree.load('.');
  const failures: { code: string; path: string }[] = [];
  for (const edit of parsed.edits) {
    const f = edit(tree);
    if (f) failures.push(f);
  }
  if (failures.length > 0) {
    for (const f of failures) out(`error: ${f.code} ${f.path}`);
    out(`failed: ${failures.length} of ${parsed.edits.length} edits`);
    return 1;
  }
  const changes = computeChanges(tree);
  if (!args.check) tree.writeAll('.');
  for (const l of changes) out(l);
  const n = changes.length;
  out(n === 1 ? 'ok: 1 file' : `ok: ${n} files`);
  return 0;
}

process.exit(await main());

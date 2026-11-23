// mend: one patch tool for every AI edit format (the kit's SPEC.md, version 1, is the whole
// specification). It reads an edit in one of four formats (a unified diff, SEARCH/REPLACE blocks,
// a V4A patch, text-editor tool calls as JSON) and applies it to the tree of text files in the
// working directory: every file is changed or nothing is. Node 22, the standard library alone;
// run as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file
// hands over to runner.ts (the last lines below): that hand-over stays as it is.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: the single line to print. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC.md section 3): split at \n, one trailing \r removed, no empty last piece. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path (section 3): relative, no backslash, no empty, dot or dot-dot segment. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its own line break, and whether it ends with one (section 3). */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function writeFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.final ? st.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
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
  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
  finalOf(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* Section 5: matching lines at three tiers. */

const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function tierLine(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? trailWs(s) : stripWs(s);
}

interface Found {
  tier: number;
  at: number[];
}

/** Every occurrence of `old` in `lines` at or after `from`, at the first tier that has one. */
function findOccurrences(lines: string[], old: string[], strict: boolean, from = 0): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const want = old.map((s) => tierLine(s, tier));
    const at: number[] = [];
    for (let i = from; i + old.length <= lines.length; i += 1) {
      let ok = true;
      for (let j = 0; j < old.length; j += 1) {
        if (tierLine(lines[i + j]!, tier) !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One line of N: `oi` >= 0 is a context line, the file's own matched line old[oi]; -1 is a new line. */
interface NLine {
  text: string;
  oi: number;
}

/** The lines that replace the matched run: context from the file, tier-2 lines re-indented (section 5). */
function buildNew(lines: string[], at: number, old: string[], neu: NLine[], tier: number): string[] {
  const f = old.length > 0 ? leadWs(lines[at]!) : '';
  const p = old.length > 0 ? leadWs(old[0]!) : '';
  return neu.map((n) => {
    if (n.oi >= 0) return lines[at + n.oi]!;
    if (tier === 2 && n.text.trim() !== '' && n.text.startsWith(p)) return f + n.text.slice(p.length);
    return n.text;
  });
}

/* Section 9: JSON edits. */

/** One JSON edit object, or null when it is not one (a parse fault where it stands). */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const existing = (tree: Tree): string => {
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
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
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
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const st = parseFile(existing(tree));
      if (line < 0 || line > st.lines.length) throw new Fail('no-match', p);
      st.lines.splice(line, 0, ...add);
      tree.set(p, writeFile(st));
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

/* Section 6: unified diffs. */

interface BodyLine {
  kind: string; // ' ', '-', '+' or '\'
  text: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  headOld: string | null;
  headNew: string | null;
  renOld: string | null;
  renNew: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function newSection(): Section {
  return { diffOld: null, diffNew: null, headOld: null, headNew: null, renOld: null, renNew: null, newFile: false, delFile: false, hunks: [] };
}

/** A `--- `/`+++ ` path: after the four characters, up to the first tab, spaces removed, a/ or b/ removed. */
function headPath(line: string): string {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && cur.headOld === null) {
        cur.headOld = headPath(line);
        cur.headNew = headPath(lines[i + 1]!);
      } else {
        cur = newSection();
        cur.headOld = headPath(line);
        cur.headNew = headPath(lines[i + 1]!);
        sections.push(cur);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (cur !== null && inHeader && !line.startsWith('@@')) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        cur.headNew = headPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renOld = line.slice('rename from '.length).split('\t')[0]!.trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renNew = line.slice('rename to '.length).split('\t')[0]!.trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.delFile = true;
        i += 1;
        continue;
      }
      i += 1; // any other header line is ignored
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          hunk.body.push({ kind: ' ', text: '' });
          i += 1;
          continue;
        }
        const c = b[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          hunk.body.push({ kind: c, text: b.slice(1) });
          i += 1;
          continue;
        }
        break;
      }
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === ' ' && last.text === '') hunk.body.pop();
        else break;
      }
      cur.hunks.push(hunk);
      continue;
    }
    i += 1; // outside bodies and headers, lines are ignored
  }
  return sections;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function backslashAfter(h: Hunk): boolean {
  for (let bi = h.body.length - 1; bi >= 0; bi -= 1) {
    const k = h.body[bi]!.kind;
    if (k === ' ' || k === '+') return h.body[bi + 1]?.kind === '\\';
  }
  return false;
}

/** Apply one hunk to the file state; returns N's length minus O's length. Throws Fail. */
function applyHunk(st: FileState, h: Hunk, d: number, strict: boolean, path: string): number {
  const old: string[] = [];
  const neu: NLine[] = [];
  for (const b of h.body) {
    if (b.kind === ' ') {
      old.push(b.text);
      neu.push({ text: b.text, oi: old.length - 1 });
    } else if (b.kind === '-') old.push(b.text);
    else if (b.kind === '+') neu.push({ text: b.text, oi: -1 });
  }
  const bs = backslashAfter(h);
  if (old.length === 0) {
    const pos = Math.min(h.a + d, st.lines.length);
    const atEnd = pos === st.lines.length;
    const add = neu.map((n) => n.text);
    st.lines.splice(pos, 0, ...add);
    if (atEnd && add.length > 0) st.final = !bs;
    return add.length;
  }
  const found = findOccurrences(st.lines, old, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let at = found.at[0]!;
  for (const p of found.at) {
    if (Math.abs(p - target) < Math.abs(at - target)) at = p;
  }
  const touchesEnd = at + old.length === st.lines.length;
  const add = buildNew(st.lines, at, old, neu, found.tier);
  st.lines.splice(at, old.length, ...add);
  if (touchesEnd) st.final = !bs;
  return neu.length - old.length;
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.headOld ?? sec.renOld ?? sec.diffOld;
  const newP = sec.headNew ?? sec.renNew ?? sec.diffNew;
  const isCreate = sec.newFile || oldP === '/dev/null';
  const isDelete = !isCreate && (sec.delFile || newP === '/dev/null');
  return (tree) => {
    if (isCreate) {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const lines: string[] = [];
      let final = true;
      for (const h of sec.hunks) {
        for (const b of h.body) if (b.kind === '+') lines.push(b.text);
      }
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
        const body = sec.hunks[hi]!.body;
        for (let bi = body.length - 1; bi >= 0; bi -= 1) {
          if (body[bi]!.kind === '+') {
            final = body[bi + 1]?.kind !== '\\';
            break outer;
          }
        }
      }
      tree.set(p, lines.length === 0 ? '' : lines.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.set(p, null);
      return;
    }
    const o = oldP!;
    const n = newP!;
    const isMove = o !== n;
    if (!safe(o)) throw new Fail('unsafe', o);
    if (isMove && !safe(n)) throw new Fail('unsafe', n);
    const before = tree.get(o);
    if (before === null) throw new Fail('missing', o);
    if (isMove && tree.get(n) !== null) throw new Fail('exists', n);
    const st = parseFile(before);
    let d = 0;
    for (const h of sec.hunks) d += applyHunk(st, h, d, strict, o);
    const text = writeFile(st);
    if (isMove) {
      tree.set(n, text);
      tree.set(o, null);
      tree.moves.push([o, n]);
    } else {
      tree.set(o, text);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return unifiedSections(lines).map((s) => unifiedEdit(s, strict));
}

/* Section 7: SEARCH/REPLACE blocks. */

function srEdit(p: string, old: string[], neu: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (old.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, neu.length === 0 ? '' : neu.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const st = parseFile(before);
    const found = findOccurrences(st.lines, old, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.at.length > 1) throw new Fail('ambiguous', p);
    const at = found.at[0]!;
    const add = buildNew(st.lines, at, old, neu.map((t) => ({ text: t, oi: -1 })), found.tier);
    st.lines.splice(at, old.length, ...add);
    tree.set(p, writeFile(st));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let regionStart = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let p: string | null = null;
    for (let j = i - 1; j >= regionStart; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      p = t;
      break;
    }
    if (p === null) p = prevPath;
    if (p === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    const old: string[] = [];
    let j = i + 1;
    let foundEq = false;
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.trimEnd() === '=======') {
        foundEq = true;
        break;
      }
      if (l.trimEnd() === '>>>>>>> REPLACE') break;
      old.push(l);
      j += 1;
    }
    if (!foundEq) throw new Exit2(`error: parse ${searchLine + 1}`);
    const neu: string[] = [];
    j += 1;
    let foundEnd = false;
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.trimEnd() === '>>>>>>> REPLACE') {
        foundEnd = true;
        break;
      }
      neu.push(l);
      j += 1;
    }
    if (!foundEnd) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(srEdit(p, old, neu, strict));
    prevPath = p;
    regionStart = j + 1;
    i = j + 1;
  }
  return edits;
}

/* Section 8: V4A patches. */

interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  addLines: string[];
  moveTo: string | null;
  chunks: Chunk[];
}

function v4aSections(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface Raw {
    sec: VSection;
    raw: Array<{ line: string; no: number }>;
  }
  const raws: Raw[] = [];
  let cur: Raw | null = null;
  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i]!;
    const kinds: Array<['add' | 'delete' | 'update', string]> = [
      ['add', '*** Add File: '],
      ['delete', '*** Delete File: '],
      ['update', '*** Update File: '],
    ];
    let started = false;
    for (const [kind, prefix] of kinds) {
      if (line.startsWith(prefix)) {
        const sec: VSection = { kind, path: line.slice(prefix.length).trim(), lineNo: i + 1, addLines: [], moveTo: null, chunks: [] };
        cur = { sec, raw: [] };
        raws.push(cur);
        started = true;
        break;
      }
    }
    if (started) continue;
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    cur.raw.push({ line, no: i + 1 });
  }
  const sections: VSection[] = [];
  for (const { sec, raw } of raws) {
    while (raw.length > 0 && blank(raw[raw.length - 1]!.line)) raw.pop();
    if (sec.kind === 'add') {
      for (const { line, no } of raw) {
        if (line.startsWith('+')) sec.addLines.push(line.slice(1));
        else if (line === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${no}`);
      }
    } else if (sec.kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
    } else {
      let chunk: Chunk | null = null;
      let closedAny = false;
      for (const { line, no } of raw) {
        if (line.startsWith('*** Move to: ')) {
          if (sec.moveTo !== null || sec.chunks.length > 0 || chunk !== null) throw new Exit2(`error: parse ${no}`);
          sec.moveTo = line.slice('*** Move to: '.length).trim();
          continue;
        }
        if (line.trim() === '*** End of File') {
          if (chunk === null) {
            chunk = { anchor: null, eof: true, body: [] };
            sec.chunks.push(chunk);
          }
          chunk.eof = true;
          chunk = null;
          closedAny = true;
          continue;
        }
        if (line.startsWith('@@')) {
          const anchor = line.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          sec.chunks.push(chunk);
          continue;
        }
        if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
          if (chunk === null) {
            if (sec.chunks.length > 0 || closedAny) throw new Exit2(`error: parse ${no}`);
            chunk = { anchor: null, eof: false, body: [] };
            sec.chunks.push(chunk);
          }
          chunk.body.push({ kind: line === '' ? ' ' : line[0]!, text: line === '' ? '' : line.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${no}`);
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
    }
    sections.push(sec);
  }
  return sections;
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.set(p, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const st = parseFile(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let idx = -1;
        for (const tier of tiers) {
          const want = tierLine(chunk.anchor, tier);
          for (let i = cursor; i < st.lines.length; i += 1) {
            if (tierLine(st.lines[i]!, tier) === want) {
              idx = i;
              break;
            }
          }
          if (idx >= 0) break;
        }
        if (idx < 0) throw new Fail('no-match', p);
        cursor = idx + 1;
      }
      const old: string[] = [];
      const neu: NLine[] = [];
      for (const b of chunk.body) {
        if (b.kind === ' ') {
          old.push(b.text);
          neu.push({ text: b.text, oi: old.length - 1 });
        } else if (b.kind === '-') old.push(b.text);
        else if (b.kind === '+') neu.push({ text: b.text, oi: -1 });
      }
      if (old.length === 0) {
        const at = chunk.eof ? st.lines.length : Math.min(cursor, st.lines.length);
        st.lines.splice(at, 0, ...neu.map((n) => n.text));
        cursor = at + neu.length;
        continue;
      }
      const found = findOccurrences(st.lines, old, strict, cursor);
      if (found === null) throw new Fail('no-match', p);
      let at = -1;
      for (const cand of found.at) {
        if (!chunk.eof || cand + old.length === st.lines.length) {
          at = cand;
          break;
        }
      }
      if (at < 0) throw new Fail('no-match', p);
      const add = buildNew(st.lines, at, old, neu, found.tier);
      st.lines.splice(at, old.length, ...add);
      cursor = at + add.length;
    }
    const text = writeFile(st);
    if (sec.moveTo !== null) {
      tree.set(sec.moveTo, text);
      tree.set(p, null);
      tree.moves.push([p, sec.moveTo]);
    } else {
      tree.set(p, text);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return v4aSections(lines).map((s) => v4aEdit(s, strict));
}

/* Section 4: detecting the format. */

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
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
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
  const entries: Array<{ key: string; line: string }> = [];
  const consumed = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (consumed.has(o) || consumed.has(n)) continue;
    if (tree.original(o) !== null && tree.finalOf(o) === null && tree.original(n) === null && tree.finalOf(n) !== null) {
      entries.push({ key: n, line: `R ${o} -> ${n}` });
      consumed.add(o);
      consumed.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
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
  return { code: 0, out: [...entries.map((e) => e.line), `ok: ${entries.length} ${entries.length === 1 ? 'file' : 'files'}`] };
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

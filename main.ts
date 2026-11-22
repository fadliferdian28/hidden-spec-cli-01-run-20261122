// main.ts is mend, the CLI SPEC.md specifies: it applies an edit an AI model wrote, in one of four formats
// (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), to a tree of text files, all or nothing. It covers
// every section of SPEC.md: the command line, output and exit codes, safe paths, format detection, three-tier
// line matching, unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits, and the all-or-nothing write.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** What the parsers need: whether matching is exact-only, and where to record a successful move. */
interface Opts {
  strict: boolean;
  moves: { old: string; new: string }[];
}

// --- Section 3: a file as its lines, its own line break, and whether it ends with one. ---

interface FileText {
  lines: string[];
  br: string;
  ends: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const ends = text.endsWith(br);
  if (ends) lines.pop();
  return { lines, br, ends };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}

// --- Section 5: matching lines at three tiers. ---

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every 0-based position at or after `from` where O occurs in `lines` at `tier`. */
function occurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = Math.max(0, from); i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (!lineEq(O[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once at or after `from`, with its positions. */
function findTiered(O: string[], lines: string[], strict: boolean, from: number): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(O, lines, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of O or N: its text, whether it is a context line, and, for a context line, its index in O. */
interface LineItem {
  text: string;
  ctx: boolean;
  oPos: number;
}

/**
 * The lines N writes for a match at `pos`: a context line is the file's own matched line, every other line
 * of N is re-indented at tier 2 (F is the leading whitespace of the file's first matched line, P that of
 * O's first line) and written as it is at tiers 0 and 1.
 */
function buildNew(fileLines: string[], pos: number, o: LineItem[], n: LineItem[], tier: number): string[] {
  let p = '';
  let f = '';
  if (tier === 2 && o.length > 0) {
    p = leadWs(o[0]!.text);
    f = leadWs(fileLines[pos]!);
  }
  const out: string[] = [];
  for (const item of n) {
    if (item.ctx) {
      out.push(fileLines[pos + item.oPos]!);
    } else if (tier === 2) {
      const t = item.text;
      out.push(t !== '' && /[^ \t]/.test(t) && t.startsWith(p) ? f + t.slice(p.length) : t);
    } else {
      out.push(item.text);
    }
  }
  return out;
}

/** Replace the k matched lines at `pos` by N, on a copy of `lines`. */
function spliceReplace(lines: string[], pos: number, o: LineItem[], n: LineItem[], tier: number): string[] {
  return [...lines.slice(0, pos), ...buildNew(lines, pos, o, n, tier), ...lines.slice(pos + o.length)];
}

function itemsOf(texts: string[]): LineItem[] {
  return texts.map((text) => ({ text, ctx: false, oPos: -1 }));
}

// --- Section 6: unified diffs. ---

/** One body line of a hunk: its raw patch line, its kind, its text, and whether a `\` line follows it. */
interface BodyItem {
  raw: string;
  kind: string;
  text: string;
  bs: boolean;
}

interface Hunk {
  a: number;
  body: BodyItem[];
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_RE = /^diff --git a\/(.+) b\/(.+)$/;

function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function hunkItems(h: Hunk): { o: LineItem[]; n: LineItem[] } {
  const o: LineItem[] = [];
  const n: LineItem[] = [];
  for (const b of h.body) {
    if (b.kind === ' ') {
      const item: LineItem = { text: b.text, ctx: true, oPos: o.length };
      o.push(item);
      n.push(item);
    } else if (b.kind === '-') {
      o.push({ text: b.text, ctx: false, oPos: -1 });
    } else if (b.kind === '+') {
      n.push({ text: b.text, ctx: false, oPos: -1 });
    }
  }
  return { o, n };
}

/** Whether a `\` line follows the hunk's last context or `+` body line. */
function lastPlusBs(h: Hunk): boolean {
  for (let i = h.body.length - 1; i >= 0; i -= 1) {
    const b = h.body[i]!;
    if (b.kind === ' ' || b.kind === '+') return b.bs;
  }
  return false;
}

function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  let cur = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkItems(h);
    const oTexts = o.map((x) => x.text);
    if (o.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, cur.lines.length));
      const added = buildNew(cur.lines, at, o, n, 0);
      const lines = [...cur.lines.slice(0, at), ...added, ...cur.lines.slice(at)];
      let ends = cur.ends;
      if (at === cur.lines.length && added.length > 0) ends = !lastPlusBs(h);
      cur = { lines, br: cur.br, ends };
      d += n.length;
      continue;
    }
    const found = findTiered(oTexts, cur.lines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.pos[0]!;
    for (const q of found.pos) {
      if (Math.abs(q - target) < Math.abs(pos - target)) pos = q;
    }
    const lines = spliceReplace(cur.lines, pos, o, n, found.tier);
    let ends = cur.ends;
    if (pos + o.length === cur.lines.length) {
      ends = n.length === 0 ? pos > 0 : !lastPlusBs(h);
    }
    cur = { lines, br: cur.br, ends };
    d += n.length - o.length;
  }
  return joinFile(cur);
}

function unifiedEdits(lines: string[], opts: Opts): Edit[] {
  const sections: UniSection[] = [];
  let sec: UniSection | null = null;
  let mode: 'outside' | 'header' | 'body' | 'after' = 'outside';
  let hunk: Hunk | null = null;

  const startSection = (oldPath: string | null, newPath: string | null): void => {
    sec = { oldPath, newPath, newFile: false, deletedFile: false, hunks: [] };
    sections.push(sec);
    mode = 'header';
    hunk = null;
  };
  const endBody = (): void => {
    if (hunk !== null) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.raw === '') hunk.body.pop();
    }
    hunk = null;
    mode = 'after';
  };

  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (mode === 'body') {
      const isNewSection = l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '));
      if (isNewSection) {
        endBody();
        continue;
      }
      if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
        hunk!.body.push({ raw: l, kind: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1), bs: false });
        i += 1;
        continue;
      }
      if (l.startsWith('\\')) {
        const body = hunk!.body;
        if (body.length > 0) body[body.length - 1]!.bs = true;
        i += 1;
        continue;
      }
      endBody();
      continue;
    }
    if (l.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(l.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // A pair in a section's header names that section's paths; anywhere else (after a hunk, or
      // with no section open) it starts a new section.
      if (mode !== 'header' || sec === null) {
        startSection(null, null);
      }
      sec!.oldPath = headerPath(l);
      sec!.newPath = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (mode === 'header' && l.startsWith('--- ')) {
      throw new Exit2(`error: parse ${i + 2 <= lines.length ? i + 2 : lines.length + 1}`);
    }
    if (l.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: parseInt(m[1]!, 10), body: [] };
      sec.hunks.push(hunk);
      mode = 'body';
      i += 1;
      continue;
    }
    if (mode === 'header' && sec !== null) {
      if (l.startsWith('rename from ')) sec.oldPath = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) sec.newPath = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) sec.newFile = true;
      else if (l.startsWith('deleted file mode')) sec.deletedFile = true;
    }
    i += 1;
  }
  if (mode === 'body') endBody();

  const edits: Edit[] = [];
  for (const s of sections) {
    const oldP = s.oldPath ?? '';
    const newP = s.newPath ?? '';
    const isCreate = oldP === '/dev/null' || s.newFile;
    const isDelete = !isCreate && (newP === '/dev/null' || s.deletedFile);
    const isMove = !isCreate && !isDelete && oldP !== newP;
    if (isCreate) {
      edits.push((tree) => {
        if (!safe(newP)) throw new Fail('unsafe', newP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const plus: string[] = [];
        let ends = false;
        let lastBs = false;
        let any = false;
        for (const h of s.hunks) {
          for (const b of h.body) {
            if (b.kind === '+') {
              plus.push(b.text);
              lastBs = b.bs;
              any = true;
            }
          }
        }
        ends = any && !lastBs;
        tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (ends ? '\n' : ''));
      });
    } else if (isDelete) {
      edits.push((tree) => {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
      });
    } else if (isMove) {
      edits.push((tree) => {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (!safe(newP)) throw new Fail('unsafe', newP);
        const before = tree.get(oldP);
        if (before === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const after = applyHunks(before, s.hunks, opts.strict, oldP);
        tree.now.set(newP, after);
        tree.now.set(oldP, null);
        opts.moves.push({ old: oldP, new: newP });
      });
    } else {
      edits.push((tree) => {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        const before = tree.get(oldP);
        if (before === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, applyHunks(before, s.hunks, opts.strict, oldP));
      });
    }
  }
  return edits;
}

// --- Section 7: SEARCH/REPLACE blocks. ---

function srEdits(lines: string[], opts: Opts): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(((p: string, o: string[], n: string[]) => (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (o.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, n.length === 0 ? '' : n.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const found = findTiered(o, f.lines, opts.strict, 0);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const out = spliceReplace(f.lines, found.pos[0]!, itemsOf(o), itemsOf(n), found.tier);
      tree.now.set(p, joinFile({ lines: out, br: f.br, ends: f.ends }));
    })(path, oldLines, newLines));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// --- Section 8: V4A patches. ---

interface VChunk {
  anchor: string | null;
  body: BodyItem[];
  eof: boolean;
}

function chunkItems(c: VChunk): { o: LineItem[]; n: LineItem[] } {
  const o: LineItem[] = [];
  const n: LineItem[] = [];
  for (const b of c.body) {
    if (b.kind === ' ') {
      const item: LineItem = { text: b.text, ctx: true, oPos: o.length };
      o.push(item);
      n.push(item);
    } else if (b.kind === '-') {
      o.push({ text: b.text, ctx: false, oPos: -1 });
    } else if (b.kind === '+') {
      n.push({ text: b.text, ctx: false, oPos: -1 });
    }
  }
  return { o, n };
}

function v4aEdits(lines: string[], opts: Opts): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    // Collect this section's raw lines: up to the next section start or *** End Patch.
    const collect = (from: number): { raw: { line: string; no: number }[]; next: number } => {
      const raw: { line: string; no: number }[] = [];
      let j = from;
      while (j < last && !isSectionStart(lines[j]!)) {
        raw.push({ line: lines[j]!, no: j + 1 });
        j += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.line)) raw.pop();
      return { raw, next: j };
    };
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const { raw, next } = collect(i + 1);
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.line === '') fileLines.push('');
        else if (r.line.startsWith('+')) fileLines.push(r.line.slice(1));
        else throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push(((p: string, fl: string[]) => (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fl.length === 0 ? '' : fl.join('\n') + '\n');
      })(path, fileLines));
      i = next;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      const { raw, next } = collect(i + 1);
      for (const r of raw) {
        if (!blank(r.line)) throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push(((p: string) => (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      })(path));
      i = next;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateNo = i + 1;
      const { raw, next } = collect(i + 1);
      let moveTo: string | null = null;
      let k = 0;
      if (k < raw.length && raw[k]!.line.startsWith('*** Move to: ')) {
        moveTo = raw[k]!.line.slice('*** Move to: '.length).trim();
        k += 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (; k < raw.length; k += 1) {
        const r = raw[k]!;
        if (r.line.startsWith('@@')) {
          const anchor = r.line.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          chunks.push(cur);
        } else if (r.line === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.no}`);
          cur.eof = true;
          cur = null;
        } else if (r.line === '' || r.line.startsWith(' ') || r.line.startsWith('-') || r.line.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${r.no}`);
            cur = { anchor: null, body: [], eof: false };
            chunks.push(cur);
          }
          cur.body.push({ raw: r.line, kind: r.line === '' ? ' ' : r.line[0]!, text: r.line === '' ? '' : r.line.slice(1), bs: false });
        } else {
          throw new Exit2(`error: parse ${r.no}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateNo}`);
      edits.push(((p: string, mv: string | null, chs: VChunk[]) => (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
        const f = splitFile(before);
        let cursor = 0;
        for (const c of chs) {
          if (c.anchor !== null) {
            const found = findTiered([c.anchor], f.lines, opts.strict, cursor);
            if (found === null) throw new Fail('no-match', p);
            cursor = found.pos[0]! + 1;
          }
          const { o, n } = chunkItems(c);
          const oTexts = o.map((x) => x.text);
          if (o.length === 0) {
            const at = c.eof ? f.lines.length : cursor;
            const added = buildNew(f.lines, at, o, n, 0);
            f.lines = [...f.lines.slice(0, at), ...added, ...f.lines.slice(at)];
            cursor = at + added.length;
            continue;
          }
          const found = findTiered(oTexts, f.lines, opts.strict, cursor);
          if (found === null) throw new Fail('no-match', p);
          let pos: number | null = null;
          for (const q of found.pos) {
            if (!c.eof || q + o.length === f.lines.length) {
              pos = q;
              break;
            }
          }
          if (pos === null) throw new Fail('no-match', p);
          f.lines = spliceReplace(f.lines, pos, o, n, found.tier);
          cursor = pos + n.length;
        }
        const after = joinFile(f);
        if (mv !== null) {
          tree.now.set(mv, after);
          tree.now.set(p, null);
          opts.moves.push({ old: p, new: mv });
        } else {
          tree.now.set(p, after);
        }
      })(path, moveTo, chunks));
      i = next;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

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
  const opts: Opts = { strict, moves: [] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, opts);
    else if (kind === 'search-replace') edits = srEdits(lines, opts);
    else edits = v4aEdits(lines, opts);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: { p: string; was: string | null; now: string | null }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ p, was, now });
  }
  const rows: { sort: string; text: string }[] = changed.map((c) => ({
    sort: c.p,
    text: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${c.p}`,
  }));
  for (const m of opts.moves) {
    const dIdx = rows.findIndex((r) => r.text === `D ${m.old}`);
    const aIdx = rows.findIndex((r) => r.text === `A ${m.new}`);
    if (dIdx >= 0 && aIdx >= 0) {
      rows.splice(Math.max(dIdx, aIdx), 1);
      rows.splice(Math.min(dIdx, aIdx), 1);
      rows.push({ sort: m.new, text: `R ${m.old} -> ${m.new}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)));
  if (!check) {
    for (const c of changed) {
      if (c.now === null) rmSync(c.p, { force: true });
      else {
        mkdirSync(dirname(c.p), { recursive: true });
        writeFileSync(c.p, c.now);
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

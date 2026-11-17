import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DiffHunk, FileDiff, GitCommitResult, GitFileStatus, GitStatus } from '../../shared/protocol';
import { makeFileDiff, parseUnifiedDiff } from '../../shared/diff';
import type { App } from '../app';

// ───────────────────────────── git runner ─────────────────────────────

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** git is not installed / not on PATH. */
  missing: boolean;
  timedOut: boolean;
  /** stdout hit maxBytes and was cut. */
  truncated: boolean;
}

/**
 * Runs git directly (no shell, so no quoting issues) with a hard timeout and output cap.
 * Never rejects: a missing binary, a timeout or a non-zero exit are reported in the result.
 */
export function runGit(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number; maxBytes?: number; input?: string } = {},
): Promise<GitResult> {
  return new Promise((resolve) => {
    const max = opts.maxBytes ?? 16_000_000;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let truncated = false;
    let timedOut = false;
    let done = false;
    const finish = (code: number | null, missing = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        missing,
        timedOut,
        truncated,
      });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', ['-c', 'core.quotePath=false', '-c', 'color.ui=false', ...args], {
        cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C' },
      });
    } catch {
      resolve({ code: null, stdout: '', stderr: '', missing: true, timedOut: false, truncated: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* gone */
      }
      finish(null);
    }, opts.timeoutMs ?? 10_000);
    child.stdout!.on('data', (d: Buffer) => {
      if (outLen >= max) {
        truncated = true;
        return;
      }
      if (outLen + d.length > max) {
        d = d.subarray(0, max - outLen);
        truncated = true;
      }
      out.push(d);
      outLen += d.length;
    });
    child.stderr!.on('data', (d: Buffer) => {
      if (errLen < 64_000) {
        err.push(d);
        errLen += d.length;
      }
    });
    child.on('error', (e: NodeJS.ErrnoException) => finish(null, e.code === 'ENOENT'));
    child.on('close', (code) => finish(code));
    child.stdin!.on('error', () => {});
    child.stdin!.end(opts.input ?? '');
  });
}

/** Repository top-level for `cwd`, or null when not a repo / git missing / cwd unreadable. */
export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    if (!(await stat(cwd)).isDirectory()) return null;
  } catch {
    return null;
  }
  const r = await runGit(cwd, ['rev-parse', '--show-toplevel'], { timeoutMs: 5000 });
  if (r.code !== 0) return null;
  const top = r.stdout.trim();
  return top ? path.resolve(top) : null;
}

// ───────────────────────────── helpers ─────────────────────────────

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_DIFF_LINES = 4000;
const MAX_UNTRACKED_FILES = 300;
const MAX_UNTRACKED_BYTES = 1_000_000;
const UNTRACKED_BUDGET = 8_000_000;

const toPosix = (p: string) => p.replace(/\\/g, '/');

/** Repo-root-relative git path → path relative to `cwd` (forward slashes). */
function relToCwd(root: string, cwd: string, p: string): string {
  // git reports the real top-level path; a cwd reached through a symlink (macOS /var → /private/var,
  // a linked project folder) is resolved the same way, or every path would climb out with ../.
  let base = path.resolve(cwd);
  try {
    base = realpathSync.native(base);
  } catch {
    /* gone: compare as given */
  }
  if (path.resolve(root) === base) return p;
  return toPosix(path.relative(base, path.join(root, p)));
}

/** Reads a file prefix; null when unreadable. `binary` when NUL bytes appear in the first 8 KB. */
async function readText(file: string, maxBytes: number): Promise<{ text: string; binary: boolean; size: number } | null> {
  let fh;
  try {
    fh = await open(file, 'r');
    const st = await fh.stat();
    if (!st.isFile()) return null;
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, 0);
    const data = buf.subarray(0, bytesRead);
    const binary = data.subarray(0, 8192).includes(0);
    return { text: binary ? '' : data.toString('utf8'), binary, size: st.size };
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

function countLines(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith('\n') ? n : n + 1;
}

async function hasHead(cwd: string): Promise<boolean> {
  const r = await runGit(cwd, ['rev-parse', '--verify', '-q', 'HEAD'], { timeoutMs: 5000 });
  return r.code === 0;
}

/** Parses `git diff --numstat -z` into path → counts (binary files count as 0). */
function parseNumstat(out: string, into: Map<string, { a: number; d: number }>) {
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const m = rec.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!m) continue;
    let file = m[3];
    if (file === '') {
      // Rename/copy: "<a>\t<d>\t\0<old>\0<new>\0"
      i += 2;
      file = parts[i] ?? '';
    }
    if (!file) continue;
    const prev = into.get(file) ?? { a: 0, d: 0 };
    prev.a += m[1] === '-' ? 0 : Number(m[1]);
    prev.d += m[2] === '-' ? 0 : Number(m[2]);
    into.set(file, prev);
  }
}

function mapStatus(x: string, y: string): string {
  const norm = (c: string) => (c === 'T' ? 'M' : c === 'C' ? 'A' : c);
  if (x === 'A' || x === 'R' || x === 'C') return norm(x);
  if (y !== '.') return norm(y);
  return norm(x);
}

/** Limits a parsed file diff to MAX_DIFF_LINES hunk lines, keeping headers consistent. */
function capDiff(f: FileDiff): FileDiff {
  let budget = MAX_DIFF_LINES;
  if (f.hunks.reduce((n, h) => n + h.lines.length, 0) <= budget) return f;
  const hunks: DiffHunk[] = [];
  for (const h of f.hunks) {
    if (budget <= 0) break;
    if (h.lines.length <= budget) {
      hunks.push(h);
      budget -= h.lines.length;
      continue;
    }
    const lines = h.lines.slice(0, budget);
    let o = 0;
    let n = 0;
    for (const l of lines) {
      if (l[0] !== '+') o++;
      if (l[0] !== '-') n++;
    }
    hunks.push({ ...h, lines, oldLines: o, newLines: n });
    budget = 0;
  }
  return { ...f, hunks };
}

// ───────────────────────────── handlers ─────────────────────────────

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const dir = path.resolve(cwd);
  const none: GitStatus = { isRepo: false, files: [], additions: 0, deletions: 0 };
  const root = await repoRoot(dir);
  if (!root) return none;

  const [st, unstaged, staged] = await Promise.all([
    runGit(dir, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { timeoutMs: 15_000 }),
    runGit(dir, ['diff', '--numstat', '-z', '--no-ext-diff'], { timeoutMs: 15_000 }),
    runGit(dir, ['diff', '--numstat', '-z', '--no-ext-diff', '--cached'], { timeoutMs: 15_000 }),
  ]);
  if (st.code !== 0) return none;

  const result: GitStatus = { isRepo: true, files: [], additions: 0, deletions: 0 };
  let oid = '';
  let head = '';
  const files: (GitFileStatus & { raw: string })[] = [];
  const recs = st.stdout.split('\0');
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (!rec) continue;
    if (rec.startsWith('# ')) {
      const [, key, ...rest] = rec.split(' ');
      const val = rest.join(' ');
      if (key === 'branch.oid') oid = val;
      else if (key === 'branch.head') head = val;
      else if (key === 'branch.ab') {
        const m = val.match(/^\+(\d+) -(\d+)$/);
        if (m) {
          result.ahead = Number(m[1]);
          result.behind = Number(m[2]);
        }
      }
      continue;
    }
    const kind = rec[0];
    if (kind === '1' || kind === '2' || kind === 'u') {
      const fieldCount = kind === '1' ? 8 : kind === '2' ? 9 : 10;
      const fields = rec.split(' ');
      const xy = fields[1];
      const raw = fields.slice(fieldCount).join(' ');
      if (kind === '2') i++; // original path follows as its own NUL-terminated record
      const x = xy[0];
      const y = xy[1];
      files.push({
        raw,
        path: relToCwd(root, dir, raw),
        status: kind === 'u' ? 'U' : mapStatus(x, y),
        staged: kind !== 'u' && x !== '.',
      });
    } else if (kind === '?') {
      const raw = rec.slice(2);
      files.push({ raw, path: relToCwd(root, dir, raw), status: '?', staged: false });
    }
  }
  result.branch = head && head !== '(detached)' ? head : oid && oid !== '(initial)' ? oid.slice(0, 7) : undefined;

  // numstat paths are repo-root relative, like porcelain paths.
  const counts = new Map<string, { a: number; d: number }>();
  if (unstaged.code === 0) parseNumstat(unstaged.stdout, counts);
  if (staged.code === 0) parseNumstat(staged.stdout, counts);

  // Untracked files have no numstat: count their lines, a few files at a time, within a budget.
  const untracked = files.filter((f) => f.status === '?');
  let budget = UNTRACKED_BUDGET;
  for (const f of untracked) f.additions = 0;
  const counted = untracked.slice(0, MAX_UNTRACKED_FILES);
  for (let i = 0; i < counted.length && budget > 0; i += 8) {
    const batch = counted.slice(i, i + 8);
    const share = Math.min(MAX_UNTRACKED_BYTES, Math.max(1, Math.floor(budget / batch.length)));
    const texts = await Promise.all(batch.map((f) => readText(path.join(root, f.raw), share)));
    texts.forEach((t, k) => {
      if (!t) return;
      budget -= Math.min(t.size, share);
      batch[k].additions = t.binary ? 0 : countLines(t.text);
    });
  }
  for (const f of files) {
    if (f.status === '?') {
      f.deletions = 0;
    } else {
      const c = counts.get(f.raw);
      f.additions = c?.a ?? 0;
      f.deletions = c?.d ?? 0;
    }
    result.additions += f.additions ?? 0;
    result.deletions += f.deletions ?? 0;
  }
  result.files = files.map(({ raw: _raw, ...rest }) => rest);
  return result;
}

export async function gitDiff(cwd: string, file?: string, stagedOnly?: boolean): Promise<FileDiff[]> {
  const dir = path.resolve(cwd);
  const root = await repoRoot(dir);
  if (!root) return [];
  const spec = file ? ['--', path.resolve(dir, file)] : [];
  const base = (await hasHead(dir)) ? 'HEAD' : EMPTY_TREE;
  const args = [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '-M',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    ...(stagedOnly ? ['--cached', base] : [base]),
    ...spec,
  ];
  const [d, others] = await Promise.all([
    runGit(dir, args, { timeoutMs: 20_000, maxBytes: 32_000_000 }),
    stagedOnly
      ? Promise.resolve(null)
      : runGit(dir, ['ls-files', '--others', '--exclude-standard', '-z', '--full-name', ...spec], { timeoutMs: 10_000 }),
  ]);
  const out: FileDiff[] = [];
  if (d.code === 0 || d.stdout) {
    for (const f of parseUnifiedDiff(d.stdout)) {
      const fixed: FileDiff = { ...f, path: relToCwd(root, dir, f.path) };
      if (f.oldPath) fixed.oldPath = relToCwd(root, dir, f.oldPath);
      if (fixed.binary) fixed.hunks = [];
      out.push(capDiff(fixed));
    }
  }
  if (others && others.code === 0) {
    const list = others.stdout.split('\0').filter(Boolean).slice(0, MAX_UNTRACKED_FILES);
    let budget = UNTRACKED_BUDGET;
    for (const raw of list) {
      const rel = relToCwd(root, dir, raw);
      const t = budget > 0 ? await readText(path.join(root, raw), Math.min(MAX_UNTRACKED_BYTES, budget)) : null;
      if (!t) continue;
      budget -= t.text.length;
      if (t.binary) {
        out.push({ path: rel, status: 'added', additions: 0, deletions: 0, hunks: [], binary: true });
        continue;
      }
      const fd = makeFileDiff(rel, null, t.text);
      out.push(capDiff(fd));
    }
  }
  return out;
}

export async function gitBranches(cwd: string): Promise<{ current?: string; branches: string[] }> {
  const dir = path.resolve(cwd);
  if (!(await repoRoot(dir))) return { branches: [] };
  const [cur, refs] = await Promise.all([
    runGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: 5000 }),
    runGit(dir, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads/'], {
      timeoutMs: 10_000,
    }),
  ]);
  const branches = refs.code === 0 ? refs.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  const current = cur.code === 0 ? cur.stdout.trim() || undefined : undefined;
  return { current, branches };
}

/** The last meaningful lines of git's complaint, without hint noise. */
function gitError(r: GitResult, fallback: string): string {
  if (r.missing) return 'Git is not installed or not on PATH.';
  if (r.timedOut) return 'Git took too long and was stopped.';
  const text = `${r.stderr}\n${r.stdout}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('hint:'))
    .slice(0, 3)
    .join(' ');
  return text || fallback;
}

/**
 * Stages every change (`git add -A`) and commits it. The message goes to git on stdin
 * (`commit -F -`), never through a shell, so quotes, dashes and newlines are safe.
 */
export async function gitCommit(cwd: string, message: string): Promise<GitCommitResult> {
  const msg = message.replace(/\r\n/g, '\n').trim();
  if (!msg) return { ok: false, error: 'Write a commit message first.' };
  const dir = path.resolve(cwd);
  if (!(await repoRoot(dir))) return { ok: false, error: 'This folder is not a git repository.' };

  const add = await runGit(dir, ['add', '-A'], { timeoutMs: 60_000 });
  if (add.code !== 0) return { ok: false, error: gitError(add, 'Could not stage the changes.') };
  const commit = await runGit(dir, ['commit', '--quiet', '--file=-', '--cleanup=whitespace'], { input: `${msg}\n`, timeoutMs: 120_000 });
  if (commit.code !== 0) {
    if (/nothing to commit|no changes added/i.test(commit.stdout + commit.stderr)) return { ok: false, error: 'Nothing to commit.' };
    return { ok: false, error: gitError(commit, 'The commit failed.') };
  }
  const head = await runGit(dir, ['log', '-1', '--format=%h%x00%s'], { timeoutMs: 5000 });
  const [hash, summary] = head.stdout.trim().split('\0');
  return { ok: true, hash: hash || undefined, summary: summary ?? msg.split('\n')[0] };
}

export function registerGit(app: App) {
  app.register('git.status', ({ cwd }) => gitStatus(cwd));
  app.register('git.diff', ({ cwd, path: file, staged }) => gitDiff(cwd, file, staged));
  app.register('git.branches', ({ cwd }) => gitBranches(cwd));
  app.register('git.commit', ({ cwd, message }) => gitCommit(cwd, typeof message === 'string' ? message : ''));
}

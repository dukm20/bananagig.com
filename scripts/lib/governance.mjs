// Shared helpers for the governance scripts. Everything operates on process.cwd() as the repo root,
// which keeps the scripts testable against scratch repositories.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const root = () => process.cwd();
export const p = (...parts) => path.join(root(), ...parts);
export const read = (rel) => readFileSync(p(rel), 'utf8');
export const exists = (rel) => existsSync(p(rel));

export function git(args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd: root(), encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.status === 0 ? r.stdout : null;
}
export const isGitRepo = () => git(['rev-parse', '--is-inside-work-tree'], { allowFail: true })?.trim() === 'true';
export const hasHead = () => git(['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true }) !== null;

/** Porcelain status entries: [{ code, file }] (untracked listed per file). */
export function status() {
  const out = git(['status', '--porcelain', '--untracked-files=all']) ?? '';
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => ({ code: l.slice(0, 2), file: l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop() }));
}

/**
 * Files changed in the working tree relative to `base` (default HEAD), including untracked files.
 * Returns Map<file, 'A'|'M'|'D'|'R'>. With no base commit available returns null (baseline mode).
 */
export function changedSince(base = 'HEAD') {
  if (git(['rev-parse', '--verify', '-q', base], { allowFail: true }) === null) return null;
  const map = new Map();
  const diff = git(['diff', '--name-status', '--no-renames', base]) ?? '';
  for (const line of diff.split('\n').filter(Boolean)) {
    const [s, ...f] = line.split('\t');
    map.set(f.join('\t'), s[0]);
  }
  for (const e of status().filter((x) => x.code === '??')) map.set(e.file, 'A');
  return map;
}
export const showAt = (base, rel) => git(['show', `${base}:${rel}`], { allowFail: true });

/** Fingerprint of every non-ignored file's path and content; detects any change after finalization. */
export function treeFingerprint() {
  const files = (git(['ls-files', '-co', '--exclude-standard']) ?? '').split('\n').filter(Boolean).sort();
  const h = createHash('sha256');
  for (const f of files) {
    if (!existsSync(p(f))) continue;
    h.update(f)
      .update('\0')
      .update(
        createHash('sha256')
          .update(readFileSync(p(f)))
          .digest('hex'),
      )
      .update('\n');
  }
  return h.digest('hex');
}

export function run(cmd, args, opts = {}) {
  const t = Date.now();
  const r = spawnSync(cmd, args, { cwd: root(), encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' }, maxBuffer: 64 * 1024 * 1024, ...opts });
  return { ok: r.status === 0, status: r.status, ms: Date.now() - t, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) (flags[k] ??= []).push(v);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--') && ['base', 'snapshot', 'include', 'trailer', 'skill-update'].includes(k))
        (flags[k] ??= []).push(argv[++i]);
      else (flags[k] ??= []).push(true);
    } else positional.push(a);
  }
  return { positional, flags, flag: (k) => flags[k]?.[flags[k].length - 1] };
}

export class Report {
  constructor(title) {
    this.title = title;
    this.errors = [];
    this.notes = [];
  }
  fail(msg) {
    this.errors.push(msg);
  }
  note(msg) {
    this.notes.push(msg);
  }
  finish() {
    for (const n of this.notes) console.log(`  note: ${n}`);
    if (this.errors.length) {
      console.error(`\n${this.title}: FAILED`);
      for (const e of this.errors) console.error(`  ✗ ${e}`);
      process.exit(1);
    }
    console.log(`${this.title}: OK`);
  }
}

export const migrationFiles = () =>
  exists('db/migrations')
    ? readdirSync(p('db/migrations'))
        .filter((f) => f.endsWith('.sql'))
        .sort()
    : [];
export const adrFiles = () =>
  exists('docs/architecture')
    ? readdirSync(p('docs/architecture'))
        .filter((f) => /^ADR-\d{4}-.+\.md$/.test(f))
        .sort()
    : [];

/** Split a markdown document into sections keyed by heading text at the given level. */
export function sections(md, level) {
  const re = new RegExp(`^${'#'.repeat(level)} (.+)$`, 'gm');
  const out = [];
  let m;
  const matches = [];
  while ((m = re.exec(md))) matches.push({ title: m[1].trim(), start: m.index, bodyStart: m.index + m[0].length });
  matches.forEach((x, i) => out.push({ title: x.title, body: md.slice(x.bodyStart, matches[i + 1]?.start ?? md.length) }));
  return out;
}
export const isoDate = /\b\d{4}-\d{2}-\d{2}\b/;
export const meaningful = (body) =>
  body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('<!--') && !/^(tbd|todo|n\/a|placeholder|\.\.\.)$/i.test(l));

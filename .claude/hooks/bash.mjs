// Bash command analysis for the PreToolUse guard (ENG-GOV-001). analyzeBash(command, ctx) -> [{ level: 'deny'|'ask', message }].
// It evaluates every simple command of a compound command (including nested substitutions, `bash -c` scripts, here-documents fed to a
// shell, literal `echo ... | sh` pipes, find -exec / ssh / watch wrappers). It is a local guardrail against accidents, not a security
// boundary: see README.md for what it cannot see (variables, aliases, functions, node -e / python -c, find -delete, rsync --delete, ...).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { canonicalGitOption, GUARDED_GIT_SUBCOMMANDS } from './git-options.mjs';
import {
  BudgetError,
  checkBudget,
  classifyMigrationWrite,
  fsKey,
  gitTopLevel,
  isEnvName,
  isGateFile,
  isMigrationsDirOrAncestor,
  isTestFile,
  realpathLoose,
  rx,
  startBudget,
  toPosix,
} from './lib.mjs';
import { base, commandInfo, hasPlaceholder, parseShell, pkgScript, placeholderList, scanFlags, SHELLS, ShellParseError } from './shell.mjs';

const BUDGET_MS = 8000;
const MAX_SEGMENTS = 4000;
const MAX_COMMAND_CHARS = 400_000;
const MAX_FILE_READ = 1_000_000;
const MAX_DEPTH = 6;

// ---------------------------------------------------------------------------------------------------------------------
// Words, paths and globs
// ---------------------------------------------------------------------------------------------------------------------

const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '<>']);
const SQL_DESTRUCTIVE_OTHER = /\bDROP\s+(?:SCHEMA|TABLE)\b|\bTRUNCATE\b/i;
const THROWAWAY_DB = /^(?:bananagig_t_.+|.+_review|.+_test)$/;
export const isThrowawayDatabase = (name) => THROWAWAY_DB.test(String(name));
const WHOLE_TREE = new Set(['.', './', '*', ':/', ':/.', './.', ':/*', ':(top)']);
const FETCHERS = ['curl', 'wget', 'fetch'];
const SAFE_WITH_ENV_ARG = new Set([
  'ls', 'test', '[', '[[', 'stat', 'wc', 'file', 'echo', 'printf', 'chmod', 'chown', 'chgrp', 'touch', 'basename', 'dirname', 'realpath', 'readlink',
  'mkdir', 'which', 'type', 'true', 'false', 'cd', 'pwd', 'export', 'unset', 'alias', 'set', ':',
]); // prettier-ignore
const SAFE_GIT_SUBS_WITH_ENV_ARG = new Set(['check-ignore', 'status', 'ls-files', 'add', 'rm', 'mv', 'reset', 'restore']);
const PATTERN_FIRST_COMMANDS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'sed', 'gawk', 'awk']);
const INTERPRETERS = new Set(['node', 'nodejs', 'deno', 'bun', 'python', 'python3', 'perl', 'ruby', 'php', 'osascript']);

function normAbs(p) {
  const n = path.normalize(p);
  return n.length > 1 ? n.replace(/\/+$/, '') : n;
}

/** Literal output of a one-command substitution list ($(pwd), $(git rev-parse --show-toplevel)), or null. */
function substValue(list, ctx) {
  if (list.length !== 1) return null;
  const info = commandInfo(list[0]);
  if (info.cmd === 'pwd' && ctx.cwd) return ctx.cwd;
  if (info.cmd === 'git' && info.args.join(' ') === 'rev-parse --show-toplevel' && ctx.top) return ctx.top;
  return null;
}

function expandWord(word, ctx) {
  let w = String(word);
  if (w === '~' || w.startsWith('~/')) w = ctx.home + w.slice(1);
  w = w.replace(/^\$\{?HOME\}?(?=\/|$)/, ctx.home);
  if (ctx.cwd) w = w.replace(/^\$\{?PWD\}?(?=\/|$)/, ctx.cwd);
  if (ctx.seg && hasPlaceholder(w)) {
    const m = /^(?:\$\(|`)\.\.\.#(\d+)(?:\)|`)(?=\/|$)/.exec(w);
    const value = m ? substValue(ctx.seg.subs[Number(m[1])] ?? [], ctx) : null;
    if (value) w = value + w.slice(m[0].length);
  }
  if (/[$`]/.test(w) || hasPlaceholder(w)) return null;
  return w;
}

/** Absolute path for a shell word, or null when it depends on unknown state. */
export function resolveWord(word, ctx) {
  const w = expandWord(word, ctx);
  if (w === null) return null;
  if (path.isAbsolute(w)) return normAbs(w);
  if (!ctx.cwd) return null;
  return normAbs(path.resolve(ctx.cwd, w));
}

const hasGlob = (w) => /[*?[]/.test(w);

function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const j = pattern.indexOf(']', i + 2);
      if (j < 0) re += '\\[';
      else {
        let cls = pattern.slice(i + 1, j);
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
        re += `[${cls.replace(/\\/g, '\\\\')}]`;
        i = j;
      }
    } else re += c.replace(/[.+^${}()|\\/]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, caseFold() ? 'i' : '');
}
const caseFold = () => fsKey('A') === 'a';
const globCouldMatch = (pattern, name) => (!name.startsWith('.') || pattern.startsWith('.')) && globToRegExp(pattern).test(name);

/** Resolve a path word (with an optional glob in the last segment) to real paths. unresolved = could not be determined. */
function resolvePaths(word, ctx) {
  const abs = resolveWord(word, ctx);
  if (abs === null) return { paths: [], unresolved: true };
  if (!hasGlob(abs)) return { paths: [realpathLoose(abs)], unresolved: false };
  const dir = path.dirname(abs);
  if (hasGlob(dir)) return { paths: [], unresolved: true };
  const pattern = path.basename(abs);
  try {
    const names = readdirSync(dir).filter((n) => globCouldMatch(pattern, n));
    return {
      paths: names.slice(0, 500).map((n) => realpathLoose(path.join(dir, n))),
      unresolved: names.length > 500,
    };
  } catch {
    return { paths: [], unresolved: false };
  }
}

function isDangerousDir(abs, ctx) {
  const real = realpathLoose(abs);
  const roots = [ctx.root, ctx.root && realpathLoose(ctx.root)].filter(Boolean);
  const homes = [ctx.home, realpathLoose(ctx.home)];
  const depth = (p) => p.split('/').filter(Boolean).length;
  for (const p of new Set([abs, real])) {
    if (p === '/' || depth(p) <= 1) return `${p} is a top-level system directory`;
    if (homes.includes(p)) return 'the home directory';
    for (const r of roots) {
      if (p === r) return 'the repository root';
      if (r.startsWith(`${p}/`)) return 'a parent of the repository root';
    }
    for (const h of homes) if (h.startsWith(`${p}/`)) return 'a parent of the home directory';
  }
  return null;
}

const DISPOSABLE_DIRS = new Set(['dist', 'build', 'out', 'coverage', '.next', '.turbo', '.cache', 'node_modules', 'tmp', '.vitest']);

/** For recursive `rm`: returns { level, message } or null. */
function rmTargetProblem(word, ctx) {
  if (/^(?:\.{1,2}(?:\/|$))+$/.test(word)) {
    // `cd packages/x/dist && rm -rf .` : a literal cd into a build-output directory makes "." unambiguous
    if (word === '.' && ctx.cdLiteral && ctx.cwd && !isDangerousDir(ctx.cwd, ctx) && DISPOSABLE_DIRS.has(path.basename(ctx.cwd))) return null;
    return { level: 'deny', message: `recursive removal of "${word}" (current or parent directory)` };
  }
  const g = /^(.*\/|)(\*|\.\*|\.\[!\.\]\*|\.\?\*)$/.exec(word);
  const dirWord = g ? (g[1] === '' ? '.' : g[1].length > 1 ? g[1].slice(0, -1) : g[1]) : word;
  if (!g && hasGlob(word)) return null;
  const abs = resolveWord(dirWord, ctx);
  if (abs === null) {
    if (!path.isAbsolute(dirWord) && !ctx.cwd && /^(?:\.|\*)$/.test(dirWord))
      return {
        level: 'ask',
        message: `recursive removal of "${word}" in an unknown directory`,
      };
    return null;
  }
  const why = isDangerousDir(abs, ctx);
  return why ? { level: 'deny', message: `recursive removal of "${word}" (${why})` } : null;
}

const isGitDirWord = (w) => /(?:^|\/)\.git(?:\/\*?)?$/.test(String(w));

function dedupe(findings) {
  const seen = new Set();
  return findings.filter((f) => {
    const k = `${f.level}:${f.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const ask = (out, message) => out.push({ level: 'ask', message });
const deny = (out, message) => out.push({ level: 'deny', message });

// ---------------------------------------------------------------------------------------------------------------------
// Entry point and traversal
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Analyse a Bash command string. ctx: { cwd, root, home }. Anything that cannot be parsed or finished within the time budget yields an
 * 'ask' finding (fail safe), never an allow.
 */
export function analyzeBash(command, ctx0 = {}) {
  startBudget(BUDGET_MS);
  const ctx = {
    cwd: ctx0.cwd || null,
    root: ctx0.root || null,
    home: ctx0.home || homedir(),
    segs: { n: 0 },
    seg: null,
    top: null,
  };
  const out = [];
  try {
    if (String(command).length > MAX_COMMAND_CHARS) throw new BudgetError('the command is too large to analyse');
    ctx.top = ctx.root ? (gitTopLevel(path.join(ctx.root, '.claude-hook-probe')) ?? realpathLoose(ctx.root)) : null;
    evalList(parseShell(command, 0), ctx, out, 0);
  } catch (e) {
    const why =
      e instanceof BudgetError
        ? e.message
        : e instanceof ShellParseError
          ? `could not safely parse the command (${e.message})`
          : `could not safely analyse the command (${e && e.message ? e.message : e})`;
    ask(out, why);
  }
  return dedupe(out);
}

function evalList(segs, ctx0, out, depth) {
  if (depth > MAX_DEPTH) throw new ShellParseError('commands nested too deeply');
  const ctx = { ...ctx0 };
  const groups = [];
  let group = [];
  for (const seg of segs) {
    if (seg.op === '|' && group.length) group.push(seg);
    else {
      if (group.length) groups.push(group);
      group = [seg];
    }
  }
  if (group.length) groups.push(group);
  for (const g of groups) {
    ctx0.segs.n += g.length;
    if (ctx0.segs.n > MAX_SEGMENTS) throw new BudgetError('too many commands to analyse');
    checkBudget();
    evalPipeline(g, ctx, out, depth);
    for (const seg of g) {
      const info = commandInfo(seg);
      if (info.cmd === 'cd' || info.cmd === 'pushd') {
        const target = info.args.find((a) => !a.startsWith('-'));
        ctx.cwd = target === undefined ? ctx.home : target === '-' ? null : resolveWord(target, ctx);
        ctx.cdLiteral = target !== undefined && target !== '-' && ctx.cwd !== null;
      } else if (info.cmd === 'popd') {
        ctx.cwd = null;
        ctx.cdLiteral = false;
      }
    }
  }
}

function evalScript(script, ctx, out, depth) {
  evalList(parseShell(script, depth + 1), ctx, out, depth + 1);
}

function readFileText(word, ctx) {
  const abs = resolveWord(word, ctx);
  if (!abs) return null;
  try {
    if (statSync(abs).size > MAX_FILE_READ) return null;
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

const decodePrintf = (s) => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');

/** The text that a one-command list prints when that is knowable (echo, printf, cat of a heredoc or a readable file), else null. */
function literalScriptOf(list, ctx) {
  if (list.length !== 1) return null;
  return literalOutput(list[0], commandInfo(list[0]), ctx);
}

function literalOutput(seg, info, ctx) {
  if (seg.dynamic || seg.words.some(hasPlaceholder)) return null;
  if (info.cmd === 'echo') return info.args.filter((a) => !/^-[neE]+$/.test(a)).join(' ');
  if (info.cmd === 'printf') return info.args.length && !info.args[0].includes('%') ? decodePrintf(info.args.join('')) : null;
  if (info.cmd === 'cat') {
    const files = info.args.filter((a) => !a.startsWith('-'));
    if (!files.length) {
      const here = seg.redirects.find((r) => r.op === '<<<');
      if (here) return here.target;
      return seg.heredocs.length ? seg.heredocs.join('\n') : null;
    }
    const texts = files.map((f) => readFileText(f, ctx));
    return texts.every((t) => t !== null) ? texts.join('\n') : null;
  }
  return null;
}

/** A script word that is exactly one substitution resolves to what that substitution prints, when knowable. */
function scriptText(seg, word, ctx) {
  const list = placeholderList(seg, word);
  if (list) {
    const lit = literalScriptOf(list, ctx);
    if (lit !== null) return lit;
  }
  return word;
}

function evalPipeline(group, ctx, out, depth) {
  const infos = group.map(commandInfo);
  infos.forEach((info, k) => {
    if (k === 0 || !SHELLS.has(info.cmd) || !info.shellStdin) return;
    const upstream = infos.slice(0, k);
    if (upstream.some((x) => FETCHERS.includes(x.cmd))) {
      deny(out, 'downloads piped into a shell (curl|wget ... | sh)');
      return;
    }
    // echo 'git reset --hard' | bash: look at the literal text; any other producer is invisible, so ask
    const lit = literalOutput(group[k - 1], infos[k - 1], ctx);
    if (lit === null) ask(out, 'a pipe into a shell interpreter runs text this guard cannot see (use bash -c with the command, or run it without the pipe)');
    else evalScript(lit, ctx, out, depth);
  });
  evalSql(group, infos, ctx, out);
  infos.forEach((info, k) => {
    if (info.wrapperFlags.includes('xargs') && isWriterCommand(info)) {
      const upstreamWords = group.slice(0, k).flatMap((s) => s.words);
      if (upstreamWords.some((w) => /migrations|\.sql\b|\.env/i.test(w) || hasPlaceholder(w)))
        ask(out, `xargs runs a file-writing command (${info.cmd}) on paths that may include migrations or secrets files`);
    }
  });
  group.forEach((seg, k) => evalSegment(seg, infos[k], ctx, out, depth));
  for (const seg of group) for (const sub of seg.subst) evalList(sub, ctx, out, depth + 1);
}

function substCommands(seg) {
  const names = [];
  const walk = (list) => {
    for (const s of list) {
      names.push(commandInfo(s).cmd);
      for (const sub of s.subst) walk(sub);
    }
  };
  for (const sub of seg.subst) walk(sub);
  return names;
}

const isInPlaceFlag = (cmd, a) => (cmd === 'awk' || cmd === 'gawk' ? a === 'inplace' : /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'));
function isWriterCommand(info) {
  const { cmd, args } = info;
  if (['tee', 'rm', 'mv', 'cp', 'truncate', 'dd', 'install', 'ln', 'ed', 'unlink', 'shred'].includes(cmd)) return true;
  if (['sed', 'perl', 'ruby', 'awk', 'gawk'].includes(cmd)) return args.some((a) => isInPlaceFlag(cmd, a));
  return false;
}

// ---------------------------------------------------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------------------------------------------------

function isLocalHost(host) {
  if (!host) return true;
  const h = String(host).toLowerCase();
  return h.startsWith('/') || /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|host\.docker\.internal)$/.test(h) || !h.includes('.');
}

function evalSql(group, infos, ctx, out) {
  const wordsOf = (seg) => [...seg.words, ...seg.heredocs, ...seg.redirects.filter((r) => r.op === '<<<').map((r) => r.target)];
  let text = group.flatMap(wordsOf).join('\n');
  // dropdb NAME
  group.forEach((seg, k) => {
    const idx = seg.words.findIndex((w) => base(w) === 'dropdb');
    if (infos[k].cmd !== 'dropdb' && idx < 0) return;
    const args = infos[k].cmd === 'dropdb' ? infos[k].args : seg.words.slice(idx + 1);
    const f = scanFlags(args, {
      valueShortNext: 'UhpEW',
      valueLong: ['username', 'host', 'port', 'maintenance-db'],
    });
    const name = f.positional[f.positional.length - 1];
    if (!name || !isThrowawayDatabase(name)) ask(out, `dropdb ${name ?? '(unknown database)'}: not a throwaway database (bananagig_t_*, *_review, *_test)`);
  });
  group.forEach((seg, k) => {
    const idx = seg.words.findIndex((w) => base(w) === 'pg_restore');
    if (infos[k].cmd !== 'pg_restore' && idx < 0) return;
    const args = infos[k].cmd === 'pg_restore' ? infos[k].args : seg.words.slice(idx + 1);
    const f = scanFlags(args, {
      valueShortNext: 'dhpUjLFfl',
      valueLong: ['dbname', 'host', 'port', 'username', 'file', 'format'],
    });
    if (f.long.has('clean') || f.short.has('c')) {
      const db = f.long.get('dbname') ?? args[args.findIndex((a) => a === '-d') + 1];
      if (!db || !isThrowawayDatabase(db))
        ask(out, `pg_restore --clean drops existing objects in ${db ?? 'an unknown database'}, which is not a throwaway database`);
    }
  });
  const psqlSeg = group.find((seg, k) => infos[k].cmd === 'psql' || seg.words.some((w) => base(w) === 'psql'));
  if (!psqlSeg) return;
  const idx = psqlSeg.words.findIndex((w) => base(w) === 'psql');
  const psqlInfo = infos[group.indexOf(psqlSeg)];
  const args = idx >= 0 ? psqlSeg.words.slice(idx + 1) : [];
  // SQL read from files: -f FILE, < FILE, cat FILE | psql
  const fileWords = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-f' || args[i] === '--file') fileWords.push(args[i + 1]);
    else if (args[i].startsWith('--file=')) fileWords.push(args[i].slice(7));
    else if (/^-f./.test(args[i]) && !args[i].startsWith('--')) fileWords.push(args[i].slice(2));
  }
  for (const r of psqlSeg.redirects) if (r.op === '<') fileWords.push(r.target);
  group.forEach((seg, k) => {
    if (infos[k].cmd === 'cat') for (const a of infos[k].args) if (!a.startsWith('-')) fileWords.push(a);
  });
  for (const w of fileWords.filter(Boolean)) {
    const t = readFileText(w, ctx);
    if (t) text += `\n${t}`;
  }
  const dropDbs = [...text.matchAll(/\bDROP\s+DATABASE\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z0-9_$-]+))/gi)].map((m) => m[1] ?? m[2]);
  const hasOther = SQL_DESTRUCTIVE_OTHER.test(text);
  if (!dropDbs.length && !hasOther) return;
  // connection database and host
  let connDb = null;
  let host = psqlInfo.env.PGHOST ?? null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-d' || a === '--dbname') connDb = args[i + 1] ?? connDb;
    else if (a.startsWith('--dbname=')) connDb = a.slice(9);
    else if (/^-d./.test(a) && !a.startsWith('--')) connDb = a.slice(2);
    if (a === '-h' || a === '--host') host = args[i + 1] ?? host;
    else if (a.startsWith('--host=')) host = a.slice(7);
    else if (/^-h./.test(a) && !a.startsWith('--')) host = a.slice(2);
  }
  if (!connDb) {
    const f = scanFlags(args, { valueShortNext: 'cdfhLopPRTUvF' });
    connDb = f.positional[0] ?? psqlInfo.env.PGDATABASE ?? null;
  }
  if (connDb && /^postgres(?:ql)?:\/\//.test(connDb)) {
    try {
      const u = new URL(connDb);
      host = u.hostname || host;
      connDb = decodeURIComponent(u.pathname.replace(/^\//, '')) || null;
    } catch {
      connDb = null;
    }
  } else if (connDb && /dbname=/.test(connDb)) {
    host = /host=(\S+)/.exec(connDb)?.[1] ?? host;
    connDb = /dbname=(\S+)/.exec(connDb)?.[1] ?? null;
  }
  const badDrops = dropDbs.filter((n) => !isThrowawayDatabase(n));
  if (badDrops.length) ask(out, `destructive SQL: DROP DATABASE ${badDrops.join(', ')} (not a throwaway database: bananagig_t_*, *_review, *_test)`);
  if (hasOther && !(connDb && isThrowawayDatabase(connDb))) {
    ask(
      out,
      `destructive SQL (DROP SCHEMA/TABLE or TRUNCATE) against ${connDb ? `"${connDb}"` : 'an unknown database'}, which is not a throwaway database (bananagig_t_*, *_review, *_test)`,
    );
  }
  if (!isLocalHost(host)) ask(out, `destructive SQL against a non-local host (${host}); the throwaway-database exception only applies to a local database`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Targets: shell writes, deletes, moves and reads of protected files
// ---------------------------------------------------------------------------------------------------------------------

function repoRel(real, ctx) {
  const top = ctx.top;
  if (!top) return null;
  const rel = toPosix(path.relative(top, real));
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : rel;
}

/**
 * Check one path word that a command writes (kind: write | dest | delete | move | read). opts: { recursive, bootstrap }.
 * Applies the secrets-file, applied-migration, gate-file and test-file rules to the real (symlink-resolved) path.
 */
function checkTarget(word, kind, ctx, out, opts = {}) {
  checkBudget();
  if (!word || word === '/dev/null' || /^\/dev\//.test(word)) return;
  const rawName = base(String(word).replace(/\/+$/, ''));
  const res = resolvePaths(word, ctx);
  if (isEnvName(rawName) || isEnvName(rawName.replace(/^.*=/, ''))) {
    if (kind === 'write' || kind === 'dest') {
      if (opts.bootstrap)
        ask(out, `${rawName} is created from its .example file (the documented first-run bootstrap): approve once; real secrets are filled in by the user`);
      else deny(out, `shell write to ${rawName} (secrets files are never written by the agent)`);
    } else if (kind === 'delete' || kind === 'move') ask(out, `removing or moving ${rawName} deletes local secrets that cannot be recovered from git`);
  }
  if (res.unresolved) {
    if (/migrations/i.test(word)) ask(out, `cannot resolve "${word}" to check it against applied migrations`);
    return;
  }
  for (const real of res.paths) {
    const name = path.basename(real);
    if (isEnvName(name) && !isEnvName(rawName)) {
      if (kind === 'write' || kind === 'dest') deny(out, `shell write to ${name} through "${word}" (secrets files are never written by the agent)`);
      else if (kind === 'delete' || kind === 'move') ask(out, `removing or moving ${name} deletes local secrets`);
    }
    const rel = repoRel(real, ctx);
    if (rx(/(^|\/)db\/migrations(\/|$)/).test(toPosix(real))) {
      const r = classifyMigrationWrite(real);
      if (r && r.level)
        out.push({
          level: r.level,
          message: `shell write to a migration: ${r.message}`,
        });
      if (opts.recursive && rel !== null && isMigrationsDirOrAncestor(rel)) deny(out, 'recursive removal or move of the migrations directory');
    } else if (opts.recursive && rel !== null && isMigrationsDirOrAncestor(rel) && (kind === 'delete' || kind === 'move')) {
      deny(out, `recursive removal or move of ${rel || 'the repository root'} would destroy the migrations`);
    }
    if (rel !== null && isGateFile(rel))
      ask(out, `shell write to ${rel}, a quality-gate / CI / tooling / Claude-configuration file (use the edit tools so the guard can review it)`);
    else if (rel !== null && kind === 'write' && isTestFile(rel))
      ask(out, `shell edit of the test file ${rel} bypasses the disabled-test check (use the edit tools)`);
  }
}

const isDirectoryWord = (word, ctx) => {
  if (/\/$/.test(word)) return true;
  const abs = resolveWord(word, ctx);
  try {
    return abs !== null && statSync(abs).isDirectory();
  } catch {
    return false;
  }
};

/** cp / mv / install / ln / rsync: destination is the last operand or -t DIR; a directory destination receives each source basename. */
function copyLike(info, ctx, out, { moving = false, linking = false } = {}) {
  const letters = info.cmd === 'rsync' ? 'e' : info.cmd === 'install' ? 'tSmgo' : 'tS';
  const f = scanFlags(info.args, {
    valueShortNext: letters,
    valueLong: ['target-directory', 'suffix', 'exclude', 'include', 'rsh', 'backup'],
  });
  let dest = null;
  let sources = f.all;
  const t = f.long.get('target-directory') ?? (info.args.includes('-t') ? info.args[info.args.indexOf('-t') + 1] : null);
  if (t) dest = t;
  else if (f.all.length) {
    dest = f.all[f.all.length - 1];
    sources = f.all.slice(0, -1);
  }
  if (!dest) return;
  const destIsDir = Boolean(t) || isDirectoryWord(dest, ctx);
  const bootstrap = info.cmd === 'cp' && sources.length === 1 && isEnvName(base(dest)) && base(sources[0]) === `${base(dest)}.example`;
  for (const s of sources) {
    if (isEnvName(base(s)) && !linking) ask(out, `${info.cmd} reads ${base(s)} (local secrets); needs explicit approval`);
    if (moving) checkTarget(s, 'move', ctx, out, { recursive: true });
    if (destIsDir) {
      const resolvedDest = resolveWord(dest, ctx);
      if (resolvedDest === null || hasGlob(s) || hasPlaceholder(s)) {
        if (/migrations/i.test(dest)) ask(out, `cannot tell which file lands in ${dest}`);
      } else checkTarget(path.join(dest, base(s)), 'dest', ctx, out);
    }
  }
  if (!destIsDir) checkTarget(dest, 'dest', ctx, out, { bootstrap });
  else checkTarget(dest, 'dest', ctx, out); // the directory itself (env-named directory, gate directory, ...)
}

/** Files named by a patch (unified diff / git diff): `+++ b/path` and `diff --git a/x b/path`, with -p strip applied. */
function patchTargets(text, strip) {
  const files = new Set();
  const stripPath = (p) => p.split('/').slice(strip).join('/');
  for (const line of text.split('\n')) {
    const m = /^\+\+\+ (\S+)/.exec(line) || /^--- (\S+)/.exec(line) || /^diff --git \S+ (\S+)/.exec(line);
    if (m && m[1] !== '/dev/null') files.add(stripPath(m[1]));
  }
  return [...files];
}

function patchRules(info, seg, ctx, out) {
  const isGit = info.cmd === 'git';
  const args = isGit ? gitSub(info).rest : info.args;
  const f = scanFlags(args, {
    valueShortNext: 'piRdoDFVzB',
    valueLong: ['input', 'strip', 'directory', 'whitespace', 'exclude', 'include'],
  });
  if (isGit && ['check', 'stat', 'numstat', 'summary'].some((n) => f.long.has(n))) return;
  const stripArg = args.find((a) => /^-p\d+$/.test(a));
  const strip = stripArg ? Number(stripArg.slice(2)) : isGit ? 1 : 0;
  const patchWords = [];
  let explicit = null;
  if (isGit) patchWords.push(...f.positional);
  else {
    explicit = f.positional[0] ?? null;
    if (f.positional[1]) patchWords.push(f.positional[1]);
    const i = args.indexOf('-i');
    if (i >= 0 && args[i + 1]) patchWords.push(args[i + 1]);
    if (f.long.get('input')) patchWords.push(f.long.get('input'));
  }
  for (const r of seg.redirects) if (r.op === '<') patchWords.push(r.target);
  const texts = patchWords.map((p) => readFileText(p, ctx));
  texts.push(...seg.heredocs, ...seg.redirects.filter((r) => r.op === '<<<').map((r) => r.target));
  if (explicit) {
    checkTarget(explicit, 'write', ctx, out);
    return;
  }
  if (!texts.length || texts.some((t) => t === null)) {
    ask(out, `${isGit ? 'git apply' : 'patch'} changes files named inside a patch this guard cannot read (it may touch migrations, secrets or gate files)`);
    return;
  }
  for (const t of texts) for (const file of patchTargets(t, strip)) checkTarget(file, 'write', ctx, out);
}

function envNamingArgs(info, seg, ctx) {
  const { cmd, args } = info;
  let skipPattern = PATTERN_FIRST_COMMANDS.has(cmd) && !args.some((a) => /^(?:-e|-f|--regexp|--file|--expression)/.test(a));
  const hits = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (/^--env-file/.test(a) || /^--env-file(?:-if-exists)?$/.test(args[i - 1] ?? '')) continue;
    if (a.startsWith('-') && !a.includes('=') && !a.includes('/')) continue;
    if (skipPattern) {
      skipPattern = false;
      if (!a.startsWith('-')) continue;
    }
    const candidates = [a, a.replace(/^@/, ''), a.slice(a.lastIndexOf('=') + 1), a.slice(a.lastIndexOf(':') + 1)];
    let hit = candidates.some((c) => isEnvName(base(c.replace(/\/+$/, ''))));
    if (!hit) {
      hit = candidates.some((c) => {
        const b = base(c);
        return hasGlob(b) && b.startsWith('.') && (globCouldMatch(b, '.env') || globCouldMatch(b, '.env.host'));
      });
    }
    if (!hit && seg && hasPlaceholder(a)) {
      const list = placeholderList(seg, a);
      const lit = list ? literalScriptOf(list, ctx) : null;
      hit = lit !== null && lit.split(/\s+/).some((w) => isEnvName(base(w)));
    }
    if (!hit && !hasGlob(a) && !/[\s$`]/.test(a) && a.length < 512) {
      hit = candidates.some((c) => {
        if (!c || /[\s$`*?[]/.test(c)) return false;
        try {
          const abs = resolveWord(c, ctx);
          return abs !== null && isEnvName(path.basename(realpathLoose(abs)));
        } catch {
          return false;
        }
      });
    }
    if (hit) hits.push(a);
  }
  return hits;
}
function redirectReadRules(seg, ctx, out) {
  for (const r of seg.redirects) {
    if (r.op === '<' && (isEnvName(base(r.target)) || resolvedIsEnv(r.target, ctx)))
      ask(out, `reads ${base(r.target)} (local secrets) through input redirection`);
  }
}

function envReadRules(seg, info, ctx, out) {
  const { cmd } = info;
  if (!cmd || SAFE_WITH_ENV_ARG.has(cmd)) return;
  if (cmd === 'git' && SAFE_GIT_SUBS_WITH_ENV_ARG.has(gitSub(info).sub)) return;
  if (['cp', 'mv', 'rm', 'ln', 'install', 'tee', 'dd', 'truncate', 'rsync'].includes(cmd)) return; // handled with their destinations
  const hits = envNamingArgs(info, seg, ctx);
  if (hits.length) ask(out, `${cmd} reads or handles ${base(hits[0])} (local secrets, matched by name, glob or symlink); needs explicit approval`);
  if (INTERPRETERS.has(cmd)) {
    const text = inlineScript(info.args);
    if (text !== null) {
      if (rx(/(?<![\w.])\.env(?:\.host)?(?![\w-]|\.\w)/).test(text)) ask(out, `${cmd} script mentions .env / .env.host (local secrets)`);
      if (rx(/db\/migrations/).test(text)) ask(out, `${cmd} script mentions db/migrations (applied migrations are immutable)`);
      if (/(?:^|[\s'"/])\.(?:claude|github)\//.test(text)) ask(out, `${cmd} script mentions .claude/ or .github/ (guard and CI configuration)`);
    }
  }
}

/** The inline program of \`node -e '...'\` / \`python -c '...'\` / \`perl -pe '...'\`, or null when the interpreter runs a script file. */
function inlineScript(args) {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('-')) return null; // a script file (or module) comes first: not an inline program
    if (/^(?:-e|-p|-pe|-E|-c|--eval|--print|-r)$/.test(a) || /^-[a-zA-Z]*[ecp]$/.test(a)) return args.slice(i + 1).join('\n');
  }
  return null;
}

function resolvedIsEnv(word, ctx) {
  const abs = resolveWord(word, ctx);
  return abs !== null && !hasGlob(abs) && isEnvName(path.basename(realpathLoose(abs)));
}

// ---------------------------------------------------------------------------------------------------------------------
// One simple command
// ---------------------------------------------------------------------------------------------------------------------

function evalSegment(seg, info, ctx, out, depth) {
  checkBudget();
  ctx.seg = seg;
  // --- redirections ---
  for (const r of seg.redirects) {
    if ((r.op === '>&' || r.op === '<&') && /^(?:\d+|-)$/.test(r.target)) continue;
    if (WRITE_REDIRECTS.has(r.op)) checkTarget(r.target, 'write', ctx, out);
  }
  redirectReadRules(seg, ctx, out);
  // --- nested scripts: bash -c '...', eval, here-documents / here-strings / files fed to a shell ---
  const scripts = info.scripts.map((s) => scriptText(seg, s, ctx));
  if (SHELLS.has(info.cmd) && info.shellStdin) {
    scripts.push(...seg.heredocs);
    scripts.push(...seg.redirects.filter((r) => r.op === '<<<').map((r) => r.target));
    for (const r of seg.redirects.filter((x) => x.op === '<')) {
      const t = readFileText(r.target, ctx);
      if (t === null) ask(out, `${info.cmd} reads a script from ${r.target} that this guard cannot read`);
      else scripts.push(t);
    }
  }
  for (const s of scripts) evalScript(s, ctx, out, depth);
  const runsFile = SHELLS.has(info.cmd) || ['eval', 'source', '.'].includes(info.cmd);
  if (runsFile && substCommands(seg).some((n) => FETCHERS.includes(n)))
    deny(out, 'executes downloaded content (shell/eval/source of a curl or wget substitution)');
  // bash <(echo '...') / source <(...): the process substitution is the script
  if ((info.cmd === 'source' || info.cmd === '.' || (SHELLS.has(info.cmd) && info.shellStdin)) && !info.scripts.length) {
    for (const w of info.args.filter((a) => /^<\(\.\.\.#\d+\)$/.test(a))) {
      const list = placeholderList(seg, w);
      const lit = list ? literalScriptOf(list, ctx) : null;
      if (lit === null) {
        if (!(list && list.some((s) => FETCHERS.includes(commandInfo(s).cmd))))
          ask(out, `${info.cmd} runs a process substitution whose text this guard cannot see`);
      } else evalScript(lit, ctx, out, depth);
    }
  }
  if (!info.cmd) return;

  envReadRules(seg, info, ctx, out);
  writeRules(seg, info, ctx, out);
  const { cmd, args } = info;
  switch (cmd) {
    case 'git':
      gitRules(info, seg, ctx, out, depth);
      break;
    case 'rm':
      rmRules(args, ctx, out);
      break;
    case 'chmod': {
      const f = scanFlags(args);
      const recursive = f.short.has('R') || f.long.has('recursive');
      const mode = f.positional.find((a) => /^(?:[0-7]?777|[ugoa]*[+=]rwx)$/.test(a));
      if (recursive && mode) deny(out, `chmod -R ${mode} (world-writable recursive permissions)`);
      break;
    }
    case 'docker':
    case 'docker-compose':
    case 'podman':
    case 'kubectl':
    case 'oc':
      if (cmd === 'docker' || cmd === 'docker-compose' || cmd === 'podman') dockerRules(info, out);
      // `docker exec c sh -c '...'` / `kubectl exec p -- sh -c '...'`: evaluate the inner shell script too.
      for (let k = 0; k < args.length; k += 1) {
        if (!SHELLS.has(base(args[k]))) continue;
        for (const s of commandInfo({ words: args.slice(k) }).scripts) evalScript(s, ctx, out, depth);
        break;
      }
      if (cmd === 'kubectl' || cmd === 'oc') kubectlRules(args, out);
      break;
    case 'pnpm':
    case 'npm':
    case 'yarn':
    case 'bun':
      pkgRules(info, out);
      break;
    case 'gh':
      ghRules(args, out);
      break;
    case 'curl':
    case 'wget':
      httpRules(info, out);
      break;
    case 'helm': {
      const f = scanFlags(args, {
        valueShortNext: 'n',
        valueLong: ['namespace', 'kube-context', 'kubeconfig'],
      });
      if (['install', 'upgrade', 'uninstall', 'rollback', 'delete'].includes(f.positional[0]))
        ask(out, `helm ${f.positional[0]} changes cluster state (deploy/release action)`);
      break;
    }
    case 'terraform':
    case 'tofu': {
      const f = scanFlags(args.filter((a) => !a.startsWith('-chdir=')));
      if (['apply', 'destroy', 'import'].includes(f.positional[0])) ask(out, `${cmd} ${f.positional[0]} changes infrastructure (deploy/release action)`);
      break;
    }
    case 'fly':
    case 'flyctl': {
      const f = scanFlags(args);
      if (['deploy', 'launch', 'destroy', 'scale', 'secrets'].includes(f.positional[0])) ask(out, `${cmd} ${f.positional[0]} (deploy/release action)`);
      break;
    }
    case 'vercel':
    case 'netlify':
    case 'wrangler': {
      const f = scanFlags(args);
      if (
        f.long.has('prod') ||
        f.long.has('production') ||
        ['promote', 'rollback', 'remove', 'rm'].includes(f.positional[0]) ||
        (cmd === 'wrangler' && ['deploy', 'publish'].includes(f.positional[0]))
      ) {
        ask(out, `${cmd} production deploy/release action`);
      }
      break;
    }
    case 'find':
      findRules(info, seg, ctx, out, depth);
      break;
    case 'patch':
      patchRules(info, seg, ctx, out);
      break;
    default:
      break;
  }
}

function writeRules(seg, info, ctx, out) {
  const { cmd, args } = info;
  switch (cmd) {
    case 'tee':
      for (const a of args) if (!a.startsWith('-')) checkTarget(a, 'write', ctx, out);
      break;
    case 'sed':
    case 'perl':
    case 'ruby':
    case 'awk':
    case 'gawk':
      if (args.some((a) => isInPlaceFlag(cmd, a))) for (const a of args) if (a && !a.startsWith('-')) checkTarget(a, 'write', ctx, out);
      break;
    case 'ed':
    case 'ex':
      for (const a of args) if (a && !a.startsWith('-')) checkTarget(a, 'write', ctx, out);
      break;
    case 'cp':
    case 'install':
      copyLike(info, ctx, out);
      break;
    case 'mv':
      copyLike(info, ctx, out, { moving: true });
      break;
    case 'ln':
      copyLike(info, ctx, out, { linking: true });
      break;
    case 'rsync':
      copyLike(info, ctx, out);
      break;
    case 'truncate': {
      const f = scanFlags(args, {
        valueShortNext: 'sr',
        valueLong: ['size', 'reference'],
      });
      for (const a of f.all) checkTarget(a, 'write', ctx, out);
      break;
    }
    case 'dd':
      for (const a of args) if (a.startsWith('of=')) checkTarget(a.slice(3), 'write', ctx, out);
      break;
    case 'unlink':
    case 'shred':
    case 'rmdir':
      for (const a of args) if (!a.startsWith('-')) checkTarget(a, 'delete', ctx, out);
      break;
    default:
      break;
  }
  void seg;
}

function findRules(info, seg, ctx, out, depth) {
  const { args } = info;
  const exprStart = args.findIndex((a) => a.startsWith('-') || a === '(' || a === '!');
  const roots = args.slice(0, exprStart < 0 ? args.length : exprStart);
  const patterns = [];
  for (let i = 0; i < args.length; i += 1)
    if (['-name', '-iname', '-path', '-ipath', '-wholename'].includes(args[i]) && args[i + 1]) patterns.push(args[i + 1]);
  for (let i = 0; i < args.length; i += 1) {
    if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[i])) continue;
    let j = i + 1;
    const inner = [];
    while (j < args.length && args[j] !== ';' && args[j] !== '+') {
      inner.push(args[j]);
      j += 1;
    }
    if (!inner.length) continue;
    const pseudo = {
      words: inner,
      redirects: [],
      heredocs: [],
      subst: [],
      subs: seg.subs,
      op: '',
      dynamic: false,
      background: false,
    };
    const innerInfo = commandInfo(pseudo);
    evalSegment(pseudo, innerInfo, ctx, out, depth + 1);
    ctx.seg = seg;
    if (isWriterCommand(innerInfo)) {
      const couldMatchSql = !patterns.length || patterns.some((p) => globCouldMatch(p, '0001_x.sql') || globCouldMatch(p, 'x.sql'));
      const touchesRepo = (roots.length ? roots : ['.']).some((r) => {
        const abs = resolveWord(r, ctx);
        if (abs === null) return true;
        const rel = repoRel(realpathLoose(abs), ctx);
        return rel !== null && isMigrationsDirOrAncestor(rel);
      });
      if (couldMatchSql && touchesRepo) ask(out, `find -exec runs a file-writing command (${innerInfo.cmd}) over a tree that includes db/migrations`);
    }
    i = j;
  }
}

// ---- git ------------------------------------------------------------------------------------------------------------

const GIT_GLOBAL_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path']);

function gitSub(info) {
  const a = info.args;
  const globals = { hooksPath: false, aliases: {} };
  let i = 0;
  for (; i < a.length; i += 1) {
    const x = a[i];
    if (!x.startsWith('-')) break;
    if (x === '-c' && a[i + 1] !== undefined) {
      const kv = a[i + 1];
      if (/^core\.hookspath(=|$)/i.test(kv)) globals.hooksPath = true;
      const al = /^alias\.([^=]+)=(.*)$/i.exec(kv);
      if (al) globals.aliases[al[1]] = al[2];
      i += 1;
    } else if (x.startsWith('--config-env=')) {
      if (/^--config-env=core\.hookspath=/i.test(x)) globals.hooksPath = true;
    } else if (x === '--config-env' && a[i + 1] !== undefined) {
      if (/^core\.hookspath=/i.test(a[i + 1])) globals.hooksPath = true;
      i += 1;
    } else if (/^-ccore\.hookspath/i.test(x)) globals.hooksPath = true;
    else if (GIT_GLOBAL_VALUE.has(x) && !x.includes('=')) i += 1;
  }
  let sub = a[i];
  let rest = a.slice(i + 1);
  let aliasScript = null;
  if (sub !== undefined && globals.aliases[sub] !== undefined) {
    const value = globals.aliases[sub];
    if (value.startsWith('!')) aliasScript = value.slice(1);
    else {
      const parts = value.split(/\s+/).filter(Boolean);
      sub = parts[0];
      rest = [...parts.slice(1), ...rest];
    }
  }
  return { sub, rest, globals, aliasScript };
}

function gitConfigBypass(env) {
  return Object.entries(env).some(
    ([k, v]) => (/^GIT_CONFIG_KEY_\d+$/.test(k) && /^core\.hookspath$/i.test(v)) || (k === 'GIT_CONFIG_PARAMETERS' && /core\.hookspath/i.test(v)),
  );
}

function gitRules(info, seg, ctx, out, depth) {
  const { sub, rest, globals, aliasScript } = gitSub(info);
  if (globals.hooksPath || gitConfigBypass(info.env))
    deny(out, 'git hook bypass: core.hooksPath set through -c / --config-env / GIT_CONFIG_* disables the repository hooks');
  if (aliasScript) evalScript(aliasScript, ctx, out, depth);
  if (!sub) return;
  if (info.env.HUSKY === '0' && ['commit', 'push'].includes(sub)) deny(out, `HUSKY=0 git ${sub} skips the git hooks`);
  const canon = GUARDED_GIT_SUBCOMMANDS.has(sub) ? (n) => canonicalGitOption(sub, n) : null;
  const scan = (opts) => {
    const f = scanFlags(rest, { ...opts, canon });
    if (f.unknown.length)
      ask(
        out,
        `git ${sub}: unrecognised or ambiguous option ${f.unknown.join(', ')} (abbreviations are resolved against the real option list; spell the option out)`,
      );
    return f;
  };
  const hookBypass = (f) => f.long.has('no-verify');
  switch (sub) {
    case 'push': {
      const f = scan({
        valueShortNext: 'o',
        valueLong: ['repo', 'push-option', 'receive-pack', 'exec'],
      });
      const forced = ['force', 'force-with-lease', 'force-if-includes'].some((n) => f.long.has(n)) || f.short.has('f');
      const deleting = f.long.has('delete') || f.short.has('d');
      if (forced) deny(out, 'git push --force / -f / --force-with-lease rewrites remote history');
      if (deleting) deny(out, 'git push --delete removes remote refs');
      if (f.long.has('mirror') || f.long.has('prune')) deny(out, 'git push --mirror/--prune can delete remote refs');
      if (hookBypass(f)) deny(out, 'git push --no-verify skips the pre-push hooks');
      if (f.all.some((x) => x.startsWith('+') || x.startsWith(':'))) deny(out, 'git push with a +refspec (forced) or :refspec (delete)');
      if (!(f.long.has('dry-run') || f.short.has('n'))) ask(out, 'git push publishes commits; the user must approve it');
      break;
    }
    case 'send-pack': {
      const f = scanFlags(rest);
      if (f.long.has('force') || f.short.has('f')) ask(out, 'git send-pack --force rewrites remote history');
      break;
    }
    case 'commit': {
      const f = scan({
        valueShortNext: 'mFCct',
        attachedShort: 'uS',
        valueLong: ['message', 'file', 'author', 'date', 'reuse-message', 'reedit-message', 'template', 'cleanup', 'fixup', 'squash', 'trailer'],
      });
      if (hookBypass(f) || f.short.has('n')) deny(out, 'git commit --no-verify / -n skips the commit hooks');
      if (f.long.has('amend')) ask(out, 'git commit --amend rewrites history');
      break;
    }
    case 'merge':
    case 'am':
    case 'cherry-pick': {
      const f = scan({
        valueShortNext: sub === 'merge' ? 'mXsF' : sub === 'cherry-pick' ? 'mXs' : '',
      });
      if (hookBypass(f)) deny(out, `git ${sub} --no-verify skips hooks`);
      if (sub === 'am') patchFromAm(rest, seg, ctx, out);
      break;
    }
    case 'rebase': {
      const f = scan({
        valueShortNext: 'sXx',
        valueLong: ['onto', 'exec', 'strategy', 'strategy-option'],
      });
      if (hookBypass(f)) deny(out, 'git rebase --no-verify skips hooks');
      ask(out, 'git rebase rewrites history');
      break;
    }
    case 'reset': {
      const f = scan({});
      if (f.long.has('hard')) deny(out, 'git reset --hard discards uncommitted work');
      break;
    }
    case 'clean': {
      const f = scan({ valueShortNext: 'e', valueLong: ['exclude'] });
      if (f.short.has('f') || f.long.has('force')) deny(out, 'git clean -f deletes untracked files');
      break;
    }
    case 'checkout':
    case 'switch': {
      const f = scan({
        valueShortNext: 'bBcC',
        valueLong: ['branch', 'orphan', 'conflict'],
      });
      if (sub === 'checkout' && f.all.some((x) => WHOLE_TREE.has(x))) deny(out, 'git checkout of the whole tree (. / :/) discards uncommitted work');
      if (f.short.has('f') || f.long.has('force') || f.long.has('discard-changes')) ask(out, `git ${sub} --force discards local changes`);
      if (sub === 'checkout' && f.afterDD.length && f.positional[0] && f.positional[0] !== 'HEAD') for (const p of f.afterDD) checkTarget(p, 'write', ctx, out);
      break;
    }
    case 'restore': {
      const f = scan({ valueShortNext: 's', valueLong: ['source'] });
      const stagedOnly = (f.long.has('staged') || f.short.has('S')) && !(f.long.has('worktree') || f.short.has('W'));
      if (!stagedOnly && f.all.some((x) => WHOLE_TREE.has(x))) deny(out, 'git restore of the whole tree (. / :/) discards uncommitted work');
      if (f.long.has('source') || rest.some((a) => /^-s./.test(a) || a === '-s')) for (const p of f.all) checkTarget(p, 'write', ctx, out);
      break;
    }
    case 'branch': {
      const f = scan({
        valueShortNext: 'uqt',
        valueLong: ['set-upstream-to', 'contains', 'merged', 'no-merged', 'points-at', 'sort', 'format'],
      });
      if (f.short.has('D') || (f.long.has('delete') && (f.short.has('f') || f.long.has('force')))) ask(out, 'git branch -D force-deletes a branch');
      else if ((f.short.has('f') || f.long.has('force')) && !f.long.has('delete') && !f.short.has('d'))
        ask(out, 'git branch -f moves an existing branch to another commit');
      break;
    }
    case 'add': {
      const f = scan({ valueLong: ['chmod', 'pathspec-from-file'] });
      if ((f.short.has('f') || f.long.has('force')) && envNamingArgs({ cmd: 'git', args: f.all }, seg, ctx).length)
        deny(out, 'git add --force of .env / .env.host would commit local secrets');
      break;
    }
    case 'config': {
      const f = scanFlags(rest, {
        valueLong: ['file', 'blob', 'type'],
        valueShortNext: 'f',
      });
      const readOnly =
        ['get', 'get-all', 'get-regexp', 'list', 'get-urlmatch', 'get-color', 'get-colorbool'].some((n) => f.long.has(n)) ||
        f.short.has('l') ||
        (f.positional.length <= 1 &&
          !['unset', 'unset-all', 'add', 'replace-all', 'edit', 'rename-section', 'remove-section'].some((n) => f.long.has(n)) &&
          !f.short.has('e'));
      if ((f.long.has('global') || f.long.has('system')) && !readOnly) deny(out, 'git config --global/--system changes user-wide git configuration');
      else if (!readOnly && /^core\.hookspath$/i.test(f.positional[0] ?? '')) ask(out, 'changing core.hooksPath can disable the repository hooks');
      break;
    }
    case 'filter-branch':
    case 'filter-repo':
      ask(out, `git ${sub} rewrites history`);
      break;
    case 'update-ref':
      if (rest.includes('-d') || rest.includes('--delete')) ask(out, 'git update-ref -d deletes a ref');
      break;
    case 'reflog':
      if (['expire', 'delete'].includes(rest[0])) ask(out, `git reflog ${rest[0]} removes recovery points`);
      break;
    case 'rm': {
      const f = scanFlags(rest);
      for (const a of f.all) checkTarget(a, 'delete', ctx, out, { recursive: f.short.has('r') });
      break;
    }
    case 'mv': {
      const f = scanFlags(rest);
      for (const a of f.all) checkTarget(a, 'move', ctx, out);
      break;
    }
    case 'apply':
      patchRules(info, seg, ctx, out);
      break;
    default:
      break;
  }
}

function patchFromAm(rest, seg, ctx, out) {
  const f = scanFlags(rest);
  const texts = f.positional.map((p) => readFileText(p, ctx));
  if (!texts.length || texts.some((t) => t === null)) return; // mailbox on stdin / unreadable: the commit hooks and CI still apply
  for (const t of texts) for (const file of patchTargets(t, 1)) checkTarget(file, 'write', ctx, out);
  void seg;
}

// ---- rm / docker / package managers / gh / http --------------------------------------------------------------------

function rmRules(args, ctx, out) {
  const f = scanFlags(args);
  if (f.long.has('no-preserve-root')) deny(out, 'rm --no-preserve-root');
  const recursive = f.short.has('r') || f.short.has('R') || f.long.has('recursive');
  for (const t of f.all) {
    if (isGitDirWord(t)) deny(out, `removing ${t} (the git repository itself)`);
    else if (recursive) {
      const p = rmTargetProblem(t, ctx);
      if (p) out.push(p);
    }
    checkTarget(t, 'delete', ctx, out, { recursive });
  }
}

function dockerRules(info, out) {
  const { cmd, args } = info;
  const f = scanFlags(args, {
    valueLong: ['profile', 'project-name', 'file', 'env-file', 'context', 'host', 'project-directory'],
    valueShortNext: 'fpH',
  });
  const pos = f.positional;
  const isCompose = cmd === 'docker-compose' || pos[0] === 'compose';
  const rest = isCompose && pos[0] === 'compose' ? pos.slice(1) : pos;
  if (isCompose && rest[0] === 'down') {
    const after = args.slice(args.indexOf('down') + 1);
    const df = scanFlags(after, {
      valueShortNext: 't',
      valueLong: ['timeout', 'rmi'],
    });
    if (df.short.has('v') || df.long.has('volumes')) ask(out, 'docker compose down -v/--volumes deletes the local database volumes');
  }
  if (rest[0] === 'volume' && ['rm', 'remove', 'prune'].includes(rest[1])) ask(out, `docker volume ${rest[1]} deletes data volumes`);
  if (pos[0] === 'system' && pos[1] === 'prune') ask(out, 'docker system prune deletes containers, networks and images');
  if (
    (pos[0] === 'rm' || (pos[0] === 'container' && pos[1] === 'rm') || (isCompose && rest[0] === 'rm')) &&
    (args.some((a) => /^-[a-zA-Z]*v[a-zA-Z]*$/.test(a)) || args.includes('--volumes'))
  ) {
    ask(out, 'docker rm -v / compose rm -v deletes the container volumes');
  }
  if (pos[0] === 'push' || (pos[0] === 'image' && pos[1] === 'push') || (isCompose && rest[0] === 'push'))
    ask(out, 'docker push publishes an image (release action)');
  if ((pos.includes('buildx') || pos.includes('build')) && f.long.has('push')) ask(out, 'docker build --push publishes an image (release action)');
}

function kubectlRules(args, out) {
  const f = scanFlags(args, {
    valueShortNext: 'nsc',
    valueLong: ['namespace', 'context', 'cluster', 'kubeconfig', 'user'],
  });
  if (['apply', 'delete', 'replace', 'patch', 'rollout', 'scale', 'create'].includes(f.positional[0]))
    ask(out, `kubectl ${f.positional[0]} changes cluster state (deploy/release action)`);
}

function pkgRules(info, out) {
  const { cmd, args } = info;
  if (cmd === 'bun') return;
  const t = pkgScript(cmd, args);
  const target = t.target;
  if (!target) return;
  if (target === 'stack:reset') ask(out, 'pnpm stack:reset runs "docker compose down -v" and deletes the local database volumes');
  if (['publish', 'unpublish', 'deprecate'].includes(target) && t.kind === 'direct') ask(out, `${cmd} ${target} publishes to the registry (release action)`);
  if (/^(?:deploy|release|publish)(?::|$)/.test(target) && t.kind !== 'direct') ask(out, `${cmd} run ${target} looks like a deploy/release script`);
  if (/^(?:release|deploy:)/.test(target) && t.kind === 'direct') ask(out, `${cmd} ${target} looks like a deploy/release script`);
}

function ghRules(args, out) {
  const f = scanFlags(args, {
    valueShortNext: 'R',
    valueLong: ['repo', 'hostname'],
  });
  const [a, b] = f.positional;
  if (a === 'pr' && b === 'merge') ask(out, 'gh pr merge merges to the protected branch (release action)');
  if (a === 'release' && !['list', 'view', 'download'].includes(b)) ask(out, `gh release ${b ?? ''} (release action)`);
  if (a === 'repo' && ['delete', 'archive', 'edit', 'rename'].includes(b)) ask(out, `gh repo ${b} changes the repository`);
  if (a === 'workflow' && b === 'run') ask(out, 'gh workflow run starts a workflow (possible deploy)');
  if ((a === 'secret' && !['list'].includes(b)) || (a === 'variable' && ['set', 'delete'].includes(b)))
    ask(out, `gh ${a} changes repository secrets/variables`);
  if (a === 'api') {
    const method = String(f.long.get('method') ?? '').toUpperCase();
    const x = args.findIndex((v) => v === '-X');
    const m2 = x >= 0 ? String(args[x + 1] ?? '').toUpperCase() : '';
    const writes =
      (method && method !== 'GET') ||
      (m2 && m2 !== 'GET') ||
      f.long.has('field') ||
      f.long.has('raw-field') ||
      f.long.has('input') ||
      f.short.has('f') ||
      f.short.has('F');
    if (writes) ask(out, 'gh api with a non-GET method or request fields changes remote GitHub state (rulesets, branch protection, secrets, ...)');
  }
}

function httpRules(info, out) {
  const { args } = info;
  const xi = args.findIndex((a) => a === '-X' || a === '--request');
  const method = String((xi >= 0 ? args[xi + 1] : (args.find((a) => a.startsWith('--method='))?.slice(9) ?? '')) ?? '').toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return;
  if (args.some((a) => /api\.github\.com|github\.com\/.+\/(?:merge|rulesets|releases)|\/merge(?:\?|$)/i.test(a)))
    ask(out, `${info.cmd} -X ${method} against the GitHub API / a merge endpoint changes remote state`);
}

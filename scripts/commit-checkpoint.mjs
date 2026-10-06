// pnpm checkpoint:commit <CHECKPOINT_ID> "<type>(<ID>): <description>" [--dry-run] [--include <path>]... [--trailer "<text>"]...
// Creates ONE checkpoint commit from a verified working tree. Never pushes, amends, rewrites history or force-anything.
import { readFileSync, statSync } from 'node:fs';
import { git, isGitRepo, p, parseArgs, read, exists, status, treeFingerprint } from './lib/governance.mjs';

const { positional, flags, flag } = parseArgs(process.argv.slice(2));
const [id, message] = positional;
const dry = !!flag('dry-run');
const die = (m, extra = []) => {
  console.error(`checkpoint:commit REFUSED: ${m}`);
  for (const e of extra) console.error(`  ${e}`);
  process.exit(1);
};
if (!id || !message) die('usage: pnpm checkpoint:commit <CHECKPOINT_ID> "<type>(<ID>): <description>"');
if (!isGitRepo()) die('not a git repository');
if (!new RegExp(`^(feat|fix|chore|docs|refactor|test|perf|build|ci)\\(${id}\\): \\S.{3,}`).test(message))
  die(`message must follow "<type>(${id}): <description>" (types: feat, fix, chore, docs, refactor, test, perf, build, ci)`);

// 1. a clean finalization result that still describes this exact tree
if (!exists(`.checkpoint/${id}.finalize.json`)) die(`no finalization result. Run: pnpm checkpoint:finalize ${id} --skill-update=UPDATED|NOT_REQUIRED`);
const fin = JSON.parse(read(`.checkpoint/${id}.finalize.json`));
if (!fin.passed)
  die(
    'the last finalization FAILED. Fix the failures and re-run checkpoint:finalize',
    fin.steps.filter((s) => !s.ok).map((s) => `failed: ${s.name}`),
  );
if (fin.fingerprint !== treeFingerprint())
  die('files changed after finalization (stale validation). Re-run checkpoint:finalize', [
    'Anything modified after the checks ran is unvalidated and may be unrelated to the checkpoint.',
  ]);
const head = git(['rev-parse', '-q', '--verify', 'HEAD'], { allowFail: true })?.trim() ?? null;
if (fin.headAtFinalize !== head) die('HEAD moved since finalization. Re-run checkpoint:finalize');

// 2. what would be committed
const entries = status();
if (!entries.length) die('nothing to commit');
const files = entries.map((e) => e.file);
const includes = new Set((flags.include ?? []).filter((x) => typeof x === 'string'));
const FORBIDDEN = [
  /(^|\/)\.env($|\.(?!example$|host\.example$))/,
  /(^|\/)node_modules\//,
  /(^|\/)(dist|\.next|\.turbo|\.checkpoint)\//,
  /\.(pem|key|p12|pfx)$/,
  /(^|\/)id_(rsa|ed25519)/,
  /\.log$/,
];
const ROOTS = /^(apps|packages|docs|skills|scripts|infra|db|\.github)\//;
const ROOT_FILES =
  /^(CLAUDE\.md|AGENTS\.md|README\.md|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|tsconfig[\w.]*\.json|eslint\.config\.js|\.prettierrc\.json|\.prettierignore|\.gitignore|\.dockerignore|\.env\.example|\.env\.host\.example|Dockerfile|compose[\w.]*\.yaml|redocly\.yaml|vitest[\w.]*\.ts)$/;
const forbidden = files.filter((f) => FORBIDDEN.some((re) => re.test(f)));
if (forbidden.length) die('forbidden files in the working tree (secrets/env/build output). Remove or ignore them:', forbidden);
const unrelated = files.filter((f) => !ROOTS.test(f) && !ROOT_FILES.test(f) && !includes.has(f));
if (unrelated.length)
  die('working tree contains files outside the checkpoint scope. Resolve explicitly (delete, ignore, or pass --include <path>):', unrelated);

// 3. secret scan of the content being committed
const SECRET_PATTERNS = [
  [/-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, 'private key'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key id'],
  [/sk_live_[0-9a-zA-Z]{16,}/, 'Stripe live key'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\b(?:secret|password|passwd|token|api[_-]?key)\b["']?\s*[:=]\s*["']?([A-Za-z0-9/+_.-]{16,})/i, 'credential assignment'],
];
const SAFE_VALUE = /dev_only|example|changeme|placeholder|dummy|test|\$\{|process\.env|xxxx/i;
const hits = [];
for (const f of files) {
  if (f === 'pnpm-lock.yaml' || !exists(f)) continue;
  let s;
  try {
    if (!statSync(p(f)).isFile() || statSync(p(f)).size > 2_000_000) continue;
    s = readFileSync(p(f), 'utf8');
  } catch {
    continue;
  }
  if (s.includes('\0')) continue;
  // A line can opt out with the marker `secret-scan:allow` (deliberate fake fixtures in tests). No path-level excludes.
  const scanned = s
    .split('\n')
    .filter((l) => !l.includes('secret-scan:allow'))
    .join('\n');
  for (const [re, name] of SECRET_PATTERNS) {
    const m = scanned.match(re);
    if (!m) continue;
    if (name === 'credential assignment' && SAFE_VALUE.test(m[0])) continue;
    hits.push(`${f}: possible ${name}`);
  }
}
if (hits.length) die('possible secrets detected:', hits);

console.log(`Checkpoint ${id}: ${files.length} file(s) will be committed:`);
for (const e of entries) console.log(`  ${e.code.trim().padEnd(2)} ${e.file}`);
console.log(`\nMessage: ${message}`);
if (dry) {
  console.log('\n--dry-run: nothing was committed.');
  process.exit(0);
}

// 4. explicit file list only (never `git add -A`); never push
git(['add', '--', ...files]);
const trailers = (flags.trailer ?? []).filter((x) => typeof x === 'string');
const full = trailers.length ? `${message}\n\n${trailers.join('\n')}` : message;
git(['commit', '-m', full]);
console.log(`\nCommitted ${git(['rev-parse', '--short', 'HEAD']).trim()}. Not pushed (this tool never pushes).`);

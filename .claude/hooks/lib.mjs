// Shared helpers for the BananaGig Claude Code hooks (ENG-GOV-001). See README.md in this folder.
//
// Design rules (docs/engineering/PRODUCTION_STANDARD.md, "Claude Code configuration model"):
//  - hooks parse the STRUCTURED JSON event from stdin, never grep raw text;
//  - blocking PreToolUse guards fail SAFE: unreadable input or an internal error produces an "ask" decision, never a silent allow;
//  - advisory hooks never block;
//  - "allow" is expressed by printing NOTHING, so the normal permission flow (settings.json permissions, prompts) still applies.
//    These hooks never emit permissionDecision "allow", because that would skip the user's permission prompt.
//
// Module layout: lib.mjs (this file: events, paths, git, migrations, file-content rules, evidence store), shell.mjs (shell parser and
// command normalisation), bash.mjs (the Bash command analysis), git-options.mjs (git option tables).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------------------------------------------------
// Event input / decision output
// ---------------------------------------------------------------------------------------------------------------------

export async function readEvent() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  if (!data.trim()) return { ok: false, error: 'empty stdin' };
  try {
    const event = JSON.parse(data);
    if (event === null || typeof event !== 'object' || Array.isArray(event)) return { ok: false, error: 'stdin JSON is not an object' };
    return { ok: true, event };
  } catch (e) {
    return { ok: false, error: `invalid JSON (${e.message})` };
  }
}

function clip(text, max = 1500) {
  const s = String(text);
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

const EXCEPTION_HINT = 'If this is intentional, the user must approve it (permission prompt) or change the hook with review; see .claude/hooks/README.md.';

/** Print a PreToolUse decision. decision: 'deny' | 'ask' | 'allow'. 'allow' prints nothing (or only advisory context). */
export function emitPreToolUse({ decision, reasons = [], context = [], name }) {
  const hookSpecificOutput = { hookEventName: 'PreToolUse' };
  if (decision === 'deny' || decision === 'ask') {
    hookSpecificOutput.permissionDecision = decision;
    hookSpecificOutput.permissionDecisionReason = clip(`BananaGig ${name} guard: ${reasons.join(' | ')}${decision === 'deny' ? ` ${EXCEPTION_HINT}` : ''}`);
  }
  if (context.length) hookSpecificOutput.additionalContext = clip(context.join(' '));
  if (!hookSpecificOutput.permissionDecision && !hookSpecificOutput.additionalContext) return;
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput })}\n`);
}

/** Run a blocking PreToolUse guard with fail-safe handling. evaluate(event) -> { decision, reasons, context }. */
export async function runGuard(name, evaluate) {
  try {
    const input = await readEvent();
    if (!input.ok) {
      emitPreToolUse({
        name,
        decision: 'ask',
        reasons: [`could not read the hook input (${input.error}); asking instead of allowing`],
      });
      return;
    }
    emitPreToolUse({ name, ...(await evaluate(input.event)) });
  } catch (e) {
    emitPreToolUse({
      name,
      decision: 'ask',
      reasons: [`internal hook error (${e && e.message ? e.message : e}); asking instead of allowing`],
    });
  }
}

/** Run an advisory hook. Never blocks: failures are reported on stderr with exit code 1 (a non-blocking hook error). */
export async function runAdvisory(name, handle) {
  try {
    const input = await readEvent();
    if (!input.ok) throw new Error(`could not read the hook input (${input.error})`);
    const output = await handle(input.event);
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (e) {
    process.stderr.write(`BananaGig ${name} hook (advisory) failed: ${e && e.message ? e.message : e}\n`);
    process.exitCode = 1;
  }
}

export function projectRoot(event) {
  return process.env.CLAUDE_PROJECT_DIR || (event && typeof event.cwd === 'string' && event.cwd) || process.cwd();
}

// ---------------------------------------------------------------------------------------------------------------------
// Time budget (a hook that runs past its timeout may not block; analysis must give up and ask instead)
// ---------------------------------------------------------------------------------------------------------------------

export class BudgetError extends Error {}
let deadline = Infinity;
let gitCalls = 0;
const MAX_GIT_CALLS = 60;
export function startBudget(ms) {
  deadline = ms === null ? Infinity : Date.now() + ms;
  gitCalls = 0;
}
export function checkBudget() {
  if (Date.now() > deadline) throw new BudgetError('analysis time budget exceeded');
}

// ---------------------------------------------------------------------------------------------------------------------
// Case-insensitive file systems (macOS APFS/HFS+ and Windows): `.ENV` IS `.env`, `DB/Migrations` IS `db/migrations`
// ---------------------------------------------------------------------------------------------------------------------

export const caseInsensitiveFs = () =>
  process.platform === 'darwin' || process.platform === 'win32' || process.env.BANANAGIG_HOOKS_ASSUME_CASE_INSENSITIVE === '1';
/** Comparison key for a path or name. */
export const fsKey = (s) => (caseInsensitiveFs() ? String(s).toLowerCase() : String(s));
/** Make a pattern case-insensitive on case-insensitive file systems. */
export const rx = (re) => (caseInsensitiveFs() && !re.flags.includes('i') ? new RegExp(re.source, `${re.flags}i`) : re);

// ---------------------------------------------------------------------------------------------------------------------
// Paths and git
// ---------------------------------------------------------------------------------------------------------------------

/** realpath of the deepest existing ancestor + the not-yet-existing remainder (so new files resolve like existing ones). */
export function realpathLoose(p) {
  const abs = path.resolve(p);
  let head = abs;
  const tail = [];
  while (!existsSync(head)) {
    const parent = path.dirname(head);
    if (parent === head) break;
    tail.unshift(path.basename(head));
    head = parent;
  }
  let real = head;
  try {
    real = realpathSync(head);
  } catch {
    // keep the unresolved path
  }
  return path.join(real, ...tail);
}

function cleanGitEnv() {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[k];
  return env;
}

const gitCache = new Map();
/** Runs git (results are cached for the lifetime of the hook process); returns { ok, out }. Never throws except BudgetError. */
export function git(cwd, args) {
  const key = `${cwd}\0${args.join('\0')}`;
  if (gitCache.has(key)) return gitCache.get(key);
  checkBudget();
  gitCalls += 1;
  if (gitCalls > MAX_GIT_CALLS) throw new BudgetError('too many git calls for one analysis');
  let result;
  try {
    const out = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanGitEnv(),
      maxBuffer: 16 * 1024 * 1024,
    });
    result = { ok: true, out };
  } catch (e) {
    result = { ok: false, out: '', status: e && e.status };
  }
  gitCache.set(key, result);
  return result;
}

function existingDir(p) {
  let d = path.resolve(p);
  while (!existsSync(d)) {
    const parent = path.dirname(d);
    if (parent === d) return d;
    d = parent;
  }
  return d;
}

const topCache = new Map();
export function gitTopLevel(somePath) {
  const dir = existingDir(path.dirname(path.resolve(somePath)));
  if (topCache.has(dir)) return topCache.get(dir);
  const r = git(dir, ['rev-parse', '--show-toplevel']);
  const top = r.ok ? realpathLoose(r.out.trim()) : null;
  topCache.set(dir, top);
  return top;
}

export const toPosix = (p) => p.split(path.sep).join('/');

// ---------------------------------------------------------------------------------------------------------------------
// Migrations: "never edit an applied migration" (CLAUDE.md hard rule)
// ---------------------------------------------------------------------------------------------------------------------

const MIGRATION_DIR = 'db/migrations';
const migrationCache = new Map();

/** Committed migrations: everything in HEAD plus everything that ever existed in any ref (so deleted ones stay protected). */
function migrationIndex(top) {
  if (migrationCache.has(top)) return migrationCache.get(top);
  const head = git(top, ['ls-tree', '-r', '--name-only', 'HEAD', '--', `${MIGRATION_DIR}/`]);
  const history = git(top, ['log', '--all', '--name-only', '--pretty=format:', '--', `${MIGRATION_DIR}/`]);
  // status 128 = no commits yet / no refs: an empty history is a valid answer; any other failure is "unknown"
  const unknown = (!head.ok && head.status !== 128) || (!history.ok && history.status !== 128);
  const applied = new Set();
  const numbers = [];
  for (const line of head.out.split('\n')) {
    if (!line.trim()) continue;
    applied.add(fsKey(line.trim()));
    const n = /(?:^|\/)(\d+)_/.exec(line);
    if (n) numbers.push(Number(n[1]));
  }
  for (const line of history.out.split('\n')) if (line.trim()) applied.add(fsKey(line.trim()));
  const index = {
    unknown,
    applied,
    max: numbers.length ? Math.max(...numbers) : 0,
  };
  migrationCache.set(top, index);
  return index;
}

/** True when a repo-relative posix path is the migrations directory (optionally with a trailing slash). */
export const isMigrationsDir = (rel) => fsKey(rel).replace(/\/+$/, '') === MIGRATION_DIR;
/** True for the migrations directory itself or any ancestor of it (db, the repository root). */
export const isMigrationsDirOrAncestor = (rel) => {
  const k = fsKey(rel).replace(/\/+$/, '');
  return k === '' || k === '.' || k === 'db' || k === MIGRATION_DIR;
};

/**
 * Classify a write to `absPath`. Returns null when the path is not a migration file, else { level: 'deny'|'ask'|null, message }.
 * Applied = committed (present in HEAD or anywhere in history). A new file (untracked, or only staged) whose number is greater than
 * the latest committed one is allowed. Offline: relies on git only (two cached git calls per hook run, however many files are named).
 */
export function classifyMigrationWrite(absPath) {
  const real = realpathLoose(absPath);
  const top = gitTopLevel(real);
  if (!top) {
    // Only matters when the path looks like a migration; without a repository we cannot tell what was applied.
    return rx(/(^|\/)db\/migrations\/[^/]+\.sql$/).test(toPosix(real))
      ? {
          level: 'ask',
          message: `cannot determine with git whether ${path.basename(real)} is an applied migration (not inside a git repository)`,
        }
      : null;
  }
  const rel = toPosix(path.relative(top, real));
  const m = rx(/^db\/migrations\/([^/]+\.sql)$/).exec(rel);
  if (!m) return null;
  const index = migrationIndex(top);
  if (index.unknown) return { level: 'ask', message: `could not read git history for ${rel}` };
  if (index.applied.has(fsKey(rel))) {
    return {
      level: 'deny',
      message: `${rel} is an applied (committed) migration. Never edit an applied migration; fix forward with a new db/migrations/NNNN_*.sql.`,
    };
  }
  // New file: it must be numbered after the latest committed migration.
  const mine = /^(\d+)_/.exec(m[1]);
  if (!mine)
    return {
      level: 'ask',
      message: `${rel} does not follow the NNNN_name.sql migration naming`,
    };
  if (Number(mine[1]) <= index.max) {
    return {
      level: 'ask',
      message: `new migration ${rel} is not numbered after the latest committed migration (${String(index.max).padStart(4, '0')})`,
    };
  }
  return { level: null, message: '' };
}

// ---------------------------------------------------------------------------------------------------------------------
// Production-source classification and risk classes (docs/engineering/PRODUCTION_STANDARD.md)
// ---------------------------------------------------------------------------------------------------------------------

const TEST_FILE_RE = /\.(?:test|itest|spec)\.[cm]?[jt]sx?$/;
const TEST_DIR_RE = /(?:^|\/)(?:__tests__|tests?)\/|^packages\/testing\//;
export const isTestFile = (rel) => rx(TEST_FILE_RE).test(rel) || rx(TEST_DIR_RE).test(rel);

/** rel: posix path relative to the repository top level. */
export function isProductionSource(rel) {
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  if (/(^|\/)(node_modules|dist|\.next|\.turbo|\.vitest|\.checkpoint|\.claude)\//.test(rel)) return false;
  if (isTestFile(rel)) return false;
  if (/^db\/migrations\/.+\.sql$/.test(rel)) return true;
  if (/^(apps|packages)\/[^/]+\/.+\.(?:[cm]?[jt]sx?|sql|css|ya?ml)$/.test(rel)) return !/\/(?:vitest|tsconfig)[^/]*$/.test(rel) && !/\.d\.ts$/.test(rel);
  if (/^scripts\/.+\.(?:[cm]?[jt]s)$/.test(rel)) return true;
  if (/^infra\/.+/.test(rel)) return true;
  return false;
}

const BOUNDARY = '(?:^|[/_.-])';
const END = '(?:$|[/_.-])';
const RISK_P0 = [
  [
    `${BOUNDARY}(?:stripe|payments?|billing|refunds?|ledger|money|payouts?|pricing|prices?|booking|bookings|capacity|checkout|bananadrops?|drops?)${END}`,
    'money / booking / BananaDrops',
  ],
  [`${BOUNDARY}(?:identity|auth|authz|authn|session|sessions|mfa|consent|accounts?|security)${END}`, 'identity / authorization / sensitive data'],
];
const RISK_P1 = [
  [
    `${BOUNDARY}(?:provider|providers|trust|availability|dispatch|location|cancel|cancellation|notifications?)${END}`,
    'provider / trust / availability / dispatch / notifications',
  ],
  ['^db/migrations/', 'database migration (P1; P0 when it touches money, booking or identity data)'],
];

/** Returns { cls: 'P0'|'P1', area } or null. */
export function riskClass(rel) {
  const p = rel.toLowerCase();
  for (const [re, area] of RISK_P0) if (new RegExp(re).test(p)) return { cls: 'P0', area };
  for (const [re, area] of RISK_P1) if (new RegExp(re).test(p)) return { cls: 'P1', area };
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Verification evidence store: .claude/state/verify.json (git-ignored)
// ---------------------------------------------------------------------------------------------------------------------

export const MAX_VERIFY_ENTRIES = 50;
export const verifyPath = (root) => path.join(root, '.claude', 'state', 'verify.json');
export const statePath = (root, name) => path.join(root, '.claude', 'state', name);

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

export function readVerify(root) {
  const v = readJson(verifyPath(root), null);
  if (!v || typeof v !== 'object' || !Array.isArray(v.entries)) return { version: 1, entries: [] };
  return {
    version: 1,
    entries: v.entries.filter((e) => e && typeof e.at === 'string' && typeof e.status === 'string'),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// File-content rules shared by pre-edit
// ---------------------------------------------------------------------------------------------------------------------

/** Secrets files: .env and .env.host (never the *.example files). */
export const isEnvName = (name) => rx(/^\.env(?:\.host)?$/).test(String(name));

// Secret patterns are assembled from fragments so this source file itself never contains a complete credential-looking literal.
const J = (...parts) => parts.join('');
const LOCAL_HOST =
  /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|host\.docker\.internal|[^.]+|.+\.(?:example|invalid|test|local|localhost)|example\.(?:com|org|net))$/i;
const PLACEHOLDER_SECRET = /dev_only|example|changeme|placeholder|dummy|test|xxxx|your[-_]|<|\$\{|\$[A-Z_]|\{\{|\*\*\*|%s/i;
export const SECRET_PATTERNS = [
  {
    label: 'a private key block',
    re: new RegExp(`-{5}BEGIN (?:[A-Z]+ )*PRIVATE ${J('KE', 'Y')}-{5}`, 'g'),
  },
  {
    label: 'an AWS access key id',
    re: new RegExp(`\\b${J('AK', 'IA')}[0-9A-Z]{16}\\b`, 'g'),
  },
  {
    label: 'an AWS secret access key assignment',
    re: new RegExp(`\\baws_?secret_?access_?key\\b["']?\\s*[:=]\\s*["']?[A-Za-z0-9/+=]{40}\\b`, 'gi'),
  },
  {
    label: 'a GitHub token',
    re: new RegExp(`\\b${J('gh')}[pousr]_[A-Za-z0-9]{30,}\\b`, 'g'),
  },
  {
    label: 'a GitHub fine-grained token',
    re: new RegExp(`\\b${J('github', '_', 'pat', '_')}[A-Za-z0-9_]{30,}\\b`, 'g'),
  },
  {
    label: 'a Stripe live secret key',
    re: new RegExp(`\\b[rs]k_${J('li', 've')}_[A-Za-z0-9]{16,}`, 'g'),
  },
  {
    label: 'a Slack token',
    re: new RegExp(`\\b${J('xo', 'x')}[bp]-[A-Za-z0-9-]{10,}`, 'g'),
  },
  {
    label: 'an Anthropic API key',
    re: new RegExp(`\\b${J('sk', '-ant-')}[A-Za-z0-9_-]{20,}`, 'g'),
  },
  {
    label: 'a Google API key',
    re: new RegExp(`\\b${J('AI', 'za')}[0-9A-Za-z_-]{35}\\b`, 'g'),
  },
  {
    label: 'an npm access token',
    re: new RegExp(`\\b${J('npm', '_')}[A-Za-z0-9]{36}\\b`, 'g'),
  },
  {
    label: 'a SendGrid API key',
    re: new RegExp(`\\b${J('S', 'G')}\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}`, 'g'),
  },
  {
    label: 'a JSON Web Token',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    label: 'a database URL with an embedded password',
    re: /\bpostgres(?:ql)?:\/\/[^:\s/@]+:([^@\s/]+)@([^\s/:?#]+)/gi,
    accept: (m) => !PLACEHOLDER_SECRET.test(m[1]) && !LOCAL_HOST.test(m[2]),
  },
];
const SECRET_ALLOW = 'secret-scan:allow';
// Invisible characters that could split a token so a plain scan misses it.
const INVISIBLE = new RegExp(`[${[0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0xad].map((c) => String.fromCharCode(c)).join('')}]`, 'g');
export const stripInvisible = (text) => String(text).replace(INVISIBLE, '');

/** Test fixtures and test-support code, where the deliberate fake credentials live. */
export const isFixturePath = (rel) => isTestFile(String(rel)) || /(^|\/)(?:__fixtures__|fixtures?|testing)\//.test(String(rel));
const FAKE_TOKEN = /example|fake|dummy|sample|redacted|test|x{6,}|0{6,}|(.)\1{9,}/i;

/**
 * Secret-looking tokens in `text`: [{ label, match, line, marked }]. `marked` = the line carries the allow marker.
 * Zero-width characters are removed before matching.
 */
export function scanSecrets(text) {
  const out = [];
  for (const line of stripInvisible(text).split('\n')) {
    for (const { label, re, accept } of SECRET_PATTERNS) {
      re.lastIndex = 0;
      for (let m = re.exec(line); m; m = re.exec(line)) {
        if (m[0].length === 0) {
          re.lastIndex += 1;
          continue;
        }
        if (accept && !accept(m)) continue;
        out.push({
          label,
          match: m[0],
          line,
          marked: line.includes(SECRET_ALLOW),
        });
      }
    }
  }
  return out;
}

/**
 * Decide on the secrets ADDED by an edit (`found` = scanSecrets(post-edit content) minus tokens already present before the edit).
 * deny: no marker. ask: marker without the documented fixture shape (a test/fixture file AND an obviously fake token).
 * The marker is only honoured silently when both hold, because the agent could otherwise put it on any line itself.
 */
export function judgeSecrets(found, filePath) {
  const deny = new Set();
  const ask = new Set();
  for (const f of found) {
    if (!f.marked) deny.add(f.label);
    else if (isFixturePath(filePath) && FAKE_TOKEN.test(f.match)) continue;
    else ask.add(f.label);
  }
  return { deny: [...deny], ask: [...ask] };
}

const DISABLED_TEST_PATTERNS = [
  [/\.(?:skip|only|fails|todo)\b/g, '.skip / .only / .fails / .todo (calls, references and .each forms)'],
  [/\.(?:skipIf|runIf)\b/g, '.skipIf / .runIf'],
  [/\[\s*['"](?:skip|only|fails|todo)['"]\s*\]/g, "['skip'] / ['only']"],
  [/\b(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(/g, 'xit( / xdescribe( / fit('],
  [/\b(?:skip|only|todo|fails)\s*:\s*true\b/g, '{ skip: true }'],
];
const count = (re, s) => (s.match(re) || []).length;
// comment-only lines (a commented-out skip does not count, and moving one into code does)
const withoutCommentLines = (text) =>
  String(text)
    .split('\n')
    .filter((l) => !/^\s*(?:\/\/|\*|\/\*|#)/.test(l))
    .join('\n');

/** Disabled/focused test constructs added by an edit (count in new content minus count in replaced content). */
export function addedDisabledTests(oldText, newText) {
  const found = [];
  const before = withoutCommentLines(oldText ?? '');
  const after = withoutCommentLines(newText);
  for (const [re, label] of DISABLED_TEST_PATTERNS) if (count(re, after) > count(re, before)) found.push(label);
  return found;
}

// The directive names are assembled from fragments so the repository's own governance scan (which greps for them) does not flag this file.
const TS_DIRECTIVE_RE = new RegExp(J('@ts-', '(?:ig', 'nore|no', 'check)'));
const LINT_DIRECTIVE_RE = new RegExp(J('eslint', '-disable'));

/** Lines carrying a suppression directive without a stated reason (checked per line, so the cost is linear in the input). */
function unreasonedSuppressions(text) {
  let n = 0;
  for (const line of String(text).split('\n')) {
    const ts = TS_DIRECTIVE_RE.exec(line);
    if (ts) {
      const rest = line
        .slice(ts.index + ts[0].length)
        .replace(/^[\s:-]+/, '')
        .replace(/\*\/\s*$/, '');
      if (!/\S/.test(rest)) n += 1;
    }
    if (LINT_DIRECTIVE_RE.test(line) && !/\s--\s+\S/.test(line)) n += 1;
  }
  return n;
}

export function addedSuppressions(oldText, newText) {
  if (unreasonedSuppressions(newText) <= unreasonedSuppressions(String(oldText ?? ''))) return [];
  return [
    'a TypeScript ignore/nocheck or lint-disable directive without a stated reason (prefer an expect-error directive, and a "-- reason" on lint-disable)',
  ];
}

const GATE_PATTERNS = [
  /^\.github\//,
  /^\.claude\/(?!state\/)/,
  /^\.git\/(?![^]*\.lock$)/,
  /(?:^|\/)\.gitleaks\.toml$/,
  /(?:^|\/)CODEOWNERS$/,
  /(?:^|\/)\.gitignore$/,
  /(?:^|\/)\.prettier(?:rc[^/]*|ignore)$/,
  /(?:^|\/)package\.json$/,
  /(?:^|\/)eslint\.config\.[cm]?[jt]s$/,
  /(?:^|\/)tsconfig[^/]*\.json$/,
  /(?:^|\/)vitest[^/]*\.[cm]?[jt]s$/,
  /(?:^|\/)turbo\.json$/,
  /(?:^|\/)Dockerfile(?:\.[^/]+)?$/,
  /(?:^|\/)compose[^/]*\.ya?ml$/,
  /(?:^|\/)pnpm-lock\.yaml$/,
  /(?:^|\/)pnpm-workspace\.yaml$/,
  /(?:^|\/)redocly\.yaml$/,
  /^scripts\/check-boundaries\.mjs$/,
  /^scripts\/[^/]*-check\.mjs$/,
  /^scripts\/governance[^/]*$/,
  /^scripts\/migrate\.mjs$/,
  /^scripts\/generate-specs\.mjs$/,
  /^scripts\/claude-hooks\.test\.mjs$/,
  /^docs\/engineering\/TEMPORARY_MITIGATIONS\.md$/,
];

/** Quality-gate / CI / tooling / Claude-configuration files whose weakening needs the user's approval. rel: posix, repo-relative. */
export const isGateFile = (rel) => GATE_PATTERNS.some((re) => rx(re).test(rel));

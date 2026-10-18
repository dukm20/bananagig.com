// Production-governance policy scan (ENG-GOV-001, Checkpoint B). Read-only; no dependencies beyond Node, git and `yaml`
// (already a root devDependency).
//
//   node scripts/governance-scan.mjs [--json] [--strict] [--allowlist=<file>] [--base=<ref>] [--allow-baseline-growth] [--today=YYYY-MM-DD]
//
// Scans the files tracked by git in the current repository (`git ls-files`, plus new un-ignored files) and prints a table of findings.
// Exit 0 = no findings, 1 = findings (including a STALE or EXPIRED allowlist entry), 2 = usage/internal error.
// Informational lines never change the exit code.
//
// Rules
//   R1  no skipped / focused / todo / fixme / conditional / expected-failing tests in test files (.skip .only .todo .fixme .fails
//       .runIf skipIf, ['skip'], { skip: true }, xit/xdescribe/fit/fdescribe). An early `return` inside a test body cannot be
//       detected reliably and is left to review (REVIEW_CHECKLIST.md).
//   R2  no TODO / FIXME / HACK in tracked source unless it names a temporary mitigation (MIT-nnnn). The register
//       docs/engineering/TEMPORARY_MITIGATIONS.md is validated when present (fields, status, approver, expiry) and is REQUIRED
//       when anything references it. A MIT id referenced from code must be an ACTIVE (approved) entry.
//   R3  no @ts-ignore / @ts-nocheck; @ts-expect-error and eslint-disable* must carry a reason
//   R4  workflows and composite actions (parsed as YAML): a `permissions:` block, no write-all / write permission that is not
//       allowlisted, every `uses:` pinned to a 40-hex commit SHA (docker image tags: informational)
//   R5  `--passWithNoTests` in package.json test scripts: ratchet (baseline count may not grow)
//   R6  production code (apps/*/src, packages/*/src, non-test) must not import testing helpers or set allowTestKeys: true
//   R7  CODEOWNERS present (informational)
//
// Known, justified exceptions live in scripts/governance-allowlist.json (see that file's "readme"). An entry that no
// longer matches anything is reported as STALE so the allowlist cannot rot; an entry past `expires` is EXPIRED; an entry
// without `reviewedBy` is a finding. Options:
//   --strict                  also report every entry/ratchet whose reviewedBy still starts with PENDING. Use it on the day
//                             the policy-scan job becomes blocking (the owner must have reviewed every baseline by then).
//   --base=<ref>              compare the allowlist with its copy at <ref> and report any NEW entry, any higher count and a
//                             higher R5 ratchet as a finding, so a change cannot grant itself an exception. Default: origin/main,
//                             or HEAD~1 when origin/main is absent or equals HEAD. CI passes the PR base branch.
//   --allow-baseline-growth   downgrade those growth findings to notes (use only in a change the owner has approved).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { LineCounter, isMap, isScalar, isSeq, parseDocument } from 'yaml';

const argv = process.argv.slice(2);
const flag = (n) => argv.some((a) => a === `--${n}`);
const opt = (n) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const unknown = argv.filter((a) => !/^--(json|strict|allow-baseline-growth|allowlist=.+|base=.+|today=\d{4}-\d{2}-\d{2})$/.test(a));
if (unknown.length) {
  console.error(`governance:scan: unknown argument(s): ${unknown.join(' ')}`);
  process.exit(2);
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
let ROOT;
try {
  ROOT = git(['rev-parse', '--show-toplevel']).trim();
} catch {
  console.error('governance:scan: not inside a git repository');
  process.exit(2);
}
const TODAY = opt('today') ?? new Date().toISOString().slice(0, 10);
const REGISTER = 'docs/engineering/TEMPORARY_MITIGATIONS.md';
const ALLOWLIST = opt('allowlist') ?? path.join(ROOT, 'scripts', 'governance-allowlist.json');

// Tracked files plus new, not-yet-tracked files that are not git-ignored (identical to `git ls-files` in CI, and a local
// run can check a file before it is committed). A tracked file deleted from the working tree is not scanned.
const FILES = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0'))].filter(
  (f) => f && existsSync(path.join(ROOT, f)),
);
const text = new Map();
const read = (f) => {
  if (!text.has(f)) text.set(f, readFileSync(path.join(ROOT, f), 'utf8'));
  return text.get(f);
};
const lines = (f) => read(f).split('\n');

const findings = [];
const info = [];
const add = (rule, file, line, message, lineText = '') => findings.push({ rule, file, line, message, lineText: lineText.trim() });
const note = (rule, file, line, message) => info.push({ rule, file, line, message });

// ---------------------------------------------------------------- file classes
const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|sql|sh|yml|yaml|json)$|(^|\/)(Dockerfile|Caddyfile)$/;
const CODE_EXT = '(?:ts|tsx|mts|cts|js|mjs|cjs)';
// Narrow notion of a test file (R6: a file that is "test" by this definition may import testing helpers).
const isStrictTestFile = (f) => new RegExp(`\\.(test|itest|spec)\\.${CODE_EXT}$`).test(f) || /(^|\/)__tests__\//.test(f) || f.startsWith('packages/testing/');
// Wide notion (R1: where a skipped test could hide): also any test/ or tests/ directory, *.integration.*, *.e2e.*.
const isTestFile = (f) => isStrictTestFile(f) || /(^|\/)tests?\//.test(f) || /\.(integration|e2e)\./.test(f);
const isSourceForTodo = (f) =>
  SOURCE_EXT.test(f) &&
  f !== 'scripts/governance-allowlist.json' &&
  !f.startsWith('docs/') &&
  !f.startsWith('skills/') &&
  !/(^|\/)(pnpm-lock\.yaml|package-lock\.json)$/.test(f);
const isCodeFile = (f) => new RegExp(`\\.${CODE_EXT}$`).test(f);
const commentOnly = (l) => /^\s*(\/\/|\*|\/\*|#)/.test(l);

// ---------------------------------------------------------------- R1 skipped tests
const MOD = '(?:skip|only|todo|fixme|fails|runIf|skipIf)(?![\\w-])';
const R1_PATTERNS = [
  // it.skip, it.skip.each, it.concurrent.skip, const s = it.skip, it.only, it.todo, test.fixme, it.fails, it.runIf(c), it.skipIf(c)
  new RegExp(`\\b(?:it|test|describe|suite|bench|specify)(?:\\.\\w+|\\([^()]*\\))*\\.${MOD}`),
  new RegExp(`\\.${MOD}\\s*\\(`), // any call of a modifier: alias.skip(...), t.fixme(...), ctx.skip(reason)
  /\bskipIf\b/,
  /\b(?:xit|xdescribe|xtest|fit|fdescribe)\(/,
  /\[\s*['"`](?:skip|only|todo|fixme|fails|runIf|skipIf)['"`]\s*\]/, // it['skip'](...)
  /[{,]\s*(?:skip|only|todo)\s*:\s*(?:true\b|!|['"`])/, // it('x', { skip: true }, fn)
];
for (const f of FILES.filter((x) => isTestFile(x) && isCodeFile(x))) {
  lines(f).forEach((l, i) => {
    if (!commentOnly(l) && R1_PATTERNS.some((re) => re.test(l))) add('R1', f, i + 1, 'skipped/focused/todo/conditional/expected-failing test', l);
  });
}

// ---------------------------------------------------------------- R2 TODO/FIXME/HACK + register
const R2 = /\b(TODO|FIXME|HACK)\b/;
const MIT_ID = /\bMIT-\d{4}\b/g;
const mitRefs = []; // {file, line, id}
for (const f of FILES.filter(isSourceForTodo)) {
  lines(f).forEach((l, i) => {
    const m = R2.exec(l);
    if (m && !new RegExp(`\\b${m[1]}\\b[^\\n]*\\bMIT-\\d{4}\\b`).test(l)) {
      add('R2', f, i + 1, `${m[1]} without a temporary-mitigation id (MIT-nnnn)`, l);
    }
    for (const id of l.match(MIT_ID) ?? []) mitRefs.push({ file: f, line: i + 1, id });
  });
}

const FIELDS = [
  'Status',
  'Issue',
  'Root cause',
  'Customer risk',
  'Owner',
  'Approver',
  'Introduced',
  'Expiry/review date',
  'Removal condition',
  'Protection/flag',
  'Tests',
  'Monitoring',
];
const STATUSES = ['PROPOSED', 'ACTIVE', 'EXPIRED', 'REMOVED'];
const DATE = /^(\d{4}-\d{2}-\d{2})\b/;
const MAX_ACTIVE_DAYS = 400; // an ACTIVE mitigation may not be approved for longer than this (review at least annually)
const AGENT_APPROVER = /\b(?:claude|anthropic|agent|bot|ai)\b/i; // an approval must come from a named human
const OWN_FILES = new Set(['scripts/governance-scan.mjs', 'scripts/governance-scan.test.mjs']);
const registerStatus = new Map(); // id -> status
const hasRegister = FILES.includes(REGISTER);
if (!hasRegister) {
  // A deleted register must not silently switch the checks off: fail when anything still relies on it.
  const REF = /\bMIT-\d{4}\b|TEMPORARY_MITIGATIONS/;
  const skipRead = /\.(png|jpe?g|gif|ico|webp|docx|pdf|woff2?|zip|gz)$|(^|\/)pnpm-lock\.yaml$/i;
  const referrers = FILES.filter((f) => f !== REGISTER && !OWN_FILES.has(f) && !skipRead.test(f)).filter((f) => {
    try {
      return REF.test(read(f));
    } catch {
      return false;
    }
  });
  if (referrers.length) {
    add(
      'R2',
      REGISTER,
      0,
      `register file is missing but is referenced by ${referrers.slice(0, 5).join(', ')}${referrers.length > 5 ? ` and ${referrers.length - 5} more` : ''}; restore it (a deleted register must not disable the checks)`,
    );
  } else note('R2', REGISTER, 0, 'register file absent and nothing references it: temporary-mitigation register checks skipped');
} else {
  const md = lines(REGISTER);
  const heads = [];
  const ENTRY_HEADING = /^## (MIT-\d{4}) \u2014 (\S.*)$/;
  md.forEach((l, i) => {
    const h = ENTRY_HEADING.exec(l);
    if (h) heads.push({ id: h[1], title: h[2], start: i });
    else if (/^#{1,6}\s/.test(l) && /\bMIT-\d{4}\b/.test(l))
      add(
        'R2',
        REGISTER,
        i + 1,
        'register heading naming an MIT id must be exactly "## MIT-nnnn \u2014 title" (a different heading level or separator hides the entry)',
        l,
      );
    else if (/^#{1,6}\s+MIT\b/.test(l)) add('R2', REGISTER, i + 1, 'malformed register heading (expected "## MIT-nnnn \u2014 title")', l);
  });
  const todayMs = Date.parse(TODAY);
  for (const h of heads) {
    // The entry runs to the next level-1/2 heading; everything above the first MIT heading is ignored.
    let end = md.length;
    for (let i = h.start + 1; i < md.length; i++) {
      if (/^#{1,2}\s/.test(md[i])) {
        end = i;
        break;
      }
    }
    if (registerStatus.has(h.id)) add('R2', REGISTER, h.start + 1, `${h.id}: duplicate register entry`);
    const vals = {};
    for (let i = h.start + 1; i < end; i++) {
      const m =
        /^(Status|Issue|Root cause|Customer risk|Owner|Approver|Introduced|Expiry\/review date|Removal condition|Protection\/flag|Tests|Monitoring):\s*(.*)$/.exec(
          md[i],
        );
      if (m && vals[m[1]] === undefined) vals[m[1]] = m[2].trim();
    }
    for (const fld of FIELDS) {
      if (vals[fld] === undefined) add('R2', REGISTER, h.start + 1, `${h.id}: missing required field "${fld}"`);
      else if (vals[fld] === '') add('R2', REGISTER, h.start + 1, `${h.id}: field "${fld}" is empty`);
    }
    const status = vals.Status;
    if (!registerStatus.has(h.id)) registerStatus.set(h.id, status ?? '');
    if (status !== undefined && status !== '' && !STATUSES.includes(status)) {
      add('R2', REGISTER, h.start + 1, `${h.id}: Status "${status}" is not one of ${STATUSES.join(', ')}`);
    }
    const expiry = DATE.exec(vals['Expiry/review date'] ?? '')?.[1];
    const approver = vals.Approver ?? '';
    if (approver && AGENT_APPROVER.test(approver))
      add('R2', REGISTER, h.start + 1, `${h.id}: Approver "${approver}" is an agent/bot; approval must come from a named human`);
    if (status === 'ACTIVE') {
      if (approver === '' || /^PENDING\b/i.test(approver))
        add('R2', REGISTER, h.start + 1, `${h.id}: ACTIVE entry has no approver (Approver is "${approver || 'empty'}")`);
      if (vals['Expiry/review date'] && !expiry) add('R2', REGISTER, h.start + 1, `${h.id}: ACTIVE entry's Expiry/review date is not YYYY-MM-DD`);
      else if (expiry && expiry < TODAY)
        add(
          'R2',
          REGISTER,
          h.start + 1,
          `${h.id}: ACTIVE entry is past its expiry date ${expiry} (today ${TODAY}); renew with a new approval or mark it EXPIRED/REMOVED`,
        );
      else if (expiry && (Date.parse(expiry) - todayMs) / 86_400_000 > MAX_ACTIVE_DAYS)
        add(
          'R2',
          REGISTER,
          h.start + 1,
          `${h.id}: ACTIVE entry expires ${expiry}, more than ${MAX_ACTIVE_DAYS} days ahead; a mitigation must be reviewed at least annually`,
        );
    } else if (status === 'PROPOSED') {
      note('R2', REGISTER, h.start + 1, `${h.id}: PROPOSED, awaiting approval${expiry && expiry < TODAY ? ` (review date ${expiry} has passed)` : ''}`);
    }
  }
  for (const r of mitRefs) {
    if (r.file === REGISTER) continue;
    const st = registerStatus.get(r.id);
    if (st === undefined) add('R2', r.file, r.line, `${r.id} is referenced but not defined in ${REGISTER}`);
    else if (st !== 'ACTIVE')
      add(
        'R2',
        r.file,
        r.line,
        `${r.id} is referenced from code but its register status is ${st || 'empty'}; only an ACTIVE (approved) mitigation may be referenced`,
      );
  }
}

// ---------------------------------------------------------------- R3 suppressions
// A suppression has a reason when it says why: text after "--", text after @ts-expect-error, another comment on the
// same line before the directive, or an explanatory (non-directive) comment line directly above.
const hasReason = (l, prev) => {
  const d = l.search(/eslint-disable|@ts-expect-error/);
  const tail = l.slice(d);
  if (/(^|\s)--\s*\S/.test(tail)) return true;
  const ts = /@ts-expect-error\b[:\s-]*(.*?)(\*\/)?\s*$/.exec(l);
  if (ts && /[A-Za-z]{3}/.test(ts[1])) return true;
  const head = l.slice(0, d);
  if (/(\/\/|\/\*)\s*\S[^\n]*(\/\/|\/\*)\s*$/.test(head) || /(\/\/|\/\*)[^/*\n]*\S[^\n]*\s(\/\/|\/\*)\s*$/.test(head)) return true;
  return prev !== undefined && /^\s*(\/\/|\/\*|\*)\s*\S/.test(prev) && !/eslint-disable|@ts-/.test(prev);
};
for (const f of FILES.filter(isCodeFile)) {
  const ls = lines(f);
  ls.forEach((l, i) => {
    if (/@ts-ignore|@ts-nocheck/.test(l)) add('R3', f, i + 1, '@ts-ignore/@ts-nocheck is prohibited; use a typed fix or @ts-expect-error with a reason', l);
    else if (/@ts-expect-error/.test(l) && !hasReason(l, ls[i - 1])) add('R3', f, i + 1, '@ts-expect-error without a reason', l);
    if (/eslint-disable/.test(l) && !hasReason(l, ls[i - 1]))
      add('R3', f, i + 1, 'eslint-disable without a reason (add "-- why" or an explanatory comment)', l);
  });
}

// ---------------------------------------------------------------- R4 workflows and composite actions (parsed as YAML)
const workflows = FILES.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
const composite = FILES.filter((f) => /^\.github\/actions\/(?:.+\/)?action\.ya?ml$/.test(f));
const pinProblem = (ref) => {
  if (ref.startsWith('./')) return null; // local action or reusable workflow in this repository
  if (ref.startsWith('docker://')) return /@sha256:[0-9a-f]{64}$/.test(ref) ? null : `docker action not pinned by digest: ${ref}`;
  return /@[0-9a-f]{40}$/.test(ref) ? null : `action not pinned to a full commit SHA: ${ref}`;
};
for (const f of [...workflows, ...composite]) {
  const ls = lines(f);
  const lc = new LineCounter();
  const doc = parseDocument(read(f), { lineCounter: lc, prettyErrors: false });
  if (doc.errors.length) {
    add('R4', f, 1, `workflow YAML does not parse: ${doc.errors[0].message.split('\n')[0]}`);
    continue;
  }
  const lineOf = (node) => (node?.range ? lc.linePos(node.range[0]).line : 1);
  const src = (n) => ls[n - 1] ?? '';
  // every `uses:` anywhere (block or flow mapping, step or job level), quotes stripped by the parser
  const walk = (node) => {
    if (isMap(node)) {
      for (const pair of node.items) {
        if (isScalar(pair.key) && pair.key.value === 'uses' && isScalar(pair.value) && typeof pair.value.value === 'string') {
          const problem = pinProblem(pair.value.value.trim());
          if (problem) add('R4', f, lineOf(pair.value), problem, src(lineOf(pair.value)));
        }
        walk(pair.value);
      }
    } else if (isSeq(node)) node.items.forEach(walk);
  };
  walk(doc.contents);
  if (composite.includes(f)) continue; // composite actions have no permissions of their own
  // permissions: present at the top or on every job; never write-all / write unless allowlisted
  const perms = (node, where) => {
    if (isScalar(node) && typeof node.value === 'string' && /^write(-all)?$/.test(node.value)) {
      add('R4', f, lineOf(node), `${where} permissions: ${node.value} grants write to every scope`, src(lineOf(node)));
    } else if (isMap(node)) {
      for (const pair of node.items) {
        if (isScalar(pair.value) && pair.value.value === 'write')
          add(
            'R4',
            f,
            lineOf(pair.value),
            `${where} permission "${pair.key?.value}: write" (allowlist it with a justification if it is needed)`,
            src(lineOf(pair.value)),
          );
      }
    }
  };
  const top = isMap(doc.contents) ? doc.contents.get('permissions', true) : undefined;
  const jobsNode = isMap(doc.contents) ? doc.contents.get('jobs', true) : undefined;
  const jobPairs = isMap(jobsNode) ? jobsNode.items.filter((p) => isMap(p.value)) : [];
  const jobsWithPerm = jobPairs.filter((p) => p.value.has('permissions')).length;
  if (top === undefined && !(jobPairs.length > 0 && jobsWithPerm === jobPairs.length))
    add('R4', f, 1, 'workflow has no `permissions:` block (top level, or on every job)');
  if (top !== undefined) perms(top, 'workflow-level');
  for (const jp of jobPairs) if (jp.value.has('permissions')) perms(jp.value.get('permissions', true), `job "${jp.key?.value}"`);
  ls.forEach((l, i) => {
    const img = /^\s*image:\s*([^\s#]+)/.exec(l) ?? /docker run\b.*?\s([\w./-]+\/[\w./-]+:[\w.-]+(?:@sha256:[0-9a-f]+)?)(\s|$)/.exec(l);
    if (img && !/@sha256:/.test(img[1])) note('R4', f, i + 1, `container image pinned by tag only: ${img[1]}`);
  });
}

// ---------------------------------------------------------------- R5 --passWithNoTests ratchet
const passWithNoTests = [];
for (const f of FILES.filter((x) => /(^|\/)package\.json$/.test(x))) {
  lines(f).forEach((l, i) => {
    if (/^\s*"test"\s*:/.test(l) && /--passWithNoTests/.test(l)) passWithNoTests.push({ file: f, line: i + 1, text: l.trim() });
  });
}

// ---------------------------------------------------------------- R6 production-code guard
const isProdCode = (f) => /^(apps|packages)\/[^/]+\/src\//.test(f) && isCodeFile(f) && !isStrictTestFile(f);
const TESTING_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](@bananagig\/testing(?:\/[^'"]*)?|[^'"]*\/testing)['"]/;
for (const f of FILES.filter(isProdCode)) {
  lines(f).forEach((l, i) => {
    if (commentOnly(l)) return;
    if (TESTING_IMPORT.test(l)) add('R6', f, i + 1, 'production code imports a testing helper', l);
    if (/\ballowTestKeys\s*:\s*true\b/.test(l)) add('R6', f, i + 1, 'allowTestKeys: true literal in production code', l);
  });
}

// ---------------------------------------------------------------- R7 CODEOWNERS (informational)
const owners = FILES.find((f) => /^(\.github\/|docs\/)?CODEOWNERS$/.test(f));
note('R7', owners ?? '(none)', 0, owners ? 'CODEOWNERS present' : 'no CODEOWNERS file; add one before a ruleset requires code-owner review');

// ---------------------------------------------------------------- allowlist
let allow = { entries: [], ratchets: {} };
if (existsSync(ALLOWLIST)) {
  try {
    allow = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
  } catch (e) {
    console.error(`governance:scan: cannot parse allowlist ${ALLOWLIST}: ${e.message}`);
    process.exit(2);
  }
}
const alRel = path.relative(ROOT, ALLOWLIST) || ALLOWLIST;
const entries = (allow.entries ?? []).map((e, i) => ({ ...e, _i: i, _hits: 0 }));
const kept = [];
const expired = new Set();
const STRICT = flag('strict');
const pendingReview = (v) => typeof v === 'string' && /^PENDING\b/i.test(v.trim());
for (const e of entries) {
  if (!e.rule || !e.path || !e.justification) add('ALLOWLIST', alRel, 0, `entry #${e._i + 1} needs rule, path and justification`);
  if (!e.reviewedBy || typeof e.reviewedBy !== 'string' || !e.reviewedBy.trim())
    add('ALLOWLIST', alRel, 0, `entry #${e._i + 1} (${e.rule} ${e.path}) has no reviewedBy; an exception is not valid until a reviewer is recorded`);
  else if (STRICT && pendingReview(e.reviewedBy))
    add('ALLOWLIST', alRel, 0, `entry #${e._i + 1} (${e.rule} ${e.path}) is still "${e.reviewedBy}" (--strict requires a recorded human review)`);
  if (e.expires && e.expires < TODAY) {
    expired.add(e._i);
    add('ALLOWLIST', alRel, 0, `EXPIRED allowlist entry #${e._i + 1} (${e.rule} ${e.path}) expired ${e.expires}; renew with a new review or fix the code`);
  }
}
const matches = (e, f) => {
  if (e.rule !== f.rule || e.path !== f.file) return false;
  if (e.pattern) return new RegExp(e.pattern).test(f.lineText);
  if (e.lineContains) return f.lineText.includes(e.lineContains);
  return true; // whole-file entry for that rule
};
const capped = {}; // entries whose count was exceeded
for (const f of findings.filter((x) => x.rule !== 'ALLOWLIST')) {
  const e = entries.find((x) => !expired.has(x._i) && matches(x, f));
  if (!e) {
    kept.push(f);
    continue;
  }
  e._hits++;
  if (e.count !== undefined && e._hits > e.count) {
    capped[e._i] = true;
    kept.push({ ...f, message: `${f.message} (beyond the baseline of ${e.count} allowlisted in ${alRel} entry #${e._i + 1})` });
  }
}
for (const e of entries) {
  if (expired.has(e._i)) continue;
  if (e._hits === 0)
    add(
      'ALLOWLIST',
      alRel,
      0,
      `STALE allowlist entry #${e._i + 1} (${e.rule} ${e.path}${e.pattern ? ` /${e.pattern}/` : e.lineContains ? ` "${e.lineContains}"` : ''}) matches nothing; remove it`,
    );
  else if (e.count !== undefined && e._hits < e.count)
    note(e.rule, e.path, 0, `allowlist entry #${e._i + 1} baseline can be lowered from ${e.count} to ${e._hits}`);
}

// R5 ratchet (applied after the allowlist so its findings are never silently baselined line by line)
const r5 = allow.ratchets?.R5;
const r5max = typeof r5?.max === 'number' ? r5.max : 0;
if (passWithNoTests.length > r5max) {
  for (const p5 of passWithNoTests) {
    kept.push({
      rule: 'R5',
      file: p5.file,
      line: p5.line,
      message: `--passWithNoTests in test script (${passWithNoTests.length} found, ratchet baseline ${r5max}); a package with no tests must not pass silently`,
      lineText: p5.text,
    });
  }
} else if (passWithNoTests.length < r5max) {
  note('R5', alRel, 0, `--passWithNoTests baseline can be lowered from ${r5max} to ${passWithNoTests.length}`);
} else if (passWithNoTests.length > 0) {
  note('R5', 'package.json', 0, `${passWithNoTests.length} test scripts use --passWithNoTests (at the ratchet baseline ${r5max}; see ${alRel})`);
}
if (r5 && !(r5.justification && r5.reviewedBy)) add('ALLOWLIST', alRel, 0, 'ratchet R5 needs justification and reviewedBy');
else if (r5 && STRICT && pendingReview(r5.reviewedBy))
  add('ALLOWLIST', alRel, 0, `ratchet R5 is still "${r5.reviewedBy}" (--strict requires a recorded human review)`);

// Baseline growth: a change must not grant itself an exception. Compare with the allowlist at the base ref.
const rev = (ref) => {
  try {
    return git(['rev-parse', '--verify', '-q', `${ref}^{commit}`]).trim();
  } catch {
    return null;
  }
};
let baseRef = opt('base');
if (baseRef && !rev(baseRef)) {
  note('ALLOWLIST', alRel, 0, `--base=${baseRef} does not resolve; allowlist growth check skipped`);
  baseRef = null;
} else if (!baseRef) {
  const head = rev('HEAD');
  baseRef = rev('origin/main') && rev('origin/main') !== head ? 'origin/main' : rev('HEAD~1') ? 'HEAD~1' : null;
}
const relAllow = path.relative(ROOT, ALLOWLIST).split(path.sep).join('/');
if (baseRef && !relAllow.startsWith('..')) {
  let baseAllow = null;
  try {
    baseAllow = JSON.parse(git(['show', `${baseRef}:${relAllow}`]));
  } catch {
    note('ALLOWLIST', alRel, 0, `no allowlist at ${baseRef}: growth check skipped`);
  }
  if (baseAllow) {
    const growth = [];
    const keyOf = (e) => [e.rule, e.path, e.pattern ?? '', e.lineContains ?? ''].join('\u0000');
    const baseMap = new Map((baseAllow.entries ?? []).map((e) => [keyOf(e), e]));
    for (const e of entries) {
      const b = baseMap.get(keyOf(e));
      const label = `entry #${e._i + 1} (${e.rule} ${e.path}${e.pattern ? ` /${e.pattern}/` : e.lineContains ? ` "${e.lineContains}"` : ''})`;
      if (!b) growth.push(`new allowlist ${label} is not in ${baseRef}`);
      else if ((e.count ?? Infinity) > (b.count ?? Infinity))
        growth.push(`allowlist ${label} raises its count from ${b.count ?? 'unlimited'} to ${e.count ?? 'unlimited'} (base ${baseRef})`);
      else if (b.expires && (!e.expires || e.expires > b.expires)) growth.push(`allowlist ${label} extends or removes its expiry (base ${baseRef})`);
    }
    const bm = baseAllow.ratchets?.R5?.max;
    if (typeof bm === 'number' && r5max > bm) growth.push(`ratchet R5 max raised from ${bm} to ${r5max} (base ${baseRef})`);
    for (const g of growth) {
      if (flag('allow-baseline-growth')) note('ALLOWLIST', alRel, 0, `${g} (allowed by --allow-baseline-growth)`);
      else add('ALLOWLIST', alRel, 0, `${g}; baseline growth needs owner approval (rerun with --allow-baseline-growth once approved)`);
    }
  }
}
// Allowlist-hygiene findings (STALE/EXPIRED/incomplete) are never themselves allowlisted.
const result = [...kept, ...findings.filter((x) => x.rule === 'ALLOWLIST')];
result.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.line - b.line);

// ---------------------------------------------------------------- output
const allowlisted = entries.reduce((n, e) => n + Math.min(e._hits, e.count ?? Infinity), 0);
if (flag('json')) {
  console.log(JSON.stringify({ today: TODAY, findings: result, informational: info, allowlisted, passWithNoTests: passWithNoTests.length }, null, 2));
} else {
  const row = (r) => `${r.rule.padEnd(9)} ${(r.file + (r.line ? `:${r.line}` : '')).padEnd(60)} ${r.message}`;
  console.log(`governance:scan  files=${FILES.length}  today=${TODAY}  allowlisted=${allowlisted}`);
  if (result.length) {
    console.log(`\nFINDINGS (${result.length})`);
    console.log(`${'RULE'.padEnd(9)} ${'LOCATION'.padEnd(60)} MESSAGE`);
    result.forEach((r) => console.log(row(r)));
  }
  if (info.length) {
    console.log(`\nINFORMATIONAL (${info.length})`);
    info.forEach((r) => console.log(row(r)));
  }
  console.log(result.length ? `\ngovernance:scan FAILED: ${result.length} finding(s)` : '\ngovernance:scan OK: 0 findings');
}
process.exit(result.length ? 1 : 0);

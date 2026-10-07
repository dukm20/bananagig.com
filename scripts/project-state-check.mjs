// Validates the project-knowledge documents and their consistency with the repository.
//   node scripts/project-state-check.mjs [<CHECKPOINT_ID>] [--base=<ref>]
// With a checkpoint id it also requires that checkpoint's knowledge updates (state, history, git-diff rules).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  Report,
  adrFiles,
  changedSince,
  exists,
  explicitBaseProblem,
  isGitRepo,
  isoDate,
  migrationFiles,
  p,
  parseArgs,
  read,
  root,
  sections,
} from './lib/governance.mjs';

const { positional, flag } = parseArgs(process.argv.slice(2));
const checkpoint = positional[0];
const base = flag('base') || 'HEAD';
const r = new Report('project-state:check');
const badBase = explicitBaseProblem(flag('base'));
if (badBase) {
  r.fail(badBase);
  r.finish();
}

const FILES = [
  'CLAUDE.md',
  'docs/project/PROJECT_STATE.md',
  'docs/project/IMPLEMENTATION_HISTORY.md',
  'docs/project/LEARNINGS.md',
  'docs/project/TECH_DEBT.md',
  'docs/engineering/COMMIT_POLICY.md',
];
for (const f of FILES) if (!exists(f)) r.fail(`missing ${f}`);
if (r.errors.length) r.finish();

// ---- PROJECT_STATE: current-truth fields consistent with the repo ----
const state = read('docs/project/PROJECT_STATE.md');
const field = (name) => state.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim();
for (const f of ['Current checkpoint', 'Last completed checkpoint', 'Next approved checkpoint', 'Latest migration', 'Latest ADR', 'Last updated'])
  if (!field(f)) r.fail(`PROJECT_STATE.md is missing the "${f}:" line`);
for (const h of [
  'Applications',
  'Infrastructure',
  'Database schemas',
  'External integrations',
  'Active feature flags',
  'Completed capabilities',
  'Partially implemented capabilities',
  'Known blockers',
  'Test counts',
]) {
  if (!sections(state, 2).some((s) => s.title === h)) r.fail(`PROJECT_STATE.md is missing the "## ${h}" section`);
}
const mig = migrationFiles();
if (field('Latest migration') && mig.length && !field('Latest migration').startsWith(mig[mig.length - 1]))
  r.fail(`PROJECT_STATE.md latest migration "${field('Latest migration')}" != actual ${mig[mig.length - 1]}`);
const adrs = adrFiles();
if (field('Latest ADR') && adrs.length && !field('Latest ADR').startsWith(adrs[adrs.length - 1].slice(0, 8)))
  r.fail(`PROJECT_STATE.md latest ADR "${field('Latest ADR')}" != actual ${adrs[adrs.length - 1].slice(0, 8)}`);
if (/^#{2,3} (history|changelog)/im.test(state)) r.fail('PROJECT_STATE.md must contain current state only; history belongs in IMPLEMENTATION_HISTORY.md');

// ---- IMPLEMENTATION_HISTORY ----
const history = read('docs/project/IMPLEMENTATION_HISTORY.md');
const entries = sections(history, 2);
const ids = entries.map((e) => e.title.split(' — ')[0]);
if (new Set(ids).size !== ids.length) r.fail('IMPLEMENTATION_HISTORY.md has duplicate checkpoint entries (append-only; correct in place instead)');
for (const e of entries) {
  if (!isoDate.test(e.title)) r.fail(`IMPLEMENTATION_HISTORY.md "${e.title}": heading must be "## <checkpoint> — <YYYY-MM-DD>"`);
  for (const h of [
    'Status:',
    'Commit:',
    'Summary:',
    '### Delivered',
    '### Schema',
    '### Contracts',
    '### Tests',
    '### Skills updated',
    '### ADRs',
    '### Known follow-up',
  ])
    if (!e.body.includes(h)) r.fail(`IMPLEMENTATION_HISTORY.md "${e.title}": missing "${h}"`);
}
const last = field('Last completed checkpoint');
if (last && !ids.includes(last)) r.fail(`PROJECT_STATE.md says "${last}" was completed but IMPLEMENTATION_HISTORY.md has no entry for it`);

// ---- LEARNINGS ----
const learnings = sections(read('docs/project/LEARNINGS.md'), 2).filter((s) => /^LRN-\d{4}\b/.test(s.title));
const lrnIds = learnings.map((l) => l.title.slice(0, 8));
if (new Set(lrnIds).size !== lrnIds.length) r.fail('LEARNINGS.md has duplicate LRN ids');
const supersedes = new Set(learnings.flatMap((l) => [...(l.body.match(/^Supersedes:\s*(.+)$/m)?.[1] ?? '').matchAll(/LRN-\d{4}/g)].map((m) => m[0])));
for (const l of learnings) {
  const id = l.title.slice(0, 8);
  for (const h of [
    'Date:',
    'Checkpoint:',
    'Domain:',
    'Status:',
    'Supersedes:',
    'Related ADR:',
    'Related skill:',
    '### Context',
    '### Learning',
    '### Why it matters',
    '### Reuse rule',
    '### Evidence',
  ])
    if (!l.body.includes(h)) r.fail(`LEARNINGS.md ${id}: missing "${h}"`);
  const st = l.body.match(/^Status:\s*(\S+)/m)?.[1];
  if (!['ACTIVE', 'SUPERSEDED'].includes(st)) r.fail(`LEARNINGS.md ${id}: Status must be ACTIVE or SUPERSEDED`);
  if (st === 'SUPERSEDED' && !supersedes.has(id)) r.fail(`LEARNINGS.md ${id}: marked SUPERSEDED but no ACTIVE entry names it in "Supersedes:"`);
  for (const m of (l.body.match(/^Related ADR:\s*(.+)$/m)?.[1] ?? '').matchAll(/ADR-\d{4}/g))
    if (!adrs.some((a) => a.startsWith(m[0]))) r.fail(`LEARNINGS.md ${id}: broken ADR link ${m[0]}`);
  const skill = (l.body.match(/^Related skill:\s*(.+)$/m)?.[1] ?? '').trim();
  if (skill && !/^none$/i.test(skill) && !exists(skill)) r.fail(`LEARNINGS.md ${id}: related skill path does not exist: ${skill}`);
}

// ---- TECH_DEBT ----
const debtDoc = read('docs/project/TECH_DEBT.md');
const debts = sections(debtDoc, 2).filter((s) => /^DEBT-\d{4}\b/.test(s.title));
const debtIds = new Set(debts.map((d) => d.title.slice(0, 9)));
if (debtIds.size !== debts.length) r.fail('TECH_DEBT.md has duplicate DEBT ids');
for (const d of debts) {
  const id = d.title.slice(0, 9);
  for (const h of ['Status:', 'Severity:', 'Introduced by:', 'Owner/domain:', 'Description:', 'Why deferred:', 'Exit criteria:', 'Target checkpoint:'])
    if (!d.body.includes(h)) r.fail(`TECH_DEBT.md ${id}: missing "${h}"`);
  const st = d.body.match(/^Status:\s*(\S+)/m)?.[1];
  if (!['OPEN', 'IN_PROGRESS', 'ACCEPTED', 'RESOLVED', 'SUPERSEDED'].includes(st))
    r.fail(`TECH_DEBT.md ${id}: Status must be OPEN, IN_PROGRESS, ACCEPTED, RESOLVED or SUPERSEDED`);
}
// every DEBT reference in code/docs must exist
function* walk(dir) {
  for (const n of readdirSync(dir)) {
    if (['node_modules', '.git', 'dist', '.next', '.turbo', '.checkpoint'].includes(n)) continue;
    const full = path.join(dir, n);
    const s = statSync(full);
    if (s.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|mjs|js|md|yaml|yml|json)$/.test(n) && s.size < 500_000 && n !== 'pnpm-lock.yaml') yield full;
  }
}
for (const dir of ['apps', 'packages', 'docs', 'scripts', 'skills', 'infra']) {
  if (!exists(dir)) continue;
  for (const f of walk(p(dir))) {
    const rel = path.relative(root(), f);
    if (rel === 'docs/project/TECH_DEBT.md' || rel.startsWith('scripts/governance')) continue;
    for (const m of readFileSync(f, 'utf8').matchAll(/DEBT-\d{4}/g))
      if (!debtIds.has(m[0])) r.fail(`${rel}: references ${m[0]} which is not defined in TECH_DEBT.md`);
  }
}

// ---- checkpoint-specific, git-diff based rules ----
if (checkpoint) {
  if (!ids.includes(checkpoint)) r.fail(`IMPLEMENTATION_HISTORY.md has no entry for ${checkpoint} (append one before finalizing)`);
  if (last !== checkpoint) r.fail(`PROJECT_STATE.md "Last completed checkpoint" is "${last}", expected ${checkpoint}`);
  const changes = isGitRepo() ? changedSince(base) : null;
  if (changes) {
    const touched = (f) => changes.has(f);
    const codeChanged = [...changes.keys()].some((f) => /^(apps|packages|db\/migrations|infra)\//.test(f) || /^(compose.*\.yaml|Dockerfile)$/.test(f));
    if (codeChanged && !touched('docs/project/PROJECT_STATE.md'))
      r.fail('application/infrastructure files changed but docs/project/PROJECT_STATE.md was not updated');
    if (!touched('docs/project/IMPLEMENTATION_HISTORY.md')) r.fail('docs/project/IMPLEMENTATION_HISTORY.md was not updated for this checkpoint');
  } else r.note('no base commit yet (baseline): git-diff rules skipped');
}
r.note(`${entries.length} history entr${entries.length === 1 ? 'y' : 'ies'}, ${learnings.length} learning(s), ${debts.length} debt item(s)`);
r.finish();

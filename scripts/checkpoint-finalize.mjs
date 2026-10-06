// pnpm checkpoint:finalize <CHECKPOINT_ID> --skill-update=UPDATED|NOT_REQUIRED [--base=<ref>]
// Validates (never fabricates) the checkpoint's required artifacts. Exit 1 on any failure; never commits.
import { mkdirSync, writeFileSync } from 'node:fs';
import { changedSince, git, isGitRepo, p, parseArgs, run, treeFingerprint } from './lib/governance.mjs';

const { positional, flag } = parseArgs(process.argv.slice(2));
const id = positional[0];
const base = flag('base') || 'HEAD';
const skillUpdate = flag('skill-update');
const die = (m) => {
  console.error(`checkpoint:finalize: ${m}`);
  process.exit(1);
};
if (!id || !/^[A-Z]{2,5}-\d{3}$/.test(id)) die('usage: pnpm checkpoint:finalize <CHECKPOINT_ID> --skill-update=UPDATED|NOT_REQUIRED');
if (!['UPDATED', 'NOT_REQUIRED'].includes(skillUpdate))
  die('--skill-update=UPDATED|NOT_REQUIRED is required: state explicitly whether this checkpoint created reusable knowledge (SKILL_UPDATE)');
if (!isGitRepo()) die('not a git repository');

const before = treeFingerprint();
const steps = [
  ['format', 'pnpm', ['format:check']],
  ['lint', 'pnpm', ['lint']],
  ['typecheck', 'pnpm', ['typecheck']],
  ['unit tests', 'pnpm', ['test']],
  ['integration tests', 'pnpm', ['test:integration']],
  ['workspace boundaries', 'pnpm', ['deps:check']],
  ['spec drift (OpenAPI/AsyncAPI)', 'pnpm', ['specs:check']],
  ['OpenAPI validation', 'pnpm', ['openapi:lint']],
  ['AsyncAPI validation', 'pnpm', ['asyncapi:validate']],
  ['migrations + schema snapshot + data model', 'node', ['scripts/data-model-check.mjs', id, `--base=${base}`]],
  ['skills + ADRs', 'node', ['scripts/skills-check.mjs']],
  ['project state', 'node', ['scripts/project-state-check.mjs', id, `--base=${base}`]],
];

const results = [];
for (const [name, cmd, args] of steps) {
  process.stdout.write(`▶ ${name} ... `);
  const r = run(cmd, args);
  results.push({ name, ok: r.ok, seconds: +(r.ms / 1000).toFixed(1), detail: r.ok ? '' : r.out.trim().split('\n').slice(-12).join('\n') });
  console.log(r.ok ? `ok (${(r.ms / 1000).toFixed(1)}s)` : 'FAILED');
}

// SKILL_UPDATE must be consistent with the working tree.
const changes = changedSince(base);
const touched = (re) => (changes ? [...changes.keys()].some((f) => re.test(f)) : null);
let skillOk = true;
let skillDetail = '';
if (skillUpdate === 'UPDATED' && changes && !touched(/^skills\/.+\/SKILL\.md$/)) {
  skillOk = false;
  skillDetail = 'SKILL_UPDATE=UPDATED but no skills/*/SKILL.md changed relative to the base';
}
results.push({ name: `SKILL_UPDATE declared (${skillUpdate})`, ok: skillOk, seconds: 0, detail: skillDetail });

const after = treeFingerprint();
const stable = before === after;
results.push({
  name: 'working tree unchanged by checks',
  ok: stable,
  seconds: 0,
  detail: stable ? '' : 'files changed while checks ran (formatters/generators?). Review and re-run.',
});

const yn = (v) => (v === null ? 'n/a (baseline, no base commit)' : v ? 'UPDATED' : 'NOT_REQUIRED/NOT_CHANGED');
console.log('\n=== Finalization report ===');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.seconds ? `  (${r.seconds}s)` : ''}`);
console.log('\nDetected changes vs base (informational; the completion report must still state each item):');
console.log(`  Project state:           ${yn(touched(/^docs\/project\/PROJECT_STATE\.md$/))}`);
console.log(`  Implementation history:  ${yn(touched(/^docs\/project\/IMPLEMENTATION_HISTORY\.md$/))}`);
console.log(`  Learnings:               ${yn(touched(/^docs\/project\/LEARNINGS\.md$/))}`);
console.log(
  `  Skills:                  ${skillUpdate}${skillUpdate === 'NOT_REQUIRED' ? '  -> the completion report must explain why no skill needed updating' : ''}`,
);
console.log(`  ADRs:                    ${yn(touched(/^docs\/architecture\/ADR-/))}`);
console.log(`  Data model docs:         ${yn(touched(/^docs\/data\/(DATA_MODEL|DATA_DICTIONARY|ERD|SCHEMA_SNAPSHOT)/))}`);
console.log(`  Normalization log:       ${yn(touched(/^docs\/data\/NORMALIZATION_LOG\.md$/))}`);
console.log(`  Technical debt:          ${yn(touched(/^docs\/project\/TECH_DEBT\.md$/))}`);

const failed = results.filter((r) => !r.ok);
const out = {
  id,
  passed: failed.length === 0,
  fingerprint: after,
  base,
  headAtFinalize: git(['rev-parse', '-q', '--verify', 'HEAD'], { allowFail: true })?.trim() ?? null,
  skillUpdate,
  finishedAt: new Date().toISOString(),
  steps: results,
};
mkdirSync(p('.checkpoint'), { recursive: true });
writeFileSync(p('.checkpoint', `${id}.finalize.json`), JSON.stringify(out, null, 2) + '\n');
if (failed.length) {
  console.error(`\nFINALIZE FAILED (${failed.length} of ${results.length} checks). Nothing was committed.`);
  for (const f of failed) console.error(`\n--- ${f.name} ---\n${f.detail}`);
  process.exit(1);
}
console.log(`\nFINALIZE PASSED. Next: pnpm checkpoint:commit ${id} "<type>(${id}): <description>"`);

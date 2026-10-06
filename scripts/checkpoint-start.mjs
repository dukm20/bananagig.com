// pnpm checkpoint:start <CHECKPOINT_ID>
// Verifies a clean working tree, shows current project state, the latest migration and relevant open debt,
// and records a local (git-ignored) checkpoint context. Never modifies product state and never commits.
import { mkdirSync, writeFileSync } from 'node:fs';
import { exists, hasHead, git, isGitRepo, migrationFiles, p, parseArgs, read, sections, status } from './lib/governance.mjs';

const { positional } = parseArgs(process.argv.slice(2));
const id = positional[0];
const die = (m) => {
  console.error(`checkpoint:start: ${m}`);
  process.exit(1);
};
if (!id) die('usage: pnpm checkpoint:start <CHECKPOINT_ID>   (e.g. BAN-001)');
if (!/^[A-Z]{2,5}-\d{3}$/.test(id)) die(`invalid checkpoint id "${id}" (expected like INF-003, BAN-001)`);
if (!isGitRepo()) die('not a git repository');

const baseline = !hasHead();
const dirty = status();
if (baseline) {
  console.log('NOTE: repository has no commits yet (baseline mode). The clean-tree rule cannot be evaluated until a first commit exists.');
} else if (dirty.length) {
  console.error('checkpoint:start: working tree is not clean. Commit or stash these changes first:');
  for (const d of dirty.slice(0, 30)) console.error(`  ${d.code} ${d.file}`);
  if (dirty.length > 30) console.error(`  ... and ${dirty.length - 30} more`);
  process.exit(1);
}

console.log(`\n=== Starting checkpoint ${id} ===\n`);
if (exists('docs/project/PROJECT_STATE.md')) {
  const state = read('docs/project/PROJECT_STATE.md');
  console.log('--- PROJECT_STATE (key fields) ---');
  for (const f of ['Current checkpoint', 'Last completed checkpoint', 'Next approved checkpoint', 'Latest migration', 'Latest ADR', 'Last updated']) {
    console.log(`${f}: ${state.match(new RegExp(`^${f}:\\s*(.+)$`, 'm'))?.[1] ?? '(missing)'}`);
  }
  const blockers = sections(state, 2).find((s) => s.title === 'Known blockers');
  if (blockers) console.log(`Known blockers:${blockers.body.trimEnd()}`);
  console.log('Read the full file: docs/project/PROJECT_STATE.md');
} else console.log('docs/project/PROJECT_STATE.md is missing');

const mig = migrationFiles();
console.log(`\n--- Latest migration ---\n${mig.length ? mig[mig.length - 1] : '(none)'}  (${mig.length} total)`);

if (exists('docs/project/TECH_DEBT.md')) {
  const prefix = id.split('-')[0];
  const open = sections(read('docs/project/TECH_DEBT.md'), 2).filter((s) => /^DEBT-\d{4}/.test(s.title) && /^Status:\s*(OPEN|IN_PROGRESS)/m.test(s.body));
  const relevant = open.filter((s) => new RegExp(`Target checkpoint:.*(${id}|${prefix}-)`, 'm').test(s.body) || /^Severity:\s*(HIGH|CRITICAL)/m.test(s.body));
  console.log(`\n--- Open technical debt (${open.length} open; ${relevant.length} relevant to ${id}) ---`);
  for (const d of relevant)
    console.log(`${d.title}  [${d.body.match(/^Severity:\s*(\S+)/m)?.[1]}]  target: ${d.body.match(/^Target checkpoint:\s*(.+)$/m)?.[1]}`);
  if (!relevant.length) console.log('(none targeted at this checkpoint)');
}

console.log('\nBefore coding: read CLAUDE.md, the relevant skills/*/SKILL.md, relevant ADRs, and docs/data/DATA_MODEL.md for persistence work.');
mkdirSync(p('.checkpoint'), { recursive: true });
writeFileSync(
  p('.checkpoint', `${id}.start.json`),
  JSON.stringify({ id, startedAt: new Date().toISOString(), baseHead: baseline ? null : git(['rev-parse', 'HEAD']).trim(), baselineMode: baseline }, null, 2) +
    '\n',
);
console.log(`\nContext recorded in .checkpoint/${id}.start.json (git-ignored). Nothing was committed.`);

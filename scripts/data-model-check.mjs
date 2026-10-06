// Data-model review gate. Fails when schema documentation is stale or a schema-changing checkpoint skipped its review.
//   node scripts/data-model-check.mjs [<CHECKPOINT_ID>] [--base=<git ref>] [--snapshot=<file>]
// --snapshot supplies a pre-generated snapshot (tests/CI); otherwise one is generated from db/migrations in a scratch database.
import { readFileSync } from 'node:fs';
import { snapshotFromMigrations, SNAPSHOT_PATH } from './schema-snapshot.mjs';
import { Report, changedSince, exists, isGitRepo, migrationFiles, parseArgs, read, run, sections, showAt } from './lib/governance.mjs';

const { positional, flag } = parseArgs(process.argv.slice(2));
const checkpoint = positional[0];
const base = flag('base') || 'HEAD';
const r = new Report('data-model:check');

const REQUIRED_DOCS = [
  'docs/data/DATA_MODEL.md',
  'docs/data/DATA_MODEL_CHANGELOG.md',
  'docs/data/DATA_DICTIONARY.md',
  'docs/data/ERD.md',
  'docs/data/NORMALIZATION_LOG.md',
  'docs/data/DATA_MODEL_GUARDRAILS.md',
];
for (const d of REQUIRED_DOCS) if (!exists(d)) r.fail(`missing ${d}`);
if (r.errors.length) r.finish();

// ---- 1. migrations: numbering and immutability ----
const migrations = migrationFiles();
migrations.forEach((f, i) => {
  if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(f)) r.fail(`migration name must be NNNN_snake_case.sql: ${f}`);
  else if (Number(f.slice(0, 4)) !== i + 1) r.fail(`migration numbering must be contiguous from 0001; found ${f} at position ${i + 1}`);
});
const changes = isGitRepo() ? changedSince(base) : null;
const baselineMode = changes === null; // no commit to compare against yet
const migChanges = [...(changes ?? new Map())].filter(([f]) => f.startsWith('db/migrations/'));
for (const [f, s] of migChanges)
  if (s !== 'A') r.fail(`applied migration was modified or removed (${s}): ${f}. Never edit an applied migration; add a new one.`);
const newMigrations = migChanges.filter(([, s]) => s === 'A').map(([f]) => f.split('/').pop());

// ---- 2. snapshot freshness ----
let generated;
try {
  generated = flag('snapshot') ? readFileSync(flag('snapshot'), 'utf8') : await snapshotFromMigrations();
} catch (e) {
  r.fail(`could not produce a schema snapshot (is local PostgreSQL running? pnpm dev:deps): ${e.message.split('\n')[0]}`);
  r.finish();
}
const committed = exists(SNAPSHOT_PATH) ? read(SNAPSHOT_PATH) : '';
if (committed !== generated) r.fail(`${SNAPSHOT_PATH} is stale (it does not match the schema produced by db/migrations). Run: pnpm schema:snapshot --write`);

// ---- 3. documentation covers every application table (always checked) ----
const tables = [...generated.matchAll(/^CREATE TABLE ([a-z0-9_]+\.[a-z0-9_]+) \(/gm)].map((m) => m[1]);
const dataModel = read('docs/data/DATA_MODEL.md');
const dictionary = read('docs/data/DATA_DICTIONARY.md');
for (const t of tables) {
  if (!dataModel.includes(t)) r.fail(`DATA_MODEL.md does not mention table ${t}`);
  if (!new RegExp(`^### ${t.replace('.', '\\.')}\\s*$`, 'm').test(dictionary)) r.fail(`DATA_DICTIONARY.md has no "### ${t}" section`);
}

// ---- 4. schema-changing checkpoint review ----
let schemaChanged = false;
let fkChanged = false;
if (!baselineMode) {
  const prev = showAt(base, SNAPSHOT_PATH) ?? '';
  schemaChanged = prev !== generated || newMigrations.length > 0;
  const fks = (s) =>
    s
      .split('\n')
      .filter((l) => /FOREIGN KEY/.test(l))
      .sort()
      .join('\n');
  fkChanged = fks(prev) !== fks(generated);
}
if (schemaChanged) {
  if (!checkpoint) r.fail('schema changed: pass the checkpoint id (pnpm data-model:check <ID>) so the review entries can be verified');
  const touched = (f) => changes.has(f);
  if (!newMigrations.length) r.fail('schema snapshot changed but no new migration was added');
  for (const f of ['docs/data/DATA_MODEL.md', 'docs/data/DATA_MODEL_CHANGELOG.md', 'docs/data/DATA_DICTIONARY.md', 'docs/data/NORMALIZATION_LOG.md']) {
    if (!touched(f)) r.fail(`schema changed but ${f} was not updated`);
  }
  if (fkChanged && !touched('docs/data/ERD.md')) r.fail('relationships (foreign keys) changed but docs/data/ERD.md was not updated');
  if (checkpoint) {
    const norm = sections(read('docs/data/NORMALIZATION_LOG.md'), 2).find((s) => s.title.startsWith(checkpoint));
    if (!norm) r.fail(`NORMALIZATION_LOG.md has no "## ${checkpoint}" entry`);
    else {
      for (const h of [
        'Tables reviewed:',
        '### 1NF',
        '### 2NF',
        '### 3NF',
        '### BCNF',
        '### Duplicate concepts examined',
        '### Derived fields examined',
        '### Intentional denormalization',
        '### Index review',
        '### Final decision',
      ]) {
        if (!norm.body.includes(h)) r.fail(`NORMALIZATION_LOG.md "${checkpoint}" entry is missing "${h}"`);
      }
    }
    const log = sections(read('docs/data/DATA_MODEL_CHANGELOG.md'), 2).find((s) => s.title.startsWith(checkpoint));
    if (!log) r.fail(`DATA_MODEL_CHANGELOG.md has no "## ${checkpoint}" entry`);
    else
      for (const h of [
        'Migration:',
        'Added:',
        'Changed:',
        'Removed:',
        'Renamed:',
        'Relationships:',
        'Constraints:',
        'Indexes:',
        'Backfill:',
        'Compatibility:',
        'Rollback:',
        'Reason:',
      ])
        if (!log.body.includes(h)) r.fail(`DATA_MODEL_CHANGELOG.md "${checkpoint}" entry is missing "${h}"`);
    for (const m of newMigrations) if (log && !log.body.includes(m)) r.fail(`DATA_MODEL_CHANGELOG.md "${checkpoint}" entry does not name migration ${m}`);
  }
} else if (!baselineMode) {
  r.note('schema unchanged: no data-model documentation changes required');
}
if (baselineMode) r.note('no base commit yet (baseline): git-diff rules skipped; snapshot and documentation coverage still enforced');

// ---- 5. database-side checksum guard (applied migrations unchanged), when a database is reachable ----
if (!flag('snapshot') && !flag('no-db')) {
  const m = run('node', [`${import.meta.dirname}/migrate.mjs`, '--check']);
  if (!m.ok)
    r.fail(
      `migration validation against the local database failed: ${m.out.split('\n').find((l) => /modified|ECONN|error/i.test(l)) ?? m.out.trim().slice(0, 200)}`,
    );
}
r.finish();

// Tests for the governance scripts. Each test builds a scratch git repository and runs the REAL scripts against it
// (cwd = scratch repo), so behaviour such as "edited migration is rejected" is proven, not assumed.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });
const REPO = process.cwd();
const script = (n) => path.join(REPO, 'scripts', n);
const scratch = [];

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
}
function node(cwd, name, args = []) {
  const r = spawnSync('node', [script(name), ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
function write(root, rel, content) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), content);
}
function repo(files = {}, { commit = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'bg-gov-'));
  scratch.push(root);
  sh(root, 'git', ['init', '-q', '-b', 'main']);
  sh(root, 'git', ['config', 'user.email', 't@example.com']);
  sh(root, 'git', ['config', 'user.name', 'Test']);
  write(root, '.gitignore', '.checkpoint\nnode_modules\n.env\n');
  for (const [f, c] of Object.entries(files)) write(root, f, c);
  if (commit) {
    sh(root, 'git', ['add', '-A']);
    sh(root, 'git', ['commit', '-q', '-m', 'chore(TST-001): baseline']);
  }
  return root;
}
afterAll(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));

// ---------------------------------------------------------------- data-model-check
const HDR = '-- checkpoint: T\n-- purpose: t\n-- rollback strategy: t\n-- backfill: t\n-- risk: t\n';
const SNAP_EMPTY = '-- header\n\n-- (no application tables)\n';
const SNAP_BOOKING = `${SNAP_EMPTY}\nCREATE TABLE booking.reservation (\n  id uuid NOT NULL,\n  CONSTRAINT reservation_pkey PRIMARY KEY (id)\n);\n`;
const dmDocs = (extra = {}) => ({
  'docs/data/DATA_MODEL.md': '# Data model\n',
  'docs/data/DATA_MODEL_CHANGELOG.md': '# Changelog\n',
  'docs/data/DATA_DICTIONARY.md': '# Dictionary\n',
  'docs/data/ERD.md': '# ERD\n',
  'docs/data/NORMALIZATION_LOG.md': '# Normalization\n',
  'docs/data/DATA_MODEL_GUARDRAILS.md': '# Guardrails\n',
  'docs/data/SCHEMA_SNAPSHOT.sql': SNAP_EMPTY,
  'db/migrations/0001_init.sql': 'SELECT 1;\n',
  ...extra,
});
const dm = (root, snapshot, args = []) => {
  write(root, '.snap', snapshot);
  return node(root, 'data-model-check.mjs', [...args, `--snapshot=${path.join(root, '.snap')}`, '--no-db']);
};
const NORM = (id) =>
  `\n## ${id}\n\nTables reviewed: booking.reservation\n\n### 1NF\nPASS\n### 2NF\nPASS\n### 3NF\nPASS\n### BCNF\nPASS\n### Duplicate concepts examined\nnone\n### Derived fields examined\nnone\n### Intentional denormalization\nnone\n### Index review\npk only\n### Final decision\nok\n`;
const CHG = (id, mig) =>
  `\n## ${id}\n\nMigration: ${mig}\nAdded: booking.reservation\nChanged: none\nRemoved: none\nRenamed: none\n\nRelationships: none\n\nConstraints: pk\n\nIndexes: pk\n\nBackfill: none\n\nCompatibility: new\n\nRollback: drop\n\nReason: test\n`;

describe('data-model:check', () => {
  it('passes when schema and documentation agree and nothing changed', () => {
    const r = repo(dmDocs());
    const out = dm(r, SNAP_EMPTY, ['TST-002']);
    expect(out.code).toBe(0);
    expect(out.out).toContain('no data-model documentation changes required');
  });

  it('detects stale model documentation (table in schema but not in DATA_MODEL/DICTIONARY)', () => {
    const r = repo(dmDocs({ 'docs/data/SCHEMA_SNAPSHOT.sql': SNAP_BOOKING }));
    const out = dm(r, SNAP_BOOKING, ['TST-002']);
    expect(out.code).toBe(1);
    expect(out.out).toContain('DATA_MODEL.md does not mention table booking.reservation');
    expect(out.out).toContain('DATA_DICTIONARY.md has no "### booking.reservation" section');
  });

  it('detects a stale committed schema snapshot', () => {
    const r = repo(dmDocs());
    const out = dm(r, SNAP_BOOKING, ['TST-002']);
    expect(out.code).toBe(1);
    expect(out.out).toContain('SCHEMA_SNAPSHOT.sql is stale');
  });

  it('rejects modification of an applied migration', () => {
    const r = repo(dmDocs());
    write(r, 'db/migrations/0001_init.sql', 'SELECT 2; -- edited\n');
    const out = dm(r, SNAP_EMPTY, ['TST-002']);
    expect(out.code).toBe(1);
    expect(out.out).toContain('applied migration was modified or removed');
    expect(out.out).toContain('db/migrations/0001_init.sql');
  });

  it('rejects deletion and non-contiguous numbering of migrations', () => {
    const r = repo(dmDocs());
    write(r, 'db/migrations/0003_gap.sql', 'SELECT 1;\n');
    expect(dm(r, SNAP_EMPTY, ['TST-002']).out).toContain('contiguous');
    rmSync(path.join(r, 'db/migrations/0001_init.sql'));
    expect(dm(r, SNAP_EMPTY, ['TST-002']).out).toContain('modified or removed (D)');
  });

  it('requires header comments on new migrations and a marker on destructive statements', () => {
    const r = repo(dmDocs());
    write(r, 'db/migrations/0002_nohdr.sql', 'SELECT 1;\n');
    expect(dm(r, SNAP_EMPTY, ['TST-002']).out).toContain('missing header comment "-- purpose: <text>"');
    write(r, 'db/migrations/0002_nohdr.sql', `${HDR}DROP TABLE old_things;\n`);
    expect(dm(r, SNAP_EMPTY, ['TST-002']).out).toContain('destructive statement');
    write(r, 'db/migrations/0002_nohdr.sql', `${HDR}-- destructive: contract phase, verified in TST-001\nDROP TABLE old_things;\n`);
    expect(dm(r, SNAP_EMPTY, ['TST-002']).out).not.toContain('destructive statement');
  });

  it('requires the full model review (docs, changelog, normalization, dictionary) when the schema changes', () => {
    const r = repo(dmDocs());
    write(r, 'db/migrations/0002_booking.sql', `${HDR}CREATE SCHEMA booking;\n`);
    write(r, 'docs/data/SCHEMA_SNAPSHOT.sql', SNAP_BOOKING);
    const out = dm(r, SNAP_BOOKING, ['TST-002']);
    expect(out.code).toBe(1);
    for (const f of ['DATA_MODEL.md', 'DATA_MODEL_CHANGELOG.md', 'DATA_DICTIONARY.md', 'NORMALIZATION_LOG.md'])
      expect(out.out).toContain(`${f} was not updated`);
  });

  it('makes the normalization review mandatory and checks its structure', () => {
    const r = repo(dmDocs());
    write(r, 'db/migrations/0002_booking.sql', `${HDR}CREATE SCHEMA booking;\n`);
    write(r, 'docs/data/SCHEMA_SNAPSHOT.sql', SNAP_BOOKING);
    write(r, 'docs/data/DATA_MODEL.md', '# Data model\n\nbooking.reservation\n');
    write(r, 'docs/data/DATA_DICTIONARY.md', '# Dictionary\n\n### booking.reservation\n\nrows\n');
    write(r, 'docs/data/DATA_MODEL_CHANGELOG.md', `# Changelog\n${CHG('TST-002', '0002_booking.sql')}`);
    write(r, 'docs/data/NORMALIZATION_LOG.md', '# Normalization\n\n## TST-002\n\nTables reviewed: booking.reservation\n\n### 1NF\nPASS\n');
    const out = dm(r, SNAP_BOOKING, ['TST-002']);
    expect(out.code).toBe(1);
    expect(out.out).toContain('missing "### 2NF"');
    expect(out.out).toContain('missing "### Final decision"');
  });

  it('passes when the schema changed and the whole review is present', () => {
    const r = repo(dmDocs());
    write(r, 'db/migrations/0002_booking.sql', `${HDR}CREATE SCHEMA booking;\n`);
    write(r, 'docs/data/SCHEMA_SNAPSHOT.sql', SNAP_BOOKING);
    write(r, 'docs/data/DATA_MODEL.md', '# Data model\n\nbooking.reservation\n');
    write(r, 'docs/data/DATA_DICTIONARY.md', '# Dictionary\n\n### booking.reservation\n\nrows\n');
    write(r, 'docs/data/DATA_MODEL_CHANGELOG.md', `# Changelog\n${CHG('TST-002', '0002_booking.sql')}`);
    write(r, 'docs/data/NORMALIZATION_LOG.md', `# Normalization\n${NORM('TST-002')}`);
    const out = dm(r, SNAP_BOOKING, ['TST-002']);
    expect(out.out).toBe('data-model:check: OK\n');
    expect(out.code).toBe(0);
  });

  it('requires the ERD to change when a foreign key changes', () => {
    const snapFk = `${SNAP_BOOKING}\nCREATE TABLE booking.item (\n  id uuid NOT NULL,\n  reservation_id uuid NOT NULL,\n  CONSTRAINT item_pkey PRIMARY KEY (id),\n  CONSTRAINT item_fk FOREIGN KEY (reservation_id) REFERENCES booking.reservation(id)\n);\n`;
    const r = repo(
      dmDocs({
        'docs/data/SCHEMA_SNAPSHOT.sql': SNAP_BOOKING,
        'docs/data/DATA_MODEL.md': 'booking.reservation\n',
        'docs/data/DATA_DICTIONARY.md': '### booking.reservation\n',
      }),
    );
    write(r, 'db/migrations/0002_item.sql', `${HDR}SELECT 1;\n`);
    write(r, 'docs/data/SCHEMA_SNAPSHOT.sql', snapFk);
    write(r, 'docs/data/DATA_MODEL.md', 'booking.reservation booking.item\n');
    write(r, 'docs/data/DATA_DICTIONARY.md', '### booking.reservation\n\n### booking.item\n');
    write(r, 'docs/data/DATA_MODEL_CHANGELOG.md', CHG('TST-003', '0002_item.sql'));
    write(r, 'docs/data/NORMALIZATION_LOG.md', NORM('TST-003'));
    const out = dm(r, snapFk, ['TST-003']);
    expect(out.code).toBe(1);
    expect(out.out).toContain('ERD.md was not updated');
  });
});

// ---------------------------------------------------------------- skills-check
const skill = (over = {}) => {
  const secs = {
    Purpose: 'Do things properly in this domain with care.',
    'When to use': 'When changing the domain.',
    'Canonical files': '- `docs/a.md`',
    'Architecture rules': '- Follow the rules documented in the ADR carefully.',
    'Implementation pattern': '1. Do the thing.\n2. Test the thing.',
    Commands: '```bash\npnpm test\n```',
    'Testing requirements': '- Unit tests for everything you touch, plus regression tests.',
    'Data-model considerations': 'None beyond the database skill process.',
    'Common failure modes': '- Forgetting the thing that always gets forgotten.',
    'Known BananaGig-specific lessons': '- LRN-0001 style lesson: pair versions together.',
    'Do not': '- Do not skip the checks.',
    'Related ADRs': 'ADR-0001',
    'Last reviewed': '2026-10-05',
    ...over,
  };
  return `# Demo\n\n${Object.entries(secs)
    .map(([h, b]) => `## ${h}\n\n${b}\n`)
    .join('\n')}\n${'Filler sentence to exceed the placeholder length threshold. '.repeat(10)}\n`;
};
const ADR =
  '# ADR-0001 — Demo\n\nStatus: ACCEPTED\nDate: 2026-10-05\nCheckpoint: TST-001\n\n## Context\nx\n## Decision\nx\n## Alternatives considered\nx\n## Consequences\nx\n## Migration / compatibility\nx\n## Related files\n- `docs/a.md`\n';
const skillRepo = (s = skill(), extra = {}) =>
  repo({ 'skills/demo/SKILL.md': s, 'docs/a.md': 'a', 'docs/architecture/ADR-0001-demo.md': ADR, 'CLAUDE.md': 'See skills/demo/SKILL.md', ...extra });

describe('skills:check', () => {
  it('passes for a well-formed skill and ADR', () => expect(node(skillRepo(), 'skills-check.mjs').code).toBe(0));
  it('fails on a missing required heading', () => {
    const out = node(skillRepo(skill().replace('## Do not', '## Avoid')), 'skills-check.mjs');
    expect(out.code).toBe(1);
    expect(out.out).toContain('expected section 11 to be "## Do not"');
  });
  it('fails on empty sections and placeholder text', () => {
    expect(node(skillRepo(skill({ Commands: '' })), 'skills-check.mjs').out).toContain('section "Commands" is empty');
    expect(node(skillRepo(skill({ Commands: 'TODO' })), 'skills-check.mjs').code).toBe(1);
  });
  it('requires Last reviewed to hold a date', () =>
    expect(node(skillRepo(skill({ 'Last reviewed': 'recently' })), 'skills-check.mjs').out).toContain('needs a YYYY-MM-DD date'));
  it('fails on broken ADR links and missing referenced paths', () => {
    expect(node(skillRepo(skill({ 'Related ADRs': 'ADR-0042' })), 'skills-check.mjs').out).toContain('broken ADR link ADR-0042');
    expect(node(skillRepo(skill({ 'Canonical files': '- `docs/missing.md`' })), 'skills-check.mjs').out).toContain(
      'referenced path does not exist: docs/missing.md',
    );
  });
  it('prohibits empty skill directories and tiny placeholder skills', () => {
    expect(node(skillRepo(skill(), { 'skills/empty/.gitkeep': '' }), 'skills-check.mjs').out).toContain('empty skill directories are prohibited');
    expect(node(skillRepo('# X\n\n## Purpose\n\nx\n'), 'skills-check.mjs').out).toContain('too short');
  });
  it('fails when CLAUDE.md references a missing skill, and on an ADR with bad status', () => {
    expect(node(skillRepo(skill(), { 'CLAUDE.md': 'skills/ghost/SKILL.md' }), 'skills-check.mjs').out).toContain(
      'references missing skill skills/ghost/SKILL.md',
    );
    expect(node(skillRepo(skill(), { 'docs/architecture/ADR-0001-demo.md': ADR.replace('ACCEPTED', 'MAYBE') }), 'skills-check.mjs').out).toContain(
      'Status must be',
    );
  });
});

// ---------------------------------------------------------------- project-state-check
const realFiles = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bg-ps-'));
  scratch.push(root);
  for (const f of ['CLAUDE.md', 'docs/project', 'docs/architecture', 'docs/engineering/COMMIT_POLICY.md', 'db', 'skills']) {
    cpSync(path.join(REPO, f), path.join(root, f), { recursive: true });
  }
  sh(root, 'git', ['init', '-q', '-b', 'main']);
  sh(root, 'git', ['config', 'user.email', 't@example.com']);
  sh(root, 'git', ['config', 'user.name', 'Test']);
  sh(root, 'git', ['add', '-A']);
  sh(root, 'git', ['commit', '-q', '-m', 'chore(TST-001): baseline']);
  return root;
};
const edit = (root, rel, fn) => write(root, rel, fn(readFileSync(path.join(root, rel), 'utf8')));

describe('project-state:check', () => {
  it('passes on the real project knowledge documents', () => {
    const out = node(realFiles(), 'project-state-check.mjs');
    expect(out.out).toContain('project-state:check: OK');
  });
  it('fails when PROJECT_STATE claims a checkpoint with no history entry, or names the wrong migration', () => {
    const r = realFiles();
    edit(r, 'docs/project/PROJECT_STATE.md', (s) =>
      s.replace(/^Last completed checkpoint:.*$/m, 'Last completed checkpoint: ZZZ-999').replace(/^Latest migration:.*$/m, 'Latest migration: 0009_nope.sql'),
    );
    const out = node(r, 'project-state-check.mjs');
    expect(out.code).toBe(1);
    expect(out.out).toContain('IMPLEMENTATION_HISTORY.md has no entry for it');
    expect(out.out).toContain('latest migration');
  });
  it('requires a history entry and PROJECT_STATE update for the finalized checkpoint', () => {
    const r = realFiles();
    write(r, 'apps/api/src/new.ts', 'export {};\n');
    const out = node(r, 'project-state-check.mjs', ['INF-777']);
    expect(out.code).toBe(1);
    expect(out.out).toContain('no entry for INF-777');
    expect(out.out).toContain('PROJECT_STATE.md was not updated');
    expect(out.out).toContain('IMPLEMENTATION_HISTORY.md was not updated');
  });
  it('fails on references to undefined debt and on unsuperseded SUPERSEDED learnings', () => {
    const r = realFiles();
    write(r, 'docs/engineering/note.md', 'This is tracked as DEBT-4242.\n');
    edit(r, 'docs/project/LEARNINGS.md', (s) => s.replace('Status: ACTIVE', 'Status: SUPERSEDED'));
    const out = node(r, 'project-state-check.mjs');
    expect(out.out).toContain('references DEBT-4242 which is not defined');
    expect(out.out).toContain('marked SUPERSEDED but no ACTIVE entry names it');
  });
  it('rejects a history section inside PROJECT_STATE and malformed debt entries', () => {
    const r = realFiles();
    edit(r, 'docs/project/PROJECT_STATE.md', (s) => `${s}\n## History\n\nold news\n`);
    edit(r, 'docs/project/TECH_DEBT.md', (s) => s.replace('Exit criteria: a remote exists', 'Exit: a remote exists'));
    const out = node(r, 'project-state-check.mjs');
    expect(out.out).toContain('current state only');
    expect(out.out).toContain('missing "Exit criteria:"');
  });
});

// ---------------------------------------------------------------- checkpoint:start
describe('checkpoint:start', () => {
  const minimal = {
    'docs/project/PROJECT_STATE.md':
      'Current checkpoint: X\nLast completed checkpoint: Y\nNext approved checkpoint: Z\nLatest migration: 0001_a.sql\nLatest ADR: ADR-0001\nLast updated: 2026-10-05\n\n## Known blockers\n\nNone.\n',
    'db/migrations/0001_a.sql': 'SELECT 1;\n',
  };
  it('requires a valid checkpoint id', () => {
    const r = repo(minimal);
    expect(node(r, 'checkpoint-start.mjs').code).toBe(1);
    expect(node(r, 'checkpoint-start.mjs', ['nope']).out).toContain('invalid checkpoint id');
  });
  it('accepts letter-suffixed checkpoint ids such as INF-002A', () => {
    const r = repo(minimal);
    expect(node(r, 'checkpoint-start.mjs', ['INF-002A']).code).toBe(0);
    expect(node(r, 'checkpoint-start.mjs', ['INF-002AB']).out).toContain('invalid checkpoint id');
  });
  it('refuses a dirty working tree and lists the files', () => {
    const r = repo(minimal);
    write(r, 'stray.txt', 'x');
    const out = node(r, 'checkpoint-start.mjs', ['BAN-001']);
    expect(out.code).toBe(1);
    expect(out.out).toContain('not clean');
    expect(out.out).toContain('stray.txt');
  });
  it('shows state, latest migration, records context, and commits nothing', () => {
    const r = repo(minimal);
    const head = sh(r, 'git', ['rev-parse', 'HEAD']);
    const out = node(r, 'checkpoint-start.mjs', ['BAN-001']);
    expect(out.code).toBe(0);
    expect(out.out).toContain('Next approved checkpoint: Z');
    expect(out.out).toContain('0001_a.sql');
    expect(sh(r, 'git', ['rev-parse', 'HEAD'])).toBe(head);
    expect(sh(r, 'git', ['status', '--porcelain'])).toBe(''); // context file is git-ignored
    expect(JSON.parse(readFileSync(path.join(r, '.checkpoint/BAN-001.start.json'), 'utf8')).id).toBe('BAN-001');
  });
});

// ---------------------------------------------------------------- checkpoint:commit
const fingerprint = (root) =>
  execFileSync('node', ['-e', `import('${path.join(REPO, 'scripts/lib/governance.mjs')}').then(m=>console.log(m.treeFingerprint()))`], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
const finalized = (root, id, passed = true, fp = fingerprint(root)) => {
  const head = sh(root, 'git', ['rev-parse', 'HEAD']).trim();
  write(
    root,
    `.checkpoint/${id}.finalize.json`,
    JSON.stringify({ id, passed, fingerprint: fp, base: 'HEAD', headAtFinalize: head, skillUpdate: 'NOT_REQUIRED', steps: [{ name: 'lint', ok: passed }] }),
  );
};
const commitRepo = () => {
  const root = repo({ 'package.json': '{}\n' });
  const bare = mkdtempSync(path.join(tmpdir(), 'bg-remote-'));
  scratch.push(bare);
  sh(bare, 'git', ['init', '-q', '--bare']);
  sh(root, 'git', ['remote', 'add', 'origin', bare]);
  return { root, bare };
};
const MSG = 'feat(TST-009): add a thing';

describe('checkpoint:commit', () => {
  it('refuses without a finalization result', () => {
    const { root } = commitRepo();
    write(root, 'docs/x.md', 'x');
    const out = node(root, 'commit-checkpoint.mjs', ['TST-009', MSG]);
    expect(out.code).toBe(1);
    expect(out.out).toContain('no finalization result');
  });
  it('refuses when validation failed', () => {
    const { root } = commitRepo();
    write(root, 'docs/x.md', 'x');
    finalized(root, 'TST-009', false);
    const out = node(root, 'commit-checkpoint.mjs', ['TST-009', MSG]);
    expect(out.code).toBe(1);
    expect(out.out).toContain('finalization FAILED');
    expect(sh(root, 'git', ['log', '--oneline']).trim().split('\n')).toHaveLength(1);
  });
  it('refuses when files changed after finalization', () => {
    const { root } = commitRepo();
    write(root, 'docs/x.md', 'x');
    finalized(root, 'TST-009');
    write(root, 'docs/x.md', 'changed after validation');
    expect(node(root, 'commit-checkpoint.mjs', ['TST-009', MSG]).out).toContain('files changed after finalization');
  });
  it('refuses messages that break the convention', () => {
    const { root } = commitRepo();
    write(root, 'docs/x.md', 'x');
    finalized(root, 'TST-009');
    expect(node(root, 'commit-checkpoint.mjs', ['TST-009', 'auto update']).out).toContain('must follow');
    expect(node(root, 'commit-checkpoint.mjs', ['TST-009', 'feat(OTHER-001): wrong checkpoint']).code).toBe(1);
  });
  it('stops on unrelated dirty files and lets them be included explicitly', () => {
    const { root } = commitRepo();
    write(root, 'docs/x.md', 'x');
    write(root, 'notes-from-someone-else.txt', 'unrelated');
    finalized(root, 'TST-009');
    const out = node(root, 'commit-checkpoint.mjs', ['TST-009', MSG]);
    expect(out.code).toBe(1);
    expect(out.out).toContain('outside the checkpoint scope');
    expect(out.out).toContain('notes-from-someone-else.txt');
    const ok = node(root, 'commit-checkpoint.mjs', ['TST-009', MSG, '--dry-run', '--include', 'notes-from-someone-else.txt']);
    expect(ok.code).toBe(0);
  });
  it('rejects env files and secrets', () => {
    const a = commitRepo();
    write(a.root, '.env.production', 'X=1');
    finalized(a.root, 'TST-009');
    expect(node(a.root, 'commit-checkpoint.mjs', ['TST-009', MSG]).out).toContain('forbidden files');
    const b = commitRepo();
    write(b.root, 'docs/key.md', '-----BEGIN RSA PRIVATE KEY-----\nabc\n'); // secret-scan:allow
    write(b.root, 'apps/cfg.ts', 'const api_key = "A1b2C3d4E5f6G7h8I9j0";\n'); // secret-scan:allow
    finalized(b.root, 'TST-009');
    const out = node(b.root, 'commit-checkpoint.mjs', ['TST-009', MSG]);
    expect(out.code).toBe(1);
    expect(out.out).toContain('private key');
    expect(out.out).toContain('credential assignment');
  });
  it('does not flag plain identifier assignments, but still flags quoted literals and env-style secrets', () => {
    const ok = commitRepo();
    write(
      ok.root,
      'apps/a.ts',
      'const token = bearerFromHeader(header);\nconst password = opts.passwordProvider();\nconst apiKey = config.apiKeyFromEnvironment;\n',
    );
    finalized(ok.root, 'TST-009');
    expect(node(ok.root, 'commit-checkpoint.mjs', ['TST-009', MSG, '--dry-run']).code).toBe(0);
    const env = commitRepo();
    write(env.root, 'infra/prod.env.txt', 'APP_SECRET=abcdef0123456789abcdef0123\n'); // secret-scan:allow
    finalized(env.root, 'TST-009');
    const out = node(env.root, 'commit-checkpoint.mjs', ['TST-009', MSG]);
    expect(out.code).toBe(1);
    expect(out.out).toContain('env-style credential');
    const placeholder = commitRepo();
    write(placeholder.root, 'infra/x.env.txt', 'APP_SECRET=replace_me_dev_only_value_123\n');
    finalized(placeholder.root, 'TST-009');
    expect(node(placeholder.root, 'commit-checkpoint.mjs', ['TST-009', MSG, '--dry-run']).code).toBe(0);
  });
  it('lets a line opt out of the secret scan with an explicit marker (fake fixtures only)', () => {
    const { root } = commitRepo();
    write(root, 'apps/fixture.ts', 'const api_key = "A1b2C3d4E5f6G7h8I9j0"; // secret-scan:allow\n');
    finalized(root, 'TST-009');
    expect(node(root, 'commit-checkpoint.mjs', ['TST-009', MSG, '--dry-run']).code).toBe(0);
  });
  it('dry-run shows the files and commits nothing', () => {
    const { root } = commitRepo();
    write(root, 'docs/x.md', 'x');
    finalized(root, 'TST-009');
    const out = node(root, 'commit-checkpoint.mjs', ['TST-009', MSG, '--dry-run']);
    expect(out.code).toBe(0);
    expect(out.out).toContain('docs/x.md');
    expect(sh(root, 'git', ['log', '--oneline']).trim().split('\n')).toHaveLength(1);
  });
  it('commits deletions of tracked files (staged and unstaged) together with other changes', () => {
    const { root } = commitRepo();
    write(root, 'docs/old-a.md', 'a');
    write(root, 'docs/old-b.md', 'b');
    sh(root, 'git', ['add', '-A']);
    sh(root, 'git', ['commit', '-q', '-m', 'chore(TST-001): add files to delete']);
    sh(root, 'git', ['rm', '-q', 'docs/old-a.md']); // staged deletion
    rmSync(path.join(root, 'docs/old-b.md')); // unstaged deletion
    write(root, 'docs/new.md', 'n');
    finalized(root, 'TST-009');
    const out = node(root, 'commit-checkpoint.mjs', ['TST-009', MSG]);
    expect(out.code).toBe(0);
    expect(sh(root, 'git', ['status', '--porcelain'])).toBe('');
    const stat = sh(root, 'git', ['show', '--name-status', '--format=', 'HEAD']);
    expect(stat).toContain('D\tdocs/old-a.md');
    expect(stat).toContain('D\tdocs/old-b.md');
    expect(stat).toContain('A\tdocs/new.md');
  });
  it('creates one commit with the message and trailer, and never pushes', () => {
    const { root, bare } = commitRepo();
    write(root, 'docs/x.md', 'x');
    write(root, 'apps/api/a.ts', 'export {};\n');
    finalized(root, 'TST-009');
    const out = node(root, 'commit-checkpoint.mjs', ['TST-009', MSG, '--trailer', 'Co-Authored-By: Test <t@example.com>']);
    expect(out.code).toBe(0);
    const msg = sh(root, 'git', ['log', '-1', '--format=%B']);
    expect(msg).toContain(MSG);
    expect(msg).toContain('Co-Authored-By: Test');
    expect(sh(root, 'git', ['show', '--stat', '--format=', 'HEAD'])).toContain('docs/x.md');
    expect(sh(root, 'git', ['status', '--porcelain'])).toBe('');
    // the remote must still be empty: nothing was pushed
    expect(sh(bare, 'git', ['for-each-ref'])).toBe('');
    expect(readFileSync(script('commit-checkpoint.mjs'), 'utf8')).not.toMatch(/\[\s*'push'|"push"|git push/);
  });
});

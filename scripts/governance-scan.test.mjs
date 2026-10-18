// Tests for scripts/governance-scan.mjs. Every case builds a scratch git repository and runs the REAL scanner against it
// (cwd = scratch repo). Forbidden strings are assembled from pieces so this file does not trip the rules it tests.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });
const SCANNER = path.join(process.cwd(), 'scripts', 'governance-scan.mjs');
const scratch = [];

const SKIP = 'it.' + 'skip(';
const ONLY = 'it.' + 'only(';
const MARK_A = 'TO' + 'DO';
const MARK_B = 'FIX' + 'ME';
const TSIGNORE = '@ts-' + 'ignore';
const TSEXPECT = '@ts-' + 'expect-error';
const ESDISABLE = 'eslint-' + 'disable';
const SHA = '11d5960a326750d5838078e36cf38b85af677262';
const mit = (n) => `MIT-${String(n).padStart(4, '0')}`;

function sh(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}
function write(root, rel, content) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), content);
}
function repo(files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'bg-scan-'));
  scratch.push(root);
  sh(root, ['init', '-q', '-b', 'main']);
  sh(root, ['config', 'user.email', 't@example.com']);
  sh(root, ['config', 'user.name', 'Test']);
  write(root, '.gitignore', 'node_modules\n');
  for (const [f, c] of Object.entries(files)) write(root, f, typeof c === 'string' ? c : JSON.stringify(c, null, 2));
  sh(root, ['add', '-A']);
  sh(root, ['commit', '-q', '-m', 'chore(TST-001): baseline']);
  return root;
}
const commit = (root, files, msg = 'chore(TST-001): change') => {
  for (const [f, c] of Object.entries(files)) write(root, f, typeof c === 'string' ? c : JSON.stringify(c, null, 2));
  sh(root, ['add', '-A']);
  sh(root, ['commit', '-q', '-m', msg]);
};
const scan = (root, args = []) => {
  const r = spawnSync('node', [SCANNER, ...args], { cwd: root, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const json = (root, args = []) => JSON.parse(scan(root, ['--json', ...args]).out);
const allow = (entries = [], ratchets = {}) => ({ 'scripts/governance-allowlist.json': { entries, ratchets } });
const WF_OK = `name: t\non: push\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${SHA} # v4.4.0\n`;
const entryText = (id, extra = {}) => {
  const f = {
    Status: 'PROPOSED',
    Issue: 'issue',
    'Root cause': 'cause',
    'Customer risk': 'risk',
    Owner: 'owner',
    Approver: 'PENDING (owner)',
    Introduced: '2026-10-01',
    'Expiry/review date': '2026-12-01',
    'Removal condition': 'remove',
    'Protection/flag': 'flag',
    Tests: 'tests',
    Monitoring: 'none',
    ...extra,
  };
  return `## ${id} — title\n\n${Object.entries(f)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n\n`;
};
const ACTIVE = { Status: 'ACTIVE', Approver: 'Dana Owner' };
const REGISTER = 'docs/engineering/TEMPORARY_MITIGATIONS.md';
const INTRO = `# Temporary mitigations register\n\nIntro mentioning Status: ACTIVE and ${MARK_A} words and ${mit(9999)} is ignored.\n\n## Fields and statuses\n\nStatus: ACTIVE\n\n## Register\n\nThe entries below.\n\n`;

afterAll(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('clean repository', () => {
  it('passes with exit 0 and no findings', () => {
    const root = repo({
      'src/a.ts': 'export const a = 1;\n',
      'src/a.test.ts': "import { it } from 'vitest';\nit('works', () => {});\n",
      '.github/workflows/ci.yml': WF_OK,
      'package.json': '{ "scripts": { "test": "vitest run" } }\n',
    });
    const r = scan(root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('0 findings');
  });
  it('--json returns structured findings and informational notes', () => {
    const root = repo({ 'src/a.test.ts': `${SKIP}'x', () => {});\n` });
    const r = json(root);
    expect(r.findings).toEqual([expect.objectContaining({ rule: 'R1', file: 'src/a.test.ts', line: 1 })]);
    expect(r.informational.some((i) => i.rule === 'R7')).toBe(true);
  });
  it('rejects unknown arguments with exit 2', () => {
    expect(scan(repo({}), ['--nope']).code).toBe(2);
  });
});

describe('R1 skipped tests', () => {
  it('flags a skipped test and a focused test, but not a comment', () => {
    const root = repo({ 'src/a.test.ts': `${SKIP}'x', () => {});\n${ONLY}'y', () => {});\n// ${SKIP}'z')\n` });
    const r = json(root);
    expect(r.findings.map((f) => `${f.rule}:${f.line}`)).toEqual(['R1:1', 'R1:2']);
    expect(scan(root).code).toBe(1);
  });
  it('flags the describe, context, conditional, x-prefixed and todo skip forms', () => {
    const body = ['describe.' + 'skip(', 'ctx.' + 'skip(r)', 'it.' + 'skip' + 'If(c)', 'x' + 'it(', 'it.' + 'todo('].map((s) => `${s}\n`).join('');
    const r = json(repo({ 'src/a.itest.ts': body }));
    expect(r.findings).toHaveLength(5);
  });
  it('does not apply to non-test source', () => {
    expect(scan(repo({ 'src/a.ts': `const x = arr.${'skip'}(1);\nfoo.${'skip'}()\n` })).code).toBe(0);
  });
  it('an allowlisted entry passes and is counted', () => {
    const root = repo({
      'src/a.itest.ts': `ctx.${'skip'}(reason);\n`,
      ...allow([{ rule: 'R1', path: 'src/a.itest.ts', pattern: 'ctx\\.skip', count: 1, justification: 'env skip', reviewedBy: 'PENDING owner review' }]),
    });
    const r = scan(root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('allowlisted=1');
  });
  it('a second skip beyond the allowlisted count is a finding', () => {
    const root = repo({
      'src/a.itest.ts': `ctx.${'skip'}(a);\nctx.${'skip'}(b);\n`,
      ...allow([{ rule: 'R1', path: 'src/a.itest.ts', pattern: 'ctx\\.skip', count: 1, justification: 'env skip', reviewedBy: 'PENDING owner review' }]),
    });
    const r = scan(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('beyond the baseline of 1');
  });
});

describe('allowlist hygiene', () => {
  it('an entry that no longer matches anything is reported STALE and fails', () => {
    const root = repo({
      'src/a.test.ts': "it('x', () => {});\n",
      ...allow([{ rule: 'R1', path: 'src/a.test.ts', pattern: 'ctx\\.skip', justification: 'gone', reviewedBy: 'PENDING owner review' }]),
    });
    const r = scan(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('STALE allowlist entry #1');
  });
  it('an expired entry is reported and no longer excuses the finding', () => {
    const root = repo({
      'src/a.itest.ts': `ctx.${'skip'}(r);\n`,
      ...allow([
        { rule: 'R1', path: 'src/a.itest.ts', pattern: 'ctx\\.skip', justification: 'temp', reviewedBy: 'PENDING owner review', expires: '2026-01-01' },
      ]),
    });
    const r = json(root, ['--today=2026-10-18']);
    expect(r.findings.map((f) => f.message).join('\n')).toContain('EXPIRED allowlist entry #1');
    expect(r.findings.some((f) => f.rule === 'R1')).toBe(true);
    expect(json(root, ['--today=2025-12-31']).findings).toEqual([]);
  });
  it('an entry without a justification is a finding', () => {
    const root = repo({ 'src/a.itest.ts': `ctx.${'skip'}(r);\n`, ...allow([{ rule: 'R1', path: 'src/a.itest.ts', pattern: 'ctx' }]) });
    expect(scan(root).out).toContain('needs rule, path and justification');
  });
  it('does not allowlist a different file', () => {
    const root = repo({
      'src/b.itest.ts': `ctx.${'skip'}(r);\n`,
      ...allow([{ rule: 'R1', path: 'src/a.itest.ts', pattern: 'ctx', justification: 'x', reviewedBy: 'PENDING owner review' }]),
    });
    expect(scan(root).code).toBe(1);
  });
});

describe('R2 work markers and the mitigation register', () => {
  it('flags a marker without a mitigation id, passes one that names a registered id', () => {
    const bad = repo({ 'src/a.ts': `// ${MARK_A} fix later\n` });
    expect(json(bad).findings).toEqual([expect.objectContaining({ rule: 'R2', line: 1 })]);
    const ok = repo({ 'src/a.ts': `// ${MARK_B}(${mit(1)}) remove with the flag\n`, [REGISTER]: INTRO + entryText(mit(1), ACTIVE) });
    expect(scan(ok).code).toBe(0);
  });
  it('does not scan docs or skills for markers', () => {
    expect(scan(repo({ 'docs/x.md': `${MARK_A}\n`, 'skills/a/SKILL.md': `${MARK_A}\n` })).code).toBe(0);
  });
  it('a referenced id that is not in the register is a finding', () => {
    const root = repo({ 'src/a.ts': `// ${MARK_A} ${mit(7)}\n`, [REGISTER]: INTRO + entryText(mit(1)) });
    const r = scan(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${mit(7)} is referenced but not defined`);
  });
  it('a missing or empty required field is a finding', () => {
    const root = repo({ [REGISTER]: INTRO + entryText(mit(1), { Monitoring: null, Owner: '' }) });
    const r = scan(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('missing required field "Monitoring"');
    expect(r.out).toContain('field "Owner" is empty');
  });
  it('an invalid status is a finding', () => {
    expect(scan(repo({ [REGISTER]: INTRO + entryText(mit(1), { Status: 'MAYBE' }) })).out).toContain('Status "MAYBE" is not one of');
  });
  it('a PROPOSED entry is informational only (awaiting approval), even when its review date has passed', () => {
    const root = repo({ [REGISTER]: INTRO + entryText(mit(1), { 'Expiry/review date': '2026-01-01' }) });
    const r = json(root, ['--today=2026-10-18']);
    expect(r.findings).toEqual([]);
    expect(r.informational.map((i) => i.message)).toContain(`${mit(1)}: PROPOSED, awaiting approval (review date 2026-01-01 has passed)`);
  });
  it('an ACTIVE entry past its expiry date is a finding (stale/expired register entry)', () => {
    const root = repo({ [REGISTER]: INTRO + entryText(mit(1), { Status: 'ACTIVE', Approver: 'Dana Owner', 'Expiry/review date': '2026-05-01' }) });
    const r = scan(root, ['--today=2026-10-18']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('past its expiry date 2026-05-01');
    expect(scan(root, ['--today=2026-04-30']).code).toBe(0);
  });
  it('an ACTIVE entry with a PENDING or empty approver is a finding', () => {
    const pending = repo({ [REGISTER]: INTRO + entryText(mit(1), { Status: 'ACTIVE' }) });
    expect(scan(pending).out).toContain('ACTIVE entry has no approver');
    const empty = repo({ [REGISTER]: INTRO + entryText(mit(1), { Status: 'ACTIVE', Approver: '' }) });
    expect(scan(empty).code).toBe(1);
  });
  it('EXPIRED and REMOVED entries are not date-checked', () => {
    const root = repo({
      [REGISTER]:
        INTRO +
        entryText(mit(1), { Status: 'EXPIRED', 'Expiry/review date': '2020-01-01' }) +
        entryText(mit(2), { Status: 'REMOVED', 'Expiry/review date': '2020-01-01' }),
    });
    expect(scan(root).code).toBe(0);
  });
  it('the register intro above the first entry is ignored, and a missing register skips the register checks with a note', () => {
    const only = repo({ [REGISTER]: INTRO });
    expect(scan(only).code).toBe(0);
    const none = repo({ 'src/a.ts': 'export {};\n' });
    expect(json(none).informational.some((i) => /register file absent/.test(i.message))).toBe(true);
  });
  it('duplicate register ids are a finding', () => {
    expect(scan(repo({ [REGISTER]: INTRO + entryText(mit(1)) + entryText(mit(1)) })).out).toContain('duplicate register entry');
  });
});

describe('R3 suppressions', () => {
  it('flags a ts-ignore and a ts-nocheck', () => {
    const r = json(repo({ 'src/a.ts': `// ${TSIGNORE}\nconst a = 1;\n// @ts-` + 'nocheck\n' }));
    expect(r.findings.filter((f) => f.rule === 'R3')).toHaveLength(2);
  });
  it('a ts-expect-error needs a reason', () => {
    const bad = repo({ 'src/a.ts': `// ${TSEXPECT}\nfoo();\n` });
    expect(scan(bad).code).toBe(1);
    const ok = repo({ 'src/a.ts': `// ${TSEXPECT} the mock omits the abort signal\nfoo();\n` });
    expect(scan(ok).code).toBe(0);
  });
  it('an eslint directive needs a reason: bare fails; "-- why", same-line comment and explanatory previous line pass', () => {
    expect(scan(repo({ 'src/a.ts': `// ${ESDISABLE}-next-line no-control-regex\nconst r = /x/;\n` })).code).toBe(1);
    expect(scan(repo({ 'src/a.ts': `// ${ESDISABLE}-next-line no-control-regex -- rejects control characters\nconst r = /x/;\n` })).code).toBe(0);
    expect(scan(repo({ 'src/a.ts': `// rejects control characters on purpose\n// ${ESDISABLE}-next-line no-control-regex\nconst r = /x/;\n` })).code).toBe(0);
    expect(scan(repo({ 'src/a.ts': `const r = /x/; // untyped upstream body // ${ESDISABLE}-line no-control-regex\n` })).code).toBe(0);
  });
  it('a baselined suppression passes up to its count only', () => {
    const line = `// ${ESDISABLE}-next-line @typescript-eslint/no-explicit-any\n`;
    const entries = [
      { rule: 'R3', path: 'src/a.test.ts', pattern: 'no-explicit-any', count: 1, justification: 'baseline', reviewedBy: 'PENDING owner review' },
    ];
    expect(scan(repo({ 'src/a.test.ts': line + 'let a: any;\n', ...allow(entries) })).code).toBe(0);
    expect(scan(repo({ 'src/a.test.ts': line + 'let a: any;\n' + line + 'let b: any;\n', ...allow(entries) })).code).toBe(1);
  });
});

describe('R4 workflows', () => {
  it('a workflow without a permissions block is a finding', () => {
    const wf = WF_OK.replace('permissions:\n  contents: read\n', '');
    const r = scan(repo({ '.github/workflows/a.yml': wf }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('no `permissions:` block');
  });
  it('job-level permissions on every job are accepted', () => {
    const wf = `name: t\non: push\njobs:\n  a:\n    permissions:\n      contents: read\n    runs-on: x\n    steps:\n      - uses: actions/checkout@${SHA}\n  b:\n    runs-on: x\n    steps:\n      - run: echo\n`;
    expect(scan(repo({ '.github/workflows/a.yml': wf })).code).toBe(1);
    expect(
      scan(
        repo({
          '.github/workflows/a.yml': wf.replace(
            '    runs-on: x\n    steps:\n      - run: echo',
            '    permissions: {}\n    runs-on: x\n    steps:\n      - run: echo',
          ),
        }),
      ).code,
    ).toBe(0);
  });
  it('an action pinned to a tag or branch is a finding; a 40-hex SHA with a comment passes', () => {
    const tag = repo({ '.github/workflows/a.yml': WF_OK.replace(`@${SHA} # v4.4.0`, '@v4') });
    const r = scan(tag);
    expect(r.code).toBe(1);
    expect(r.out).toContain('not pinned to a full commit SHA: actions/checkout@v4');
    expect(scan(repo({ '.github/workflows/a.yml': WF_OK })).code).toBe(0);
  });
  it('a docker:// action must carry a digest', () => {
    const wf = WF_OK + '      - uses: docker://alpine:3\n';
    expect(scan(repo({ '.github/workflows/a.yml': wf })).out).toContain('docker action not pinned by digest');
  });
  it('local actions are ignored; container images pinned by tag are informational only', () => {
    const wf = WF_OK + '      - uses: ./.github/actions/x\n      - run: docker run --rm -v "$PWD:/r" aquasec/trivy:0.65.0 image x\n';
    const r = json(repo({ '.github/workflows/a.yml': wf }));
    expect(r.findings).toEqual([]);
    expect(r.informational.some((i) => i.rule === 'R4' && i.message.includes('aquasec/trivy:0.65.0'))).toBe(true);
  });
});

describe('R5 passWithNoTests ratchet', () => {
  const pkg = (flag) => `{\n  "scripts": {\n    "test": "vitest run${flag ? ' --passWithNoTests' : ''}"\n  }\n}\n`;
  it('a new flag with no baseline fails', () => {
    const r = scan(repo({ 'packages/a/package.json': pkg(true) }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('--passWithNoTests');
  });
  it('passes at the baseline and fails when one more appears', () => {
    const base = allow([], { R5: { max: 1, justification: 'baseline', reviewedBy: 'PENDING owner review' } });
    expect(scan(repo({ 'packages/a/package.json': pkg(true), ...base })).code).toBe(0);
    const more = scan(repo({ 'packages/a/package.json': pkg(true), 'packages/b/package.json': pkg(true), ...base }));
    expect(more.code).toBe(1);
    expect(more.out).toContain('2 found, ratchet baseline 1');
  });
  it('suggests lowering the baseline when the count falls', () => {
    const base = allow([], { R5: { max: 3, justification: 'baseline', reviewedBy: 'PENDING owner review' } });
    const r = json(repo({ 'packages/a/package.json': pkg(true), ...base }));
    expect(r.findings).toEqual([]);
    expect(r.informational.some((i) => /can be lowered from 3 to 1/.test(i.message))).toBe(true);
  });
  it('a package without the flag is clean', () => {
    expect(scan(repo({ 'packages/a/package.json': pkg(false) })).code).toBe(0);
  });
});

describe('R6 production-code guard', () => {
  it('flags a testing import and an allowTestKeys true literal in production code', () => {
    const root = repo({
      'apps/api/src/index.ts': "import { x } from '@bananagig/testing';\nconst c = { allowTestKeys: true };\n",
      'packages/p/src/s.ts': "import { y } from '@bananagig/identity/testing';\n",
    });
    const r = json(root);
    expect(r.findings.filter((f) => f.rule === 'R6').map((f) => `${f.file}:${f.line}`)).toEqual([
      'apps/api/src/index.ts:1',
      'apps/api/src/index.ts:2',
      'packages/p/src/s.ts:1',
    ]);
  });
  it('allows test files, and the documented environment-derived option', () => {
    const root = repo({
      'apps/api/src/a.test.ts': "import { x } from '@bananagig/testing';\nconst c = { allowTestKeys: true };\n",
      'packages/p/src/b.itest.ts': "import { x } from '@bananagig/testing/sms';\n",
      'apps/api/src/index.ts': "const c = { allowTestKeys: cfg.env !== 'production' };\n",
    });
    expect(scan(root).code).toBe(0);
  });
});

describe('R1 evasions and widened test files', () => {
  const cases = {
    'the each variant of a skipped test': `it.${'skip'}.each([1])('x', () => {});\n`,
    'an alias of the skip function': `const s = it.${'skip'};\ns('x', () => {});\n`,
    'bracket access to the skip function': `it['${'skip'}']('x', () => {});\n`,
    'the skip option object': `it('x', { ${'skip'}: true }, () => {});\n`,
    'a runIf call': `it.${'runIf'}(false)('x', () => {});\n`,
    'a conditional-skip call': `it.${'skip'}If(true)('x', () => {});\n`,
    'a fixme call': `test.${'fixme'}('x', () => {});\n`,
    'a todo call': `it.${'todo'}('x');\n`,
    'a concurrent chain': `it.concurrent.${'skip'}('x', () => {});\n`,
    'a jasmine focus call': `f${'it'}('x', () => {});\n`,
    'an alias call of a modifier': `t.${'fixme'}('x');\n`,
  };
  for (const [name, body] of Object.entries(cases)) {
    it(`flags ${name}`, () => {
      const r = json(repo({ 'src/a.test.ts': body }));
      expect(r.findings.map((f) => f.rule)).toEqual(['R1']);
    });
  }
  for (const file of ['apps/api/test/x.ts', 'apps/api/tests/y.js', 'src/x.integration.ts', 'src/x.e2e.ts', 'src/x.spec.ts', 'src/__tests__/z.ts']) {
    it(`treats ${file} as a test file`, () => {
      expect(json(repo({ [file]: `it.${'skip'}('x', () => {});\n` })).findings.map((f) => f.rule)).toEqual(['R1']);
    });
  }
  it('does not flag look-alikes: property reads, css classes, parameter types, skip: false, constants named skip', () => {
    const body = [
      'if (o.' + 'skip?.includes(k)) continue;',
      "const sel = '.account-shell a:not(.skip-link):link';",
      'const firstHit = (haystack: string, skip: ReadonlySet<string> = new Set()) => haystack;',
      "it('x', { skip: false }, () => {});",
      'const DISABLED = { skip: SKIPPED };',
      'new_string: DISABLED.' + 'skip,',
    ].join('\n');
    expect(scan(repo({ 'src/a.test.ts': `${body}\n` })).code).toBe(0);
  });
  it('R6 keeps the narrow test-file definition: a src/*.e2e.ts file is still production code', () => {
    const r = json(repo({ 'apps/api/src/x.e2e.ts': "import { x } from '@bananagig/testing';\n" }));
    expect(r.findings.map((f) => f.rule)).toEqual(['R6']);
  });
});

describe('R4 parsed workflows, composite actions and write permissions', () => {
  const wf = (steps, head = 'permissions:\n  contents: read\n') => `name: t\non: push\n${head}jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;
  it('a quoted pinned SHA is not a false positive; a quoted tag is still a finding', () => {
    expect(
      scan(repo({ '.github/workflows/a.yml': wf(`      - uses: 'actions/checkout@${SHA}'\n      - uses: "actions/setup-node@${SHA}" # v4\n`) })).code,
    ).toBe(0);
    expect(scan(repo({ '.github/workflows/a.yml': wf("      - uses: 'actions/checkout@v4'\n") })).out).toContain(
      'not pinned to a full commit SHA: actions/checkout@v4',
    );
  });
  it('sees a flow-mapping step { uses: x@v4 }', () => {
    const r = scan(repo({ '.github/workflows/a.yml': wf('      - { uses: actions/checkout@v4 }\n') }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('actions/checkout@v4');
  });
  it('checks composite actions under .github/actions, which need no permissions block', () => {
    const bad = 'name: x\nruns:\n  using: composite\n  steps:\n    - uses: actions/checkout@v4\n      shell: bash\n';
    const good = bad.replace('@v4', `@${SHA}`);
    const r = json(repo({ '.github/actions/x/action.yml': bad }));
    expect(r.findings).toEqual([expect.objectContaining({ rule: 'R4', file: '.github/actions/x/action.yml', line: 5 })]);
    expect(scan(repo({ '.github/actions/x/action.yml': good })).code).toBe(0);
  });
  it('an unpinned reusable workflow at job level is a finding; a local one is not', () => {
    const head = 'name: t\non: push\npermissions:\n  contents: read\njobs:\n';
    expect(scan(repo({ '.github/workflows/a.yml': `${head}  a:\n    uses: o/r/.github/workflows/x.yml@main\n` })).out).toContain(
      'o/r/.github/workflows/x.yml@main',
    );
    expect(scan(repo({ '.github/workflows/a.yml': `${head}  a:\n    uses: ./.github/workflows/x.yml\n` })).code).toBe(0);
  });
  it('permissions: write-all and permissions: write at workflow level are findings', () => {
    for (const v of ['write-all', 'write']) {
      const r = scan(repo({ '.github/workflows/a.yml': wf(`      - uses: actions/checkout@${SHA}\n`, `permissions: ${v}\n`) }));
      expect(r.code).toBe(1);
      expect(r.out).toContain('grants write to every scope');
    }
  });
  it('a "<scope>: write" permission is a finding unless allowlisted, at workflow or job level', () => {
    const top = repo({ '.github/workflows/a.yml': wf(`      - uses: actions/checkout@${SHA}\n`, 'permissions:\n  contents: read\n  pull-requests: write\n') });
    const r = json(top);
    expect(r.findings).toEqual([expect.objectContaining({ rule: 'R4', line: 5 })]);
    const job =
      'name: t\non: push\npermissions:\n  contents: read\njobs:\n  a:\n    permissions:\n      security-events: write\n    runs-on: x\n    steps:\n      - run: echo\n';
    expect(scan(repo({ '.github/workflows/a.yml': job })).out).toContain('security-events: write');
    const entry = {
      rule: 'R4',
      path: '.github/workflows/a.yml',
      lineContains: 'security-events: write',
      count: 1,
      justification: 'SARIF upload',
      reviewedBy: 'Dana Owner',
    };
    expect(scan(repo({ '.github/workflows/a.yml': job, ...allow([entry]) })).code).toBe(0);
  });
  it('read-only and empty permissions are fine', () => {
    expect(scan(repo({ '.github/workflows/a.yml': wf(`      - uses: actions/checkout@${SHA}\n`, 'permissions: {}\n') })).code).toBe(0);
    expect(scan(repo({ '.github/workflows/a.yml': wf(`      - uses: actions/checkout@${SHA}\n`, 'permissions: read-all\n') })).code).toBe(0);
  });
  it('a workflow that does not parse is a finding', () => {
    const r = scan(repo({ '.github/workflows/a.yml': 'name: t\njobs: [unclosed\n' }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('does not parse');
  });
});

describe('register hardening', () => {
  const regRepo = (entries, files = {}) => repo({ [REGISTER]: INTRO + entries, ...files });
  it('a MIT id referenced from code must be ACTIVE: PROPOSED, EXPIRED and REMOVED references are findings', () => {
    for (const status of ['PROPOSED', 'EXPIRED', 'REMOVED']) {
      const r = scan(regRepo(entryText(mit(1), { Status: status }), { 'src/a.ts': `// ${MARK_A}(${mit(1)})\n` }));
      expect(r.code, status).toBe(1);
      expect(r.out).toContain(`register status is ${status}`);
    }
    expect(scan(regRepo(entryText(mit(1), ACTIVE), { 'src/a.ts': `// ${MARK_A}(${mit(1)})\n` })).code).toBe(0);
  });
  it('a register that merely lists PROPOSED entries stays informational', () => {
    expect(scan(regRepo(entryText(mit(1)))).code).toBe(0);
  });
  it('a ### heading (or any non-exact heading) naming an MIT id cannot hide an entry', () => {
    const hidden = `### ${mit(2)} \u2014 sneaky\nStatus: ACTIVE\n`;
    expect(scan(regRepo(entryText(mit(1)) + hidden)).out).toContain('must be exactly "## MIT-nnnn');
    expect(scan(regRepo(`## ${mit(2)} - hyphen separator\nStatus: ACTIVE\n`)).out).toContain('must be exactly');
    expect(scan(regRepo(`# ${mit(2)} \u2014 h1\nStatus: ACTIVE\n`)).code).toBe(1);
  });
  it('an approver that is an agent or bot is a finding in any status', () => {
    for (const who of ['Claude', 'agent', 'Bot', 'AI', 'Anthropic', 'claude-code agent']) {
      const r = scan(regRepo(entryText(mit(1), { ...ACTIVE, Approver: who })));
      expect(r.code, who).toBe(1);
      expect(r.out).toContain('is an agent/bot');
    }
    expect(scan(regRepo(entryText(mit(1), { Approver: 'Claude' }))).code).toBe(1); // PROPOSED too
    expect(scan(regRepo(entryText(mit(1), { ...ACTIVE, Approver: 'Dana Mishra' }))).code).toBe(0);
  });
  it('an ACTIVE entry whose expiry is more than 400 days ahead is a finding', () => {
    const far = regRepo(entryText(mit(1), { ...ACTIVE, 'Expiry/review date': '2028-01-01' }));
    const r = scan(far, ['--today=2026-10-18']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('more than 400 days ahead');
    expect(scan(far, ['--today=2027-06-01']).code).toBe(0);
    expect(scan(regRepo(entryText(mit(1), { ...ACTIVE, 'Expiry/review date': '2027-11-22' })), ['--today=2026-10-18']).code).toBe(0); // 400 days
  });
  it('a missing register is a finding when code, docs or the allowlist reference it, and a note otherwise', () => {
    expect(scan(repo({ 'src/a.ts': `// ${MARK_A}(${mit(1)})\n` })).out).toContain('register file is missing but is referenced by src/a.ts');
    expect(scan(repo({ 'docs/engineering/NOTES.md': 'See docs/engineering/TEMPORARY_MITIGATIONS.md\n' })).code).toBe(1);
    expect(scan(repo({ 'README.md': `${mit(3)} is mentioned\n` })).code).toBe(1);
    const none = repo({ 'src/a.ts': 'export {};\n' });
    expect(scan(none).code).toBe(0);
    expect(json(none).informational.some((i) => /nothing references it/.test(i.message))).toBe(true);
  });
});

describe('allowlist hygiene: reviewedBy, --strict and baseline growth', () => {
  const entry = (extra = {}) => ({
    rule: 'R1',
    path: 'src/a.itest.ts',
    pattern: 'ctx',
    count: 1,
    justification: 'env skip',
    reviewedBy: 'Dana Owner',
    ...extra,
  });
  const skipFile = { 'src/a.itest.ts': `ctx.${'skip'}(r);\n` };
  it('a missing reviewedBy is a finding in both modes', () => {
    const { reviewedBy: _drop, ...noReviewer } = entry();
    const root = repo({ ...skipFile, ...allow([noReviewer]) });
    expect(scan(root).out).toContain('has no reviewedBy');
    expect(scan(root, ['--strict']).out).toContain('has no reviewedBy');
  });
  it('--strict reports PENDING reviews; the default mode does not', () => {
    const pending = repo({
      ...skipFile,
      ...allow([entry({ reviewedBy: 'PENDING owner review' })], { R5: { max: 0, justification: 'j', reviewedBy: 'PENDING owner review' } }),
    });
    expect(scan(pending).code).toBe(0);
    const strict = scan(pending, ['--strict']);
    expect(strict.code).toBe(1);
    expect(strict.out).toContain('still "PENDING owner review"');
    expect(strict.out).toContain('ratchet R5 is still');
    const reviewed = repo({ ...skipFile, ...allow([entry()], { R5: { max: 0, justification: 'j', reviewedBy: 'Dana Owner' } }) });
    expect(scan(reviewed, ['--strict']).code).toBe(0);
  });
  const base = () =>
    repo({
      ...skipFile,
      'packages/p/package.json': '{ "scripts": { "test": "vitest run --passWithNoTests" } }\n',
      ...allow([entry()], { R5: { max: 1, justification: 'j', reviewedBy: 'Dana Owner' } }),
    });
  it('a new allowlist entry compared with the base is a finding unless --allow-baseline-growth is passed', () => {
    const root = base();
    commit(root, {
      'src/b.itest.ts': `ctx.${'skip'}(r);\n`,
      ...allow([entry(), entry({ path: 'src/b.itest.ts' })], { R5: { max: 1, justification: 'j', reviewedBy: 'Dana Owner' } }),
    });
    const r = scan(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('new allowlist entry #2');
    expect(r.out).toContain('is not in HEAD~1');
    const ok = scan(root, ['--allow-baseline-growth']);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('allowed by --allow-baseline-growth');
  });
  it('raising the R5 ratchet or an entry count is a finding', () => {
    const root = base();
    commit(root, {
      'packages/q/package.json': '{ "scripts": { "test": "vitest run --passWithNoTests" } }\n',
      ...allow([entry()], { R5: { max: 2, justification: 'j', reviewedBy: 'Dana Owner' } }),
    });
    expect(scan(root).out).toContain('ratchet R5 max raised from 1 to 2');
    const counts = base();
    commit(counts, {
      'src/a.itest.ts': `ctx.${'skip'}(r);\nctx.${'skip'}(s);\n`,
      ...allow([entry({ count: 2 })], { R5: { max: 1, justification: 'j', reviewedBy: 'Dana Owner' } }),
    });
    expect(scan(counts).out).toContain('raises its count from 1 to 2');
    const unlimited = base();
    commit(unlimited, allow([entry({ count: undefined })], { R5: { max: 1, justification: 'j', reviewedBy: 'Dana Owner' } }));
    expect(scan(unlimited).out).toContain('to unlimited');
  });
  it('removing an entry or lowering the ratchet is fine, and an explicit --base is honoured', () => {
    const root = base();
    commit(root, {
      'src/a.itest.ts': 'export {};\n',
      'packages/p/package.json': '{ "scripts": { "test": "vitest run" } }\n',
      ...allow([], { R5: { max: 0, justification: 'j', reviewedBy: 'Dana Owner' } }),
    });
    expect(scan(root).code).toBe(0);
    const grown = base();
    commit(grown, {
      'src/b.itest.ts': `ctx.${'skip'}(r);\n`,
      ...allow([entry(), entry({ path: 'src/b.itest.ts' })], { R5: { max: 1, justification: 'j', reviewedBy: 'Dana Owner' } }),
    });
    commit(grown, { 'src/c.txt': 'noise\n' });
    expect(scan(grown).code).toBe(0); // default base HEAD~1 already contains the growth
    expect(scan(grown, ['--base=HEAD~2']).out).toContain('new allowlist entry #2');
  });
  it('a single-commit repository, an unresolvable --base and a base without the file skip the growth check', () => {
    const single = base();
    expect(scan(single).code).toBe(0);
    expect(scan(single, ['--base=no-such-ref']).code).toBe(0);
    expect(json(single, ['--base=no-such-ref']).informational.some((i) => /does not resolve/.test(i.message))).toBe(true);
    const fresh = repo({ 'src/a.ts': 'export {};\n' });
    commit(fresh, { ...skipFile, ...allow([entry()]) });
    const r = json(fresh);
    expect(r.findings).toEqual([]);
    expect(r.informational.some((i) => /no allowlist at HEAD~1/.test(i.message))).toBe(true);
  });
});

describe('R7 CODEOWNERS', () => {
  it('is informational: absent does not fail, present is noted', () => {
    const none = json(repo({ 'a.txt': 'x\n' }));
    expect(none.findings).toEqual([]);
    expect(none.informational.find((i) => i.rule === 'R7').message).toMatch(/no CODEOWNERS/);
    const some = json(repo({ '.github/CODEOWNERS': '* @owner\n' }));
    expect(some.informational.find((i) => i.rule === 'R7').message).toBe('CODEOWNERS present');
  });
});

describe('scanned file set', () => {
  it('includes new, not-yet-committed files that are not ignored, and skips ignored ones', () => {
    const root = repo({ 'src/a.ts': 'export {};\n' });
    write(root, 'src/new.test.ts', `${SKIP}'x', () => {});\n`);
    write(root, 'node_modules/x/y.test.ts', `${SKIP}'x', () => {});\n`);
    const r = json(root);
    expect(r.findings.map((f) => f.file)).toEqual(['src/new.test.ts']);
  });
});

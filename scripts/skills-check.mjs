// Validates project skills under skills/: format, headings, Last reviewed date, ADR/file references, no empty placeholders.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { Report, adrFiles, exists, isoDate, meaningful, p, read, sections } from './lib/governance.mjs';

const REQUIRED = [
  'Purpose',
  'When to use',
  'Canonical files',
  'Architecture rules',
  'Implementation pattern',
  'Commands',
  'Testing requirements',
  'Data-model considerations',
  'Common failure modes',
  'Known BananaGig-specific lessons',
  'Do not',
  'Related ADRs',
  'Last reviewed',
];
const r = new Report('skills:check');
const adrIds = new Set(adrFiles().map((f) => f.slice(0, 8)));

if (!exists('skills')) r.fail('skills/ directory is missing');
const dirs = exists('skills') ? readdirSync(p('skills')).filter((d) => statSync(p('skills', d)).isDirectory()) : [];
if (!dirs.length) r.fail('no skills found under skills/');

for (const d of dirs) {
  const rel = `skills/${d}/SKILL.md`;
  if (!exists(rel)) {
    r.fail(`${rel}: missing (empty skill directories are prohibited)`);
    continue;
  }
  const md = read(rel);
  if (!/^# .+/m.test(md.split('\n')[0] ?? '')) r.fail(`${rel}: first line must be "# <Skill name>"`);
  if (md.length < 800) r.fail(`${rel}: too short to be a real skill (placeholder?)`);
  const secs = sections(md, 2);
  const titles = secs.map((s) => s.title);
  REQUIRED.forEach((h, i) => {
    if (titles[i] !== h) r.fail(`${rel}: expected section ${i + 1} to be "## ${h}" (found "${titles[i] ?? 'none'}")`);
  });
  for (const s of secs) if (meaningful(s.body).length === 0) r.fail(`${rel}: section "${s.title}" is empty`);
  const reviewed = secs.find((s) => s.title === 'Last reviewed');
  if (reviewed && !isoDate.test(reviewed.body)) r.fail(`${rel}: "Last reviewed" needs a YYYY-MM-DD date`);
  if (/\b(TODO|TBD|FIXME|lorem ipsum)\b/i.test(md)) r.fail(`${rel}: contains TODO/TBD placeholder text`);

  // referenced canonical files must exist: backticked repo paths (directory-prefixed) and known root files
  const ROOT_FILES =
    '(?:compose\\.yaml|compose\\.dev\\.yaml|CLAUDE\\.md|AGENTS\\.md|redocly\\.yaml|vitest\\.integration\\.config\\.ts|\\.env\\.example|\\.env\\.host\\.example|Dockerfile|package\\.json|turbo\\.json)';
  const refRe = new RegExp('`((?:apps|packages|docs|scripts|infra|db|skills|\\.github)/[A-Za-z0-9_./@-]+|' + ROOT_FILES + ')`', 'g');
  for (const m of md.matchAll(refRe)) {
    const ref = m[1].replace(/\/$/, '');
    if (/[*<>{}]|NNNN|<ID>/.test(ref)) continue; // patterns, not paths
    if (!existsSync(p(ref))) r.fail(`${rel}: referenced path does not exist: ${ref}`);
  }
  // ADR references must resolve
  for (const m of md.matchAll(/ADR-\d{4}/g)) if (!adrIds.has(m[0])) r.fail(`${rel}: broken ADR link ${m[0]} (no docs/architecture/${m[0]}-*.md)`);
}

// CLAUDE.md skill references
if (exists('CLAUDE.md')) {
  for (const m of read('CLAUDE.md').matchAll(/skills\/([a-z0-9-]+)\/SKILL\.md/g))
    if (!exists(`skills/${m[1]}/SKILL.md`)) r.fail(`CLAUDE.md references missing skill skills/${m[1]}/SKILL.md`);
}
// ADR documents: required headings and resolvable links
for (const f of adrFiles()) {
  const md = read(`docs/architecture/${f}`);
  if (!new RegExp(`^# ${f.slice(0, 8)} — .+`, 'm').test(md)) r.fail(`docs/architecture/${f}: heading must be "# ${f.slice(0, 8)} — <Title>"`);
  for (const h of [
    'Status:',
    'Date:',
    'Checkpoint:',
    '## Context',
    '## Decision',
    '## Alternatives considered',
    '## Consequences',
    '## Migration / compatibility',
    '## Related files',
  ])
    if (!md.includes(h)) r.fail(`docs/architecture/${f}: missing "${h}"`);
  const st = md.match(/^Status:\s*(.+)$/m)?.[1] ?? '';
  if (!/^(ACCEPTED|PROPOSED|SUPERSEDED|DEPRECATED)\b/.test(st)) r.fail(`docs/architecture/${f}: Status must be ACCEPTED, PROPOSED, SUPERSEDED or DEPRECATED`);
  if (/^SUPERSEDED/.test(st) && !/ADR-\d{4}/.test(st))
    r.fail(`docs/architecture/${f}: SUPERSEDED status must name the superseding ADR (e.g. "SUPERSEDED by ADR-0012")`);
  for (const m of md.matchAll(/ADR-\d{4}/g)) if (!adrIds.has(m[0])) r.fail(`docs/architecture/${f}: broken ADR link ${m[0]}`);
  for (const m of md.matchAll(/`((?:apps|packages|docs|scripts|infra|db|skills)\/[A-Za-z0-9_./@-]+)`/g)) {
    if (/[*<>{}]/.test(m[1])) continue;
    if (!existsSync(p(m[1].replace(/\/$/, '')))) r.fail(`docs/architecture/${f}: referenced path does not exist: ${m[1]}`);
  }
}
r.note(`${dirs.length} skill(s), ${adrFiles().length} ADR(s) checked`);
r.finish();

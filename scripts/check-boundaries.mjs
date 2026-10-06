// Workspace dependency rules: no cycles, and each workspace may only depend on the workspaces allowed below.
// Usage: node scripts/check-boundaries.mjs [--graph]   (--graph prints a Mermaid diagram)
import { readFileSync, readdirSync } from 'node:fs';

const ALLOWED = {
  '@bananagig/contracts': [],
  '@bananagig/config': [],
  '@bananagig/database': [],
  '@bananagig/observability': ['config', 'contracts'],
  '@bananagig/platform': ['config', 'contracts', 'database', 'observability'],
  '@bananagig/identity': [],
  '@bananagig/testing': ['config', 'database'],
  '@bananagig/web': ['config', 'contracts', 'identity', 'observability', 'testing'],
  '@bananagig/api': ['config', 'contracts', 'database', 'identity', 'observability', 'platform', 'testing'],
  '@bananagig/worker': ['config', 'contracts', 'database', 'observability', 'platform', 'testing'],
  '@bananagig/smoke': ['contracts', 'identity'],
};

const pkgs = {};
for (const group of ['apps', 'packages']) {
  for (const d of readdirSync(group, { withFileTypes: true }).filter((x) => x.isDirectory())) {
    try {
      const p = JSON.parse(readFileSync(`${group}/${d.name}/package.json`, 'utf8'));
      pkgs[p.name] = Object.keys({ ...p.dependencies, ...p.devDependencies }).filter((n) => n.startsWith('@bananagig/'));
    } catch {
      /* not a package */
    }
  }
}

const errors = [];
for (const [name, deps] of Object.entries(pkgs)) {
  const allowed = ALLOWED[name];
  if (!allowed) {
    errors.push(`${name}: no rule defined in scripts/check-boundaries.mjs`);
    continue;
  }
  for (const dep of deps) {
    if (!allowed.includes(dep.replace('@bananagig/', ''))) errors.push(`${name} must not depend on ${dep}`);
  }
}

// cycle detection (DFS)
const state = {};
const visit = (n, stack) => {
  if (state[n] === 2) return;
  if (state[n] === 1) {
    errors.push(`circular dependency: ${[...stack.slice(stack.indexOf(n)), n].join(' -> ')}`);
    return;
  }
  state[n] = 1;
  for (const m of pkgs[n] ?? []) visit(m, [...stack, n]);
  state[n] = 2;
};
Object.keys(pkgs).forEach((n) => visit(n, []));

if (process.argv.includes('--graph')) {
  console.log('graph LR');
  for (const [n, deps] of Object.entries(pkgs)) for (const d of deps) console.log(`  ${n.replace('@bananagig/', '')} --> ${d.replace('@bananagig/', '')}`);
}
if (errors.length) {
  console.error(`Workspace boundary violations:\n  - ${errors.join('\n  - ')}`);
  process.exit(1);
}
if (!process.argv.includes('--graph')) console.log(`workspace boundaries ok (${Object.keys(pkgs).length} workspaces, no cycles)`);

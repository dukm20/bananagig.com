// pnpm dev: starts dependency containers (with host-published ports), then runs web/api/worker on the host
// with hot reload (next dev, tsx watch). `--deps-only` starts just the containers (used by test:integration).
import { copyFileSync, existsSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';

if (!existsSync('.env')) copyFileSync('.env.example', '.env');
if (!existsSync('.env.host')) copyFileSync('.env.host.example', '.env.host');

const deps = ['postgres-db', 'valkey-cache', 'nats-events', 'seaweedfs-storage', 'seaweedfs-storage-init', 'flagd-flags', 'mailpit-email'];
const compose = ['compose', '-f', 'compose.yaml', '-f', 'compose.dev.yaml', '--profile', 'core', '--profile', 'devtools'];
const up = spawnSync('docker', [...compose, 'up', '-d', ...deps], { stdio: 'inherit' });
if (up.status !== 0) {
  console.error('Failed to start dependency containers.');
  process.exit(up.status ?? 1);
}
// `up --wait` treats the one-shot seaweedfs-storage-init (exits 0) as a failure, so poll health ourselves.
const longRunning = deps.filter((d) => d !== 'seaweedfs-storage-init' && d !== 'flagd-flags'); // flagd-flags image has no healthcheck
const deadline = Date.now() + 180_000;
for (;;) {
  const states = longRunning.map((d) =>
    spawnSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', `bananagig-${d}`], { encoding: 'utf8' }).stdout.trim(),
  );
  if (states.every((x) => x === 'healthy')) break;
  if (Date.now() > deadline) {
    console.error(`Timed out waiting for healthy containers: ${longRunning.filter((_, i) => states[i] !== 'healthy').join(', ')}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
// Create the migration baseline so apps and tests find schema_migrations.
spawnSync('node', ['--env-file=.env.host', 'scripts/migrate.mjs'], { stdio: 'inherit', env: { ...process.env, DATABASE_URL_HOST: '' } });

if (process.argv.includes('--deps-only')) process.exit(0);
console.log('\nweb http://localhost:3210  api http://localhost:3211  worker health http://localhost:3212\n');
const run = spawn('npx', ['turbo', 'run', 'dev', '--ui=stream'], { stdio: 'inherit', env: { ...process.env, WEB_DEV_PORT: '3210' } });
run.on('exit', (code) => process.exit(code ?? 0));

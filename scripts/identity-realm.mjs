// pnpm identity:check              lint infra/keycloak/bananagig-realm.json against the identity policy
// pnpm identity:build-prod -- --web-url https://app.example.com --admin-url https://admin.example.com [--out realm.json]
//                                  build a production realm (dev-only clients/users removed, admin OTP required, service-account users kept,
//                                  dev secret and dev SMTP server stripped) and lint it
import { readFileSync, writeFileSync } from 'node:fs';
import { buildProductionRealm, lintRealm, SMTP_NOTICE } from './lib/realm.mjs';

const arg = (k) =>
  process.argv
    .find((a) => a.startsWith(`--${k}=`))
    ?.split('=')
    .slice(1)
    .join('=') ?? (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : undefined);
const dev = JSON.parse(readFileSync(new URL('../infra/keycloak/bananagig-realm.json', import.meta.url), 'utf8'));
const fail = (problems) => {
  console.error(`identity realm policy violations:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
};
if (process.argv.includes('--build-prod')) {
  let realm;
  try {
    realm = buildProductionRealm(dev, { webUrl: arg('web-url'), adminUrl: arg('admin-url') });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const problems = lintRealm(realm, { production: true });
  if (problems.length) fail(problems);
  console.error(`notice: ${SMTP_NOTICE}`);
  const out = arg('out');
  if (out) {
    writeFileSync(out, `${JSON.stringify(realm, null, 2)}\n`);
    console.log(`production realm written to ${out} (${realm.clients.length} clients, ${realm.users.length} service-account users)`);
  } else console.log(JSON.stringify(realm, null, 2));
} else {
  const problems = lintRealm(dev);
  if (problems.length) fail(problems);
  const service = dev.users.filter((u) => u.serviceAccountClientId).length;
  console.log(`identity realm policy: OK (${dev.clients.length} clients, ${dev.users.length - service} dev users, ${service} service-account users)`);
}

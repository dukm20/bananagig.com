// DEV ONLY: re-applies infra/keycloak/bananagig-realm.json to a RUNNING local Keycloak (delete + recreate the realm).
// `--import-realm` skips a realm that already exists, so edits to the file need this (or `pnpm stack:reset`).
// Destroys local users/sessions in that realm. Refuses to run unless the target looks local.
import { readFileSync } from 'node:fs';

const base = (process.env.KEYCLOAK_ADMIN_URL || 'http://127.0.0.1:18081').replace(/\/$/, '');
if (!/^https?:\/\/(127\.0\.0\.1|localhost|keycloak-auth)(:\d+)?$/.test(base)) {
  console.error(`identity:sync refuses to touch non-local Keycloak (${base})`);
  process.exit(1);
}
const realm = JSON.parse(readFileSync(new URL('../infra/keycloak/bananagig-realm.json', import.meta.url), 'utf8'));
const tokenRes = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'password',
    client_id: 'admin-cli',
    username: process.env.KEYCLOAK_ADMIN || 'admin',
    password: process.env.KEYCLOAK_ADMIN_PASSWORD || 'admin_dev_only',
  }),
});
if (!tokenRes.ok) {
  console.error(`admin login failed (${tokenRes.status})`);
  process.exit(1);
}
const { access_token: token } = await tokenRes.json();
const auth = { authorization: `Bearer ${token}` };
const del = await fetch(`${base}/admin/realms/${realm.realm}`, { method: 'DELETE', headers: auth });
if (![204, 404].includes(del.status)) {
  console.error(`delete realm failed (${del.status})`);
  process.exit(1);
}
const create = await fetch(`${base}/admin/realms`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(realm) });
if (create.status !== 201) {
  console.error(`create realm failed (${create.status})`);
  process.exit(1);
}
console.log(`realm ${realm.realm} re-imported from infra/keycloak/bananagig-realm.json`);

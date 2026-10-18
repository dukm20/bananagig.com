// Stop hook: ADVISORY ONLY (never blocks, never asks Claude to continue). Warns the user when production source changed after the last
// recorded successful verification (.claude/state/verify.json). Honours stop_hook_active so it cannot loop.
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { git, gitTopLevel, isProductionSource, projectRoot, readJson, readVerify, runAdvisory, statePath, writeJsonAtomic } from './lib.mjs';
import { isTestClass } from './shell.mjs';

/** Modified / untracked files from `git status --porcelain=v1 -z`. */
function changedFiles(top) {
  const r = git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!r.ok) return null;
  const parts = r.out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    files.push(entry.slice(3));
    if (xy[0] === 'R' || xy[0] === 'C') i += 1; // the next item is the original path
  }
  return files;
}

await runAdvisory('stop', (event) => {
  if (event.stop_hook_active === true) return null;
  const root = projectRoot(event);
  const top = gitTopLevel(path.join(root, 'package.json'));
  if (!top) return null;
  const files = changedFiles(top);
  if (!files) return null;

  const verify = readVerify(root);
  const passed = verify.entries.filter((e) => e.status === 'passed' && Number.isFinite(Date.parse(e.at)));
  const lastPass = passed.length ? Math.max(...passed.map((e) => Date.parse(e.at))) : 0;

  const changed = [];
  for (const rel of files) {
    if (!isProductionSource(rel)) continue;
    try {
      changed.push({ rel, m: statSync(path.join(top, rel)).mtimeMs });
    } catch {
      // deleted file: nothing to compare
    }
  }
  if (!changed.length) return null;

  // Required evidence per the standard: formatter, lint, typecheck and tests must each have a passing run recorded AFTER the latest change.
  const newest = Math.max(...changed.map((c) => c.m));
  const sincePass = (pred) => passed.some((e) => pred(e) && Date.parse(e.at) >= newest);
  const missing = [
    ['format:check', (e) => e.class === 'format:check'],
    ['lint', (e) => e.class === 'lint'],
    ['typecheck', (e) => e.class === 'typecheck'],
    ['tests', (e) => isTestClass(e.class)],
  ]
    .filter(([, pred]) => !sincePass(pred))
    .map(([n]) => n);
  if (!missing.length) return null;
  const stale = changed.filter((c) => c.m > lastPass);
  const shown = stale.length ? stale : changed;
  const listed = `${shown
    .slice(0, 5)
    .map((c) => c.rel)
    .join(', ')}${shown.length > 5 ? ', ...' : ''}`;
  const sessionId = typeof event.session_id === 'string' ? event.session_id : 'unknown';
  const fingerprint = createHash('sha256')
    .update(
      changed
        .map((c) => `${c.rel}:${c.m}`)
        .sort()
        .join('\n') + `|${missing.join(',')}`,
    )
    .digest('hex');
  const stateFile = statePath(root, 'stop.json');
  const previous = readJson(stateFile, null);
  if (previous && previous.session_id === sessionId && previous.fingerprint === fingerprint) return null; // already warned for exactly this state
  writeJsonAtomic(stateFile, { session_id: sessionId, fingerprint });

  const lastEntry = passed.length ? passed.reduce((a, b) => (Date.parse(b.at) >= Date.parse(a.at) ? b : a)) : null;
  const last = lastEntry ? `${lastEntry.class} at ${lastEntry.at}` : 'none recorded in this checkout';
  const lead = stale.length
    ? `changes were made after the last recorded successful verification (${last}): report as NOT VERIFIED.`
    : `the verification recorded since the latest change is incomplete (last pass: ${last}): report as NOT VERIFIED.`;
  return {
    systemMessage: `BananaGig: ${lead} Production files: ${listed}. No passing run recorded since the latest change for: ${missing.join(', ')}. This is local hook evidence only; CI is the independent gate.`,
  };
});

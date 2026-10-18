// PostToolUse (Edit|Write|MultiEdit): advisory reminder after production-source edits, with the standard's risk class for sensitive paths.
// Never blocks. Announces each reminder once per session (state in .claude/state/post-edit.json) to keep the context small.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { gitTopLevel, isProductionSource, projectRoot, readJson, realpathLoose, riskClass, runAdvisory, statePath, toPosix, writeJsonAtomic } from './lib.mjs';

await runAdvisory('post-edit', (event) => {
  if (event.tool_name && !['Edit', 'Write', 'MultiEdit'].includes(event.tool_name)) return null;
  const target = event.tool_input && event.tool_input.file_path;
  if (typeof target !== 'string' || !target) return null;
  const abs = path.resolve((typeof event.cwd === 'string' && event.cwd) || process.cwd(), target);
  const root = projectRoot(event);
  const top = gitTopLevel(abs) ?? realpathLoose(root);
  const rel = toPosix(path.relative(top, realpathLoose(abs)));
  if (!isProductionSource(rel)) return null;

  const file = statePath(root, 'post-edit.json');
  const sessionId = typeof event.session_id === 'string' ? event.session_id : 'unknown';
  let state = readJson(file, null);
  if (!state || state.session_id !== sessionId || !Array.isArray(state.announced)) state = { session_id: sessionId, announced: [] };

  const risk = riskClass(rel);
  const messages = [];
  if (!state.announced.includes('generic')) {
    state.announced.push('generic');
    messages.push(
      'Production source was edited. Before reporting this work as complete, run pnpm format:check, pnpm lint, pnpm typecheck and the relevant tests (pnpm test; pnpm test:integration for persistence or API changes), and report anything not run as NOT VERIFIED.',
    );
  }
  if (risk) {
    const key = `risk:${risk.cls}:${risk.area}`;
    if (!state.announced.includes(key)) {
      state.announced.push(key);
      const std = existsSync(path.join(top, 'docs/engineering/PRODUCTION_STANDARD.md')) ? ' (docs/engineering/PRODUCTION_STANDARD.md)' : '';
      messages.push(
        `${rel} is risk class ${risk.cls}: ${risk.area}${std}. ${risk.cls === 'P0' ? 'P0 requires independent review and dedicated failure tests; do not self-approve.' : 'P1 requires integration tests and a rollout plan.'}`,
      );
    }
  }
  if (rel.startsWith('db/migrations/') && !state.announced.includes('migration')) {
    state.announced.push('migration');
    messages.push(
      'Migration touched: forward-only, never edit an applied migration; update the data-model documents (pnpm data-model:check) and schema snapshot.',
    );
  }
  if (messages.length) writeJsonAtomic(file, state);
  return messages.length
    ? {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: messages.join(' '),
        },
      }
    : null;
});

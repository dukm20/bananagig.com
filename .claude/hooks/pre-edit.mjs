// PreToolUse (Edit|Write|MultiEdit|NotebookEdit) guard: applied migrations, secrets files, secret-looking content (scanned on the
// POST-edit text), quality-gate/config files, disabled tests; advisory notes for new lint/type suppressions. Fails safe: unreadable
// input, a time-budget overrun or an internal error asks.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  addedDisabledTests,
  addedSuppressions,
  classifyMigrationWrite,
  gitTopLevel,
  isEnvName,
  isGateFile,
  isTestFile,
  judgeSecrets,
  projectRoot,
  realpathLoose,
  runGuard,
  rx,
  scanSecrets,
  startBudget,
  toPosix,
} from './lib.mjs';

const TOOLS_BY_KEY = new Map(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].map((t) => [t.toLowerCase(), t]));
const NON_EDIT_TOOLS = new Set(['read', 'grep', 'glob', 'bash', 'webfetch', 'websearch', 'task', 'agent', 'todowrite', 'skill']);
const EXAMPLE_SUFFIX = /\.(?:example|sample|template)$/;

function readExisting(abs) {
  try {
    if (existsSync(abs) && statSync(abs).size < 2_000_000) return readFileSync(abs, 'utf8');
  } catch {
    // unreadable: treat as unknown
  }
  return '';
}

/** The text being replaced and the text replacing it (used for the disabled-test and suppression counts). */
function contents(tool, input, abs) {
  if (tool === 'Write') return { oldText: readExisting(abs), newText: String(input.content ?? '') };
  if (tool === 'Edit')
    return {
      oldText: String(input.old_string ?? ''),
      newText: String(input.new_string ?? ''),
    };
  if (tool === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return {
      oldText: edits.map((e) => String(e?.old_string ?? '')).join('\n'),
      newText: edits.map((e) => String(e?.new_string ?? '')).join('\n'),
    };
  }
  return { oldText: '', newText: String(input.new_source ?? '') };
}

function applyEdit(text, oldString, newString, replaceAll) {
  if (!oldString || !text.includes(oldString)) return text;
  return replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
}

/** The whole file as it will be after the edit (MultiEdit edits applied in order), so a token split across edits is still seen. */
function postEditText(tool, input, existing) {
  if (tool === 'Write') return String(input.content ?? '');
  if (tool === 'Edit') return applyEdit(existing, String(input.old_string ?? ''), String(input.new_string ?? ''), input.replace_all === true);
  if (tool === 'MultiEdit') {
    let text = existing;
    for (const e of Array.isArray(input.edits) ? input.edits : [])
      text = applyEdit(text, String(e?.old_string ?? ''), String(e?.new_string ?? ''), e?.replace_all === true);
    return text;
  }
  return String(input.new_source ?? '');
}

const secretKey = (f) => `${f.label}\0${f.match}`;

await runGuard('Edit', (event) => {
  startBudget(8000);
  const toolName = event.tool_name;
  // exact names are expected; a differently-capitalised edit tool is still evaluated (fail safe), known non-edit tools are ignored
  const tool = TOOLS_BY_KEY.get(String(toolName ?? '').toLowerCase()) ?? (toolName && NON_EDIT_TOOLS.has(String(toolName).toLowerCase()) ? null : 'Write');
  if (toolName && tool === null) return { decision: 'allow' };
  const input = event.tool_input;
  const target = input && (input.file_path ?? input.notebook_path);
  if (!input || typeof target !== 'string' || !target) {
    return {
      decision: 'ask',
      reasons: ['tool_input.file_path / notebook_path is missing, so the edit target cannot be evaluated'],
    };
  }
  if (target.includes('\0')) return { decision: 'ask', reasons: ['the edit target path contains a NUL byte'] };
  const abs = path.resolve((typeof event.cwd === 'string' && event.cwd) || process.cwd(), target);
  const real = realpathLoose(abs);
  const name = path.basename(abs);
  const deny = [];
  const ask = [];
  const context = [];

  // secrets files (also reached through a symlink or, on case-insensitive file systems, by another capitalisation)
  const realName = path.basename(real);
  if (isEnvName(name) || isEnvName(realName)) {
    deny.push(
      `${isEnvName(name) ? name : realName} holds local secrets and is never written by the agent (edit .env.example / .env.host.example for documented defaults)`,
    );
  } else if (rx(/^\.env\..+/).test(name) && !EXAMPLE_SUFFIX.test(name)) ask.push(`${name} looks like a local secrets file`);

  // applied migrations
  const mig = classifyMigrationWrite(abs);
  if (mig && mig.level === 'deny') deny.push(mig.message);
  else if (mig && mig.level === 'ask') ask.push(mig.message);

  // quality gates / configuration
  const top = gitTopLevel(abs);
  const relBase = top ?? realpathLoose(projectRoot(event));
  const rel = toPosix(path.relative(relBase, real));
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && isGateFile(rel)) {
    ask.push(
      `${rel} is a quality-gate / CI / tooling / Claude-configuration file; weakening it needs the user's explicit approval${rel.startsWith('.claude/') ? ' (hook self-protection)' : ''}`,
    );
  }

  const existing = readExisting(abs);
  const { oldText, newText } = contents(tool, input, abs);

  // secret-looking content: compare the post-edit file with the pre-edit file so only ADDED tokens count
  const after = postEditText(tool, input, existing);
  const before = new Set(scanSecrets(existing).map(secretKey));
  const joinedNew = tool === 'MultiEdit' ? (Array.isArray(input.edits) ? input.edits : []).map((e) => String(e?.new_string ?? '')).join('') : '';
  const added = [...scanSecrets(after), ...scanSecrets(newText), ...scanSecrets(joinedNew)].filter((f) => !before.has(secretKey(f)));
  const verdict = judgeSecrets(added, rel && !rel.startsWith('..') ? rel : abs);
  if (verdict.deny.length) deny.push(`the edit adds ${verdict.deny.join(', ')}; never write credentials into the repository`);
  if (verdict.ask.length) {
    ask.push(
      `the edit adds ${verdict.ask.join(', ')} next to a secret-scan:allow marker, but not in the documented fake-fixture shape (a test or fixture file and an obviously fake token); confirm it is not a real credential`,
    );
  }

  // disabled tests
  if (isTestFile(rel && !rel.startsWith('..') ? rel : name)) {
    const disabled = addedDisabledTests(oldText, newText);
    if (disabled.length)
      ask.push(`the edit adds disabled or focused tests (${disabled.join(', ')}); the standard forbids disabled tests, fix the test or the code instead`);
  }

  // suppressions: advisory only
  const suppressions = addedSuppressions(oldText, newText);
  if (suppressions.length) context.push(`Advisory: this edit adds ${suppressions.join('; ')}. State the reason next to the suppression or remove it.`);

  if (deny.length) return { decision: 'deny', reasons: [...deny, ...ask], context };
  if (ask.length) return { decision: 'ask', reasons: ask, context };
  return { decision: 'allow', context };
});

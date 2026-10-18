// PostToolUse + PostToolUseFailure (Bash): record verification evidence in .claude/state/verify.json (git-ignored, bounded).
// A run is recorded "passed" only when Claude Code delivered it as a successful PostToolUse AND the command shape makes the exit status
// trustworthy (no pipe without pipefail, no `|| true`, no `;`-chain after it). Anything uncertain is "unknown", never "passed".
// Advisory only: this is local evidence for the Stop hook, not release enforcement (CI and GitHub rulesets are).
import { MAX_VERIFY_ENTRIES, projectRoot, readVerify, runAdvisory, verifyPath, writeJsonAtomic } from './lib.mjs';
import { commandInfo, parseShell, verificationClass } from './shell.mjs';

// A run that did not actually exercise the code is never evidence: help/version/list output, or a test run that matched no tests.
const NOT_A_RUN_FLAGS = /^(?:--help|-h|--version|-v|-V|--listTests|--list|--list-tests|--showConfig|--dry-run)$/;
const NO_TESTS_OUTPUT =
  /no test files? found|no tests? found|no tests? (?:to run|ran|matched)|tests?\s+no tests|collected 0 items|ran 0 tests|0 tests? (?:passed|ran|run)|no projects matched the filters|no tasks to run/i;

const CONTROL_WORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'for', 'do', 'done', 'case', 'esac', '!']);

function exitCodeFrom(event) {
  const r = event.tool_response;
  if (r && typeof r === 'object') {
    for (const k of ['exitCode', 'exit_code', 'returnCode', 'return_code', 'code']) if (typeof r[k] === 'number') return r[k];
  }
  const m = /^Exit code (\d+)/.exec(String(event.error ?? ''));
  return m ? Number(m[1]) : null;
}

await runAdvisory('post-bash', (event) => {
  if (event.tool_name && event.tool_name !== 'Bash') return null;
  const command = event.tool_input && event.tool_input.command;
  if (typeof command !== 'string' || !command.trim()) return null;
  let segs;
  try {
    segs = parseShell(command);
  } catch {
    return null; // unparseable commands are not recorded as evidence
  }
  const verifying = segs.map((s, i) => ({ i, cls: verificationClass(s) })).filter((x) => x.cls);
  if (!verifying.length) return null;

  // --help / --version / --listTests: nothing was verified, record nothing
  if (verifying.some((v) => commandInfo(segs[v.i]).args.some((a) => NOT_A_RUN_FLAGS.test(a)))) return null;

  const exit = exitCodeFrom(event);
  const response = event.tool_response && typeof event.tool_response === 'object' ? event.tool_response : {};
  let status;
  if (event.hook_event_name === 'PostToolUseFailure') status = event.is_interrupt ? 'interrupted' : 'failed';
  else if (response.interrupted === true) status = 'interrupted';
  else if (exit !== null && exit !== 0) status = 'failed';
  else if (event.tool_input.run_in_background === true) status = 'unknown';
  else {
    // exit status of a list is the last command's; make sure the verification command decides it
    const first = verifying[0].i;
    const tail = segs.slice(first);
    const pipefail = segs.some((s) => commandInfo(s).cmd === 'set' && s.words.join(' ').includes('pipefail'));
    const opBefore = segs[first].op;
    const controlFlow = segs.some((s) => CONTROL_WORDS.has(s.words[0]));
    const reliable =
      !controlFlow &&
      !segs.some((s) => s.background) &&
      opBefore !== '||' &&
      opBefore !== '&' &&
      tail.slice(1).every((s) => s.op === '&&' || (s.op === '|' && pipefail));
    status = reliable ? 'passed' : 'unknown';
    // a green exit that ran zero tests proves nothing
    const output = `${response.stdout ?? ''}\n${response.stderr ?? ''}`;
    if (status === 'passed' && NO_TESTS_OUTPUT.test(output)) status = 'unknown';
  }

  const root = projectRoot(event);
  const store = readVerify(root);
  const at = new Date().toISOString();
  for (const v of verifying) {
    store.entries.push({
      command: command.length > 300 ? `${command.slice(0, 300)}...` : command,
      class: v.cls,
      status,
      exit,
      at,
      session_id: typeof event.session_id === 'string' ? event.session_id : null,
    });
  }
  store.entries = store.entries.slice(-MAX_VERIFY_ENTRIES);
  writeJsonAtomic(verifyPath(root), store);
  return null;
});

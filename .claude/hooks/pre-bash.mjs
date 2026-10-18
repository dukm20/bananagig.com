// PreToolUse (Bash) guard. Parses the structured hook event, tokenizes the command with the shell parser in shell.mjs and evaluates every
// simple command (including nested substitutions and `bash -c` scripts) in bash.mjs. DENY / ASK / allow-by-silence. Fails safe: unreadable
// input or an internal error produces an "ask" decision. See .claude/hooks/README.md for the decision table.
import { analyzeBash } from './bash.mjs';
import { projectRoot, runGuard } from './lib.mjs';

await runGuard('Bash', (event) => {
  if (event.tool_name && event.tool_name !== 'Bash') return { decision: 'allow' };
  const input = event.tool_input;
  if (!input || typeof input.command !== 'string') {
    return {
      decision: 'ask',
      reasons: ['tool_input.command is missing or not a string, so the command cannot be evaluated'],
    };
  }
  if (!input.command.trim()) return { decision: 'allow' };
  const findings = analyzeBash(input.command, {
    cwd: (typeof event.cwd === 'string' && event.cwd) || process.cwd(),
    root: projectRoot(event),
  });
  const deny = findings.filter((f) => f.level === 'deny');
  const ask = findings.filter((f) => f.level === 'ask');
  if (deny.length)
    return {
      decision: 'deny',
      reasons: [...deny, ...ask].map((f) => f.message),
    };
  if (ask.length) return { decision: 'ask', reasons: ask.map((f) => f.message) };
  return { decision: 'allow' };
});

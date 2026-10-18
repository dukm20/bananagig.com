// Long-option tables for the guarded git subcommands (ENG-GOV-001). The hook asks the installed git (`git <sub> -h`) at run time and
// only falls back to these snapshots (git 2.54) when that fails. `--[no-]x` means both --x and --no-x exist.
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const SNAPSHOT = {
  reset:
    '--[no-]auto-advance --[no-]intent-to-add --[no-]patch --[no-]pathspec-file-nul --[no-]pathspec-from-file --[no-]quiet --[no-]recurse-submodules --hard --inter-hunk-context --keep --merge --mixed --no-refresh --patch --pathspec-file-nul --pathspec-from-file --refresh --soft --unified',
  commit:
    '--[no-]ahead-behind --[no-]all --[no-]amend --[no-]author --[no-]branch --[no-]cleanup --[no-]date --[no-]dry-run --[no-]edit --[no-]file --[no-]fixup --[no-]gpg-sign --[no-]include --[no-]interactive --[no-]long --[no-]message --[no-]null --[no-]only --[no-]patch --[no-]pathspec-file-nul --[no-]pathspec-from-file --[no-]porcelain --[no-]quiet --[no-]reedit-message --[no-]reset-author --[no-]reuse-message --[no-]short --[no-]signoff --[no-]squash --[no-]status --[no-]template --[no-]trailer --[no-]untracked-files --[no-]verbose --allow-empty --allow-empty-message --amend --author --cleanup --date --dry-run --fixup --inter-hunk-context --interactive --no-post-rewrite --no-verify --patch --pathspec-file-nul --pathspec-from-file --post-rewrite --reset-author --squash --trailer --unified --verify',
  clean: '--[no-]dry-run --[no-]force --[no-]interactive --[no-]quiet --exclude',
  push: '--[no-]all --[no-]atomic --[no-]branches --[no-]delete --[no-]dry-run --[no-]exec --[no-]follow-tags --[no-]force --[no-]force-if-includes --[no-]force-with-lease --[no-]mirror --[no-]porcelain --[no-]progress --[no-]prune --[no-]push-option --[no-]quiet --[no-]receive-pack --[no-]recurse-submodules --[no-]repo --[no-]set-upstream --[no-]signed --[no-]tags --[no-]thin --[no-]verbose --all --branches --ipv4 --ipv6 --mirror --no-verify --verify',
  add: '--[no-]all --[no-]auto-advance --[no-]chmod --[no-]dry-run --[no-]edit --[no-]force --[no-]ignore-errors --[no-]ignore-missing --[no-]ignore-removal --[no-]intent-to-add --[no-]interactive --[no-]patch --[no-]pathspec-file-nul --[no-]pathspec-from-file --[no-]refresh --[no-]renormalize --[no-]sparse --[no-]update --[no-]verbose --inter-hunk-context --no-all --pathspec-from-file --unified',
  rebase:
    '--[no-]autosquash --[no-]autostash --[no-]committer-date-is-author-date --[no-]exec --[no-]force-rebase --[no-]fork-point --[no-]gpg-sign --[no-]ignore-whitespace --[no-]keep-base --[no-]onto --[no-]quiet --[no-]reapply-cherry-picks --[no-]rebase-merges --[no-]rerere-autoupdate --[no-]reschedule-failed-exec --[no-]reset-author-date --[no-]root --[no-]signoff --[no-]strategy --[no-]strategy-option --[no-]trailer --[no-]update-refs --[no-]verbose --[no-]whitespace --abort --apply --continue --edit-todo --empty --exec --ff --fork-point --interactive --keep-base --merge --no-ff --no-stat --no-verify --onto --quit --root --show-current-patch --skip --stat --verify',
  branch:
    '--[no-]abbrev --[no-]color --[no-]column --[no-]copy --[no-]create-reflog --[no-]delete --[no-]edit-description --[no-]force --[no-]format --[no-]ignore-case --[no-]list --[no-]move --[no-]omit-empty --[no-]points-at --[no-]quiet --[no-]recurse-submodules --[no-]set-upstream-to --[no-]show-current --[no-]sort --[no-]track --[no-]unset-upstream --[no-]verbose --all --contains --format --merged --no-contains --no-merged --points-at --recurse-submodules --remotes',
  checkout:
    '--[no-]auto-advance --[no-]conflict --[no-]detach --[no-]force --[no-]guess --[no-]ignore-other-worktrees --[no-]ignore-skip-worktree-bits --[no-]merge --[no-]orphan --[no-]overlay --[no-]overwrite-ignore --[no-]patch --[no-]pathspec-file-nul --[no-]pathspec-from-file --[no-]progress --[no-]quiet --[no-]recurse-submodules --[no-]track --inter-hunk-context --ours --pathspec-from-file --theirs --unified',
  restore:
    '--[no-]conflict --[no-]ignore-skip-worktree-bits --[no-]ignore-unmerged --[no-]merge --[no-]overlay --[no-]patch --[no-]pathspec-file-nul --[no-]pathspec-from-file --[no-]progress --[no-]quiet --[no-]recurse-submodules --[no-]source --[no-]staged --[no-]worktree --inter-hunk-context --ours --pathspec-from-file --source --theirs --unified',
  merge:
    '--[no-]abort --[no-]allow-unrelated-histories --[no-]autostash --[no-]cleanup --[no-]commit --[no-]compact-summary --[no-]continue --[no-]edit --[no-]ff --[no-]gpg-sign --[no-]into-name --[no-]log --[no-]message --[no-]overwrite-ignore --[no-]progress --[no-]quiet --[no-]quit --[no-]rerere-autoupdate --[no-]signoff --[no-]squash --[no-]stat --[no-]strategy --[no-]strategy-option --[no-]summary --[no-]verbose --[no-]verify-signatures --abort --continue --ff-only --file --no-verify --stat --verify',
  am: '--[no-]committer-date-is-author-date --[no-]directory --[no-]exclude --[no-]gpg-sign --[no-]ignore-date --[no-]ignore-space-change --[no-]ignore-whitespace --[no-]include --[no-]interactive --[no-]keep --[no-]keep-cr --[no-]keep-non-patch --[no-]message-id --[no-]patch-format --[no-]quiet --[no-]reject --[no-]rerere-autoupdate --[no-]resolvemsg --[no-]scissors --[no-]signoff --[no-]utf8 --[no-]whitespace --abort --allow-empty --continue --empty --keep-cr --no-verify --quit --quoted-cr --resolved --retry --show-current-patch --skip --verify',
  'cherry-pick':
    '--[no-]allow-empty --[no-]allow-empty-message --[no-]cleanup --[no-]edit --[no-]ff --[no-]gpg-sign --[no-]keep-redundant-commits --[no-]mainline --[no-]rerere-autoupdate --[no-]signoff --[no-]strategy --[no-]strategy-option --abort --commit --continue --edit --empty --ff --no-commit --quit --skip',
};

function parseOptionNames(text) {
  const names = new Set();
  for (const m of String(text).matchAll(/--(\[no-\])?([a-zA-Z][a-zA-Z0-9-]*)/g)) {
    names.add(m[2]);
    if (m[1]) names.add(`no-${m[2]}`);
  }
  return names;
}

const tables = new Map();
/** Known long option names (without the leading dashes) for a git subcommand, from the installed git when possible. */
export function gitOptionNames(sub) {
  if (tables.has(sub)) return tables.get(sub);
  let names = null;
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  try {
    execFileSync('git', [sub, '-h'], {
      cwd: tmpdir(),
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
  } catch (e) {
    // `git <sub> -h` prints its usage and exits 129
    const text = `${e && e.stdout ? e.stdout : ''}${e && e.stderr ? e.stderr : ''}`;
    if (e && e.status === 129 && text.includes('--')) names = parseOptionNames(text);
  }
  if (!names || names.size < 3) names = parseOptionNames(SNAPSHOT[sub] ?? '');
  tables.set(sub, names);
  return names;
}

export const GUARDED_GIT_SUBCOMMANDS = new Set(Object.keys(SNAPSHOT));

/**
 * Resolve a (possibly abbreviated) long option the way git does: an exact name wins, otherwise a unique prefix.
 * Returns the full name, or null when the option is unknown or ambiguous.
 */
export function canonicalGitOption(sub, name) {
  const names = gitOptionNames(sub);
  if (names.has(name)) return name;
  const hits = [...names].filter((n) => n.startsWith(name));
  return hits.length === 1 ? hits[0] : null;
}

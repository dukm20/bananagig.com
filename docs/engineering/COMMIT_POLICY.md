# Commit Policy

## Convention

```
<type>(<checkpoint>): <description>
```

Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`. The checkpoint id is mandatory (`INF-003`, `BAN-006`, ...). Subject in the imperative, no trailing period.

Examples: `chore(INF-001): establish local platform containers` · `feat(ID-002): implement email verification` · `feat(BAN-006): add fifo banana credit allocation` · `fix(BAN-006): prevent duplicate lot allocation` · `docs(META-001): add repository learning system`.

## Rules

- A checkpoint normally ends in **one coherent commit**. A small, documented series is acceptable only when a migration must be separated from code. No meaningless "auto update" or "wip" commits.
- Commit only after the validation gate passes (`pnpm checkpoint:finalize`). Do not commit unless the user asked for commits in the checkpoint.
- Never commit `.env`, `.env.host`, secrets, build output or `.checkpoint/`.
- Never push, force-push, amend unrelated commits or rewrite history from checkpoint tooling. Pushing is a separate, explicit human action.
- The implementation-history entry cannot contain its own commit hash. Find a checkpoint's commit with `git log --grep "(<ID>)"`.

## Flow

```bash
pnpm checkpoint:start BAN-001                 # clean tree, state, latest migration, relevant debt

# ... implement the checkpoint, update knowledge docs, data model docs when persistence changed ...

pnpm checkpoint:finalize BAN-001 --skill-update=NOT_REQUIRED   # or UPDATED; runs every gate, exits non-zero on failure
pnpm checkpoint:commit BAN-001 "feat(BAN-001): add configurable Banana credit packs"
```

`checkpoint:finalize` runs: format, lint, typecheck, unit tests, integration tests, workspace boundaries, spec drift and validation, migration/snapshot/data-model gate, skills and ADR checks, project-state checks. It records a fingerprint of the working tree.

`checkpoint:commit` refuses unless: the last finalization passed and the tree is unchanged since; the message follows the convention; no forbidden files (env, secrets, build output); no files outside the checkpoint scope (resolve explicitly or `--include <path>`); no secret-looking content. It stages an explicit file list (never `git add -A`) and creates one commit. `--dry-run` shows what would be committed. `--trailer "<line>"` appends commit trailers (for example the Co-Authored-By line required by the session). It never pushes.

## First baseline commit

The repository was created before any commit existed. The first commit is the baseline for INF-001, INF-002 and META-001 together; use the same message convention and review `git status` for env files first.

```bash
git status --short
git add -A && git reset -q .env .env.host 2>/dev/null; git status --short | grep -E '\.env($|\.host$)' && echo STOP || \
git commit -m "chore(INF-002): establish platform, application skeletons and repository governance"
```

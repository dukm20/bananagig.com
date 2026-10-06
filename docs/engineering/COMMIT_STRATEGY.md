# Baseline Commit Strategy

The repository was initialized with `git init -b main` during INF-002. Nothing is pushed. A remote `origin` (github.com/dukm20/bananagig.com) appeared in `.git/config` after initialization; it was not configured by checkpoint work and is left untouched. Pushing is a manual, explicit step.

Baseline: after verification, make one coherent commit per completed checkpoint. For the first baseline, either a single commit or two (INF-001 platform, INF-002 applications) is fine; INF-001 and INF-002 were developed on the same working tree, so one baseline commit is simplest.

```bash
git status                      # review everything; .env and .env.host must NOT be listed
git add -A
git status --short | grep -E '\.env($|\.host$)' && echo "STOP: env file staged" || true
git commit -m "chore(INF-002): establish platform containers and application skeletons"
```

Commit messages use `<type>(<checkpoint>): <description>`. Never commit `.env`, `.env.host`, or build output (`dist`, `.next`); `.gitignore` covers them. Remote setup and CI execution are separate, explicit steps (CI is unexecuted until a remote exists).

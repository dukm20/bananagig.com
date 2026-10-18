# GitHub settings to apply (manual)

**State on 2026-10-18 (read-only, unauthenticated checks): none of the controls below are configured.** `main` reports `protected: false`, the rulesets list is empty, there are no environments and no pull request has ever been opened. Whether secret scanning, push protection and Dependabot alerts are enabled could not be read without authentication. No agent has configured anything on GitHub: Claude Code in this repository has no GitHub credentials, and these are owner decisions (standard: CI and rulesets enforce independently of Claude).

Repository: `https://github.com/dukm20/bananagig.com` (public).

Apply the steps as the repository owner, then run the verification commands at the end and keep their output with the checkpoint report. Until they pass, say **"not configured"**.

## 1. Ruleset for `main`

Settings → Rules → Rulesets → New branch ruleset (or the API call below with a token that has repository administration rights):

- Enforcement: **Active**. Target: `main` (include `refs/heads/main`).
- Restrict deletions. Block force pushes (non-fast-forward). Require linear history.
- Require a pull request before merging: **1 approval**, dismiss stale approvals on new commits, **require review from Code Owners** (the file is `.github/CODEOWNERS`), require conversation resolution.
- Require status checks to pass, branches up to date before merging: `verify`, `compose-smoke`. After one clean cycle of the new advisory workflows, add `policy-scan`, `secret-scan` and `workflow-lint` from `governance.yml`, and `Analyze` from `codeql.yml`. Confirm the exact check names on the first pull request's checks page before saving them.
- Optional: require signed commits (set up commit signing first; today every commit is unsigned).

Solo-owner note: GitHub does not let you approve your own pull request. With one required approval and a single maintainer you cannot merge. Either add a second reviewer, or add the repository **admin** role as a bypass actor limited to "pull request" bypass (the check and force-push rules stay in force), or keep the pull request and status-check requirements but set approvals to 0 and accept that review is then advisory. Choose one deliberately; the first option is the standard's intent for P0 changes.

API form (needs a token; shown for review, not run):

```json
POST /repos/dukm20/bananagig.com/rulesets
{
  "name": "main protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [ { "context": "verify" }, { "context": "compose-smoke" } ] } }
  ]
}
```

Consequence for how checkpoints are delivered: with this ruleset every checkpoint is a branch and a pull request, and `git push origin main` is refused. The checkpoint tooling (`pnpm checkpoint:commit`) already never pushes; the push step becomes "push the branch and open the pull request".

## 2. Code security

Settings → Code security (all free for a public repository):
- **Secret scanning**: enable. **Push protection**: enable.
- **Dependabot alerts** and **Dependabot security updates**: enable. (`.github/dependabot.yml` adds the version updates.)
- **Code scanning**: the `codeql.yml` workflow uploads results; confirm they appear under Security → Code scanning.
- **Private vulnerability reporting**: enable, and add a `SECURITY.md` (owner decision, see the plan item C-4).

## 3. Actions

Settings → Actions → General:
- Workflow permissions: **Read repository contents and packages permissions** (the workflows declare their own `permissions:`).
- Fork pull request workflows: **Require approval for first-time contributors** (or for all outside collaborators).
- Allow only actions you trust: GitHub-authored and verified creators, or an allow-list of the pinned actions used in `.github/workflows`.

## 4. Environments (when the first deployment exists)

Settings → Environments → `staging`, `production`: required reviewers (a human other than the author), deployment branches limited to `main`, secrets scoped per environment, never in repository secrets. There is no deploy job today, so there is nothing to approve yet.

## 5. Verify, read-only

Without authentication (works for this public repository):

```sh
curl -s https://api.github.com/repos/dukm20/bananagig.com/branches/main | grep '"protected"'
curl -s https://api.github.com/repos/dukm20/bananagig.com/rulesets
curl -s https://api.github.com/repos/dukm20/bananagig.com/environments
```

With a token (`GH_TOKEN` or `gh auth login`): `gh api repos/dukm20/bananagig.com/rulesets`, `gh api repos/dukm20/bananagig.com -q .security_and_analysis`, `gh api repos/dukm20/bananagig.com/actions/permissions/workflow`.

Expected after step 1: `"protected": true` and one ruleset named `main protection` with `enforcement: active`. Expected after step 2: `security_and_analysis` shows `secret_scanning` and `secret_scanning_push_protection` as `enabled`.

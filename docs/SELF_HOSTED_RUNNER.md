# Self-Hosted Runner

This repository can now deploy `main` and `dev` automatically through a repository-level self-hosted runner with the custom label `remux-deploy`.

## Why this setup

- deploys are triggered by `push` to `main` and `dev`
- deploy jobs run on the local Mac instead of a GitHub-hosted VM
- the workflow calls `scripts/sync-runtime.sh` so the deployed runtime is verified against the remote branch SHA
- the custom label avoids accidentally routing unrelated jobs onto the deployment machine

## Security boundary

This repository is public. Do not run self-hosted jobs for `pull_request` events from untrusted code.

The deploy workflow is intentionally limited to:

- `push` on `main`
- `push` on `dev`
- manual `workflow_dispatch`

Keep the runner dedicated to deployment work. Do not add plain `self-hosted` to unrelated workflows.

The deploy workflow also uses `actions/checkout` with `clean: false` so the checked-out workspace keeps the runtime worktrees under `.worktrees/`.

## Install the runner

```bash
npm run runner:install
```

Defaults:

- repo: current GitHub repository
- runner dir: `$HOME/actions-runner/remux-deploy`
- runner name: `<hostname>-remux-deploy`
- labels: `remux-deploy`

Override with environment variables when needed:

```bash
REMUX_RUNNER_ROOT="$HOME/actions-runner/remux-prod" \
REMUX_RUNNER_NAME="mac-mini-prod" \
REMUX_RUNNER_LABELS="remux-deploy,mac-mini" \
npm run runner:install
```

## Check runner status

```bash
npm run runner:status
```

## Remove the runner

```bash
npm run runner:remove
```

## Optional manual bootstrap

The `Deploy Runtime` workflow already runs `install-launchd` and `load-launchd`, so a manual bootstrap is not required after merge.

If you want to preheat the runtime services from the runner workspace clone before the first workflow run, use:

```bash
npm run runtime:install-launchd
bash scripts/load-launchd.sh all
```

After that, `Deploy Runtime` in GitHub Actions will keep the instances aligned.

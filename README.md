# omp-dynamic-workflows

OMP-native dynamic workflow orchestration, ported from
`pi-dynamic-workflows` against the current `@oh-my-pi/*` extension APIs.

## Install for local development

```bash
bun install
omp plugin link .
```

The package manifest exposes `extensions/workflow.ts` through
`omp.extensions` and bundles the `workflow-authoring` and `workflow-patterns`
skills through `omp.skills`.

## Features

- `workflow` and `workflow_control` tools
- Parallel and staged subagent workflows with model/tier routing
- Background runs, pause/resume/stop, durable journals, and result delivery
- Saved and built-in workflows, including deep research and code review
- OMP-native restricted child sessions with coding tools and optional web tools
- Worktree isolation under `.omp/worktrees` on `omp/wf/*` branches
- Interactive `/workflows`, `/workflows-models`, `/effort`, and navigator UI

Workflow state and settings live under `~/.omp/workflows`; project agent
definitions use `.omp/agents`.

## Verify

```bash
bun run check
bun test
bun run build
```

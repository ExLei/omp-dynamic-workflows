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

## Web console

A React/Vite UI over the **live** `WorkflowManager` — the same instance the TUI
navigator and task panel use, so runs, snapshots, and pause/resume/stop are
shared, not mirrored.

```bash
bun run web:build   # emit web/dist (once; the server serves it directly)
omp                 # console starts with the session
```

### Opening it

| | |
|---|---|
| `/workflows web` | opens the console in your default browser |
| `/workflows web url` | prints the URL only — SSH, or pasting into another machine |
| session start | prints `Workflow web console: http://127.0.0.1:<port>/?token=…  (/workflows web to open)` |
| `"web": { "open": true }` | opens the browser automatically on every session start |

The URL carries a per-process token, so it changes every launch and is not
recoverable from disk — `/workflows web` is the way back to it after the startup
notice scrolls away. Auto-open stays off by default: launching a browser on every
`omp` in every repo is hostile, and over SSH it is simply wrong (the opener
detects `SSH_CONNECTION`/no `DISPLAY` and tells you to use the URL instead).

### Why it can be on by default

Measured on this repo, the console adds **~3ms** to launch: ~2.5–3.2ms of module
evaluation plus ~0.5ms for the loopback bind, against omp's ~2.9s startup. An A/B
over `omp -p "" --no-session` (7 runs each) puts the delta at −3ms/+22ms — inside
run-to-run noise. Three rules keep it there, and
`tests/web-startup-budget.test.ts` fails the build if any of them is broken:

1. The entry reaches the server through a **dynamic, never-awaited** `import()`,
   deferred one macrotask past `session_start` — nothing sits before first paint.
2. The server's module graph is pinned to modules the plugin already loads. A new
   `@oh-my-pi/pi-coding-agent` value import would cost ~1.4s (see `src/omp-host.ts`).
3. The React asset root is stat'd on the first browser request, not at bind time,
   so a session where nobody opens the console touches no extra files.

The 889KB bundle is deliberately **not** code-split: over loopback it transfers in
5.4ms (FCP 164ms), and the editor and both graphs are visible on the first screen,
so lazy chunks would only add a flash.

### Configuration

`~/.omp/workflows/settings.json` (or the project override):

```json
{ "web": { "enabled": true, "port": 0, "announce": true, "open": false } }
```

`OMP_WORKFLOW_WEB` overrides it for one launch: `0`/`false`/`off` disables, an
integer above 1 pins that port, anything else enables with an ephemeral port.
`OMP_WORKFLOW_WEB_TOKEN` reuses a token across restarts.

The server binds loopback only and requires the token on every `/api/*` call:
starting a run executes arbitrary JS inside the omp process.

A run launched from the browser is written into the transcript but delivered with
`triggerTurn: false` — clicking Run in a web UI records context without waking the
TUI's assistant into an unsolicited (billable) turn.

### What it shows

Live run list, a runtime graph whose phases are containers holding the agents
they actually produced (built from real `agentStart`/`agentEnd` events), logs, an
SSE event feed, and the run's return value. Clicking any agent — in the graph or
the table — opens a right-hand drawer with that agent's untrimmed transcript,
refreshed live from `/api/runs/:id/agents/:id` while it runs; snapshot pushes stay
trimmed so a wide fan-out does not re-broadcast every transcript on each tick.

Authoring is a CodeMirror JS editor over the same script the tool and slash
commands run — no reduced graph DSL — beside a *best-effort* static structure
graph: containment is drawn as nesting (a `phase` owns the calls that follow it,
a `parallel` block owns its branches), execution order as arrows between
siblings, and anything whose fan-out is only decided at runtime is dashed.
Clicking a node reveals the call it came from in the editor.

Every region is a drag-resizable pane; layouts persist per group in
`localStorage`. Saving prompts for the project (`.omp/workflows/saved`) or
personal (`~/.omp/workflows/saved`) scope and registers the slash command
immediately.

Frontend development against a running server:

```bash
bun run spike:web            # standalone manager with simulated agents, port 7788
bun run web:dev              # Vite on :5178, proxies /api to :7788
```

## Verify

```bash
bun run check
bun test
bun run build
bun run web:build
```

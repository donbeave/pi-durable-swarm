# pi-durable-swarm

**Durable multi-agent orchestration for Pi, built for Muse Code supervision.**

One Pi coordinator owns up to **six workers — two per provider (Xiaomi MiMo,
MiniMax, Z.AI)** — whose conversations, tasks and results are committed to
SQLite by [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable)
before anything is shown. Kill Pi, restart it, reopen the project: queued and
running workers resume from their last durable checkpoint, and completed
results stay collectable. Nothing is silently lost, duplicated or substituted.

## Why this exists

A head-to-head evaluation of the ready-to-use Pi subagent extensions
(tintinweb/pi-subagents, xian0x5a/pi-durable-subagents,
anasalqoyyum/pi-durable-subagents, purboo/pi-durable-subagents, and the
Earendil Durable library) found that **no single implementation satisfied all
mandatory requirements at once**: durable recovery across a host kill, exact
provider/model identity with no cross-provider fallback, a hard bounded
six-worker concurrency limit, retained non-auto-committed worktrees, and
workflow-grade fan-out. Each finalist failed at least one (in-process workers
that die with the coordinator, fuzzy or pool-based model fallback, approximate
concurrency bounds, auto-committing worktree modes, or missing scheduling).
This extension implements exactly the missing combination on top of the
Earendil Durable harness. Full evidence:
[donbeave/pi-subagents EVALUATION.md](https://github.com/donbeave/pi-subagents/blob/master/EVALUATION.md).

## Install

```bash
pi install npm:pi-durable-swarm
# or from this repository:
pi install git:github.com/donbeave/pi-durable-swarm
```

Requires Pi 1.x and Node.js >= 22.19. The durable dependency is pinned
(`@earendil-works/pi-durable@1.0.0`, `@earendil-works/chord@1.0.0`) because
that harness API is experimental and changes between releases.

## Tools

| Tool | Purpose |
|---|---|
| `swarm_spawn` | Spawn one durable worker (background by default). Committed to storage before returning; admitted by the hard scheduler. |
| `swarm_status` | List workers with durable state, exact model and thinking (`/swarm` does the same). |
| `swarm_result` | Collect a result; `wait: true` blocks until the latest task settles. Failures return as errors, never as success. |
| `swarm_steer` | Steer a running worker at its next boundary, queue a follow-up, or continue an idle worker with its saved model/cwd. |
| `swarm_stop` | Stop one worker (queued or running) without affecting others. Conversation and worktree are retained. |

Background results are also delivered to the coordinator as follow-up
messages when workers finish.

## Workers and models (exact pins only)

| Worker | Role | Model | Thinking |
|---|---|---|---|
| W1 | `w1-scout` | `xiaomi-token-plan-sgp/mimo-v2.6-flash` | `high` |
| W2 | `w2-impl-strong` | `xiaomi-token-plan-sgp/mimo-v2.6-pro` | `high` |
| W3 | `w3-impl` | `minimax/MiniMax-M3.1-Flash` | `high` |
| W4 | `w4-audit` | `minimax/MiniMax-M3.1-Flash` | `max` |
| W5 | `w5-tests` | `zai/glm-5.3-flash` | `high` |
| W6 | `w6-fix-strong` | `zai/glm-5.3` | `max` |

Model policy is structural, not procedural:

- Only these five models are eligible. Fuzzy names, bare ids, other
  providers and older generations are **rejected before any durable state is
  created** — never substituted. (`xiaomi/<id>` is accepted as a documented
  alias of the local Xiaomi token-plan provider.)
- Thinking levels are validated per model (MiMo `off|high`, MiniMax
  `low|medium|high|xhigh|max`, GLM-5.3 family `low|high|max`). Unsupported
  levels are rejected, never silently clamped.
- There is no model pool and no failover. A quota error fails that worker
  visibly; reassign the task explicitly.

## Concurrency

Hard scheduler bounds, enforced from durable fleet state on every admission:
**max 6 running globally, max 2 per provider**, oldest queued first. Queued
workers start automatically as slots free, including after a restart.

## Worktrees

`swarm_spawn` with `isolation: "worktree"` (write roles only) creates a
retained Git worktree at recorded HEAD on branch `swarm/<agent>` under
`.pi/durable-swarm/worktrees/`. Parent uncommitted changes are never copied.
The extension never auto-commits, auto-merges, auto-removes or reuses a
worktree; the coordinator validates the reported changed files and integrates
manually. Worker instructions forbid commits and merges.

## Durability semantics

- State lives in `<project>/.pi/durable-swarm/swarm.sqlite` (project-local).
- Every spawn is a durable submission with an idempotent request id: retrying
  a spawn returns the original worker instead of duplicating it.
- Reads may replay after a crash; writes, edits and shell commands are marked
  replay-unsafe and are never blindly re-executed. A model request interrupted
  by a crash counts as a failed attempt and the conversation continues.
- While Pi is closed, work pauses; on reopen it resumes. (A separate daemon
  that keeps working while the host is dead is intentionally out of scope.)

## Verified behaviour (2026-11-11, Pi 1.5.0)

- Identical benchmark fixture as the extension evaluation: worker fixed both
  planted bugs, independent `npm test` 4/4, diff confined to `src/calc.js`,
  effective model `minimax/MiniMax-M3.1-Flash` — 35 s end to end.
- **Coordinator `kill -9` mid-worker** (worker interrupted inside a 60 s
  shell sleep): reopened Pi, `swarm_result` recovered the worker as
  `completed`, fix applied, tests 4/4.
- Six workers (W1–W6, two per provider) with 20 s sleeps each: all six tokens
  collected in 52 s including coordinator startup — real overlap, hard bounds.
- Ineligible model (`anthropic/claude-opus-4-8`) rejected with the eligible
  list; no worker spawned, no substitution.
- Unit tests: model/thinking policy, scheduler bounds, worktree retention —
  `npm test` (11 tests). Typecheck: `npm run typecheck`.

## Architecture

```text
Muse Code (objective, acceptance, escalation)
  -> Pi coordinator (this extension's swarm_* tools)
       -> Durable harness (SQLite): fleet doc, child conversations, runner tasks
            -> W1..W6 workers (durable coding tools, own cwd/worktree)
       -> Pi-owned collection, review, repair, integration
  <- milestone report with effective models and test evidence
```

## Development

```bash
npm install
npm test
npm run typecheck
```

MIT licensed. Built on `@earendil-works/pi-durable`; worker conversations use
Pi's own model registry, so credentials and providers are exactly Pi's.

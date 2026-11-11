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
| `swarm_fanout` | Deterministic fan-out: 1 to 6 workers in one call. `parallel` starts them under the scheduler bounds. `chain` runs steps in order and puts the previous result into the next task at `{previous}`. Use a chain for implement-then-review work. |
| `swarm_join` | Wait for several workers and collect one clipped section per worker. |
| `swarm_cleanup_worktree` | Remove one retained worktree. The call needs the exact recorded path and a clean, finished worktree. Dirty worktrees are refused. The branch stays. |

Background results are also delivered to the coordinator as follow-up
messages when workers finish. `swarm_status` for one worker also reports its
spend from the Durable usage ledger, by model. For example:
`16362 tokens, $0.0013 (minimax/MiniMax-M3.1-Flash)`.

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

## Limits you must know

- **One Pi process per project, enforced.** The runtime takes an owner
  lockfile (`owner.lock`) for its store. A second Pi, a second runtime, or a
  side script that opens the same store is rejected while the owner lives,
  with instructions to talk to the running coordinator. A lock left by a
  dead process is reclaimed. Never open `swarm.sqlite` from a probe script
  while a coordinator runs; use the coordinator's own `swarm_status`.
- **Read-only roles are an instruction boundary, not a sandbox.** Scouts and
  auditors keep a shell for inspection, and the shell could write. Their
  system prompt forbids it. Do not rely on a read-only role for adversarial
  isolation.
- **Worktree isolation is a working-directory convention.** Workers share the
  host filesystem and could navigate outside their worktree. Worktrees give
  clean, separate branches for validation, not a security boundary.
- **A shell command already running when Pi dies keeps running.** The harness
  marks that tool call interrupted and the conversation continues on reopen.
  The orphan process can still finish and change files. Check worktree status
  after any recovery before you trust a diff.
- **A model request interrupted by a crash is sent again.** Tool calls are
  not duplicated, but the provider request (and its cost) can be.

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

## Borrowed ideas, and ideas left behind

This extension borrows from the four implementations in the evaluation. Each
borrowed idea keeps the model policy and durability rules above.

Ideas borrowed:

- **Workflow fan-out and group join** (from [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)): `swarm_fanout` in `parallel` mode and `swarm_join` give the coordinator one deterministic call for many workers. `chain` mode covers the pipeline case: each step receives the previous result at `{previous}`.
- **Saved sessions and mid-run steering** (from tintinweb and [anasalqoyyum/pi-durable-subagents](https://github.com/anasalqoyyum/pi-durable-subagents)): steering, follow-ups and idle-worker continuation all reuse the durable child conversation, its saved model, and its saved working directory.
- **Explicit worktree cleanup** (from anasalqoyyum): `swarm_cleanup_worktree` needs the exact recorded path, a finished worker, and a clean worktree. Dirty work is refused, and the branch is retained.
- **Reviewer in the loop** (from [xian0x5a/pi-durable-subagents](https://github.com/xian0x5a/pi-durable-subagents)): the Request and Answer supervision pattern becomes a `chain`: an implementer finishes, then an independent auditor (W4, `max`) reviews the report and the code before the coordinator integrates.
- **Idempotent submissions, replay-unsafe tools, and the usage ledger** (from [@earendil-works/pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable)): durable task checkpoints drive recovery, spawns stay idempotent by request id, and `swarm_status` reads per-worker spend from `pi.usage`.

Ideas left behind, with reasons:

- **Tintinweb's JavaScript workflow engine and fuzzy model resolver.** The resolver can land on another provider. The engine adds a large script surface for fan-out that `swarm_fanout` and `swarm_join` already cover.
- **Purboo-style model pools, provider failover, and a shared global daemon.** Pools substitute one provider for another on quota errors, and a shared daemon mixes projects. This extension keeps one store per project and fails a worker visibly instead.
- **Xian's automatic moderator agent.** A moderator spends extra model calls on every stall. A named reviewer worker in a chain gives the same check at a known cost, only where the coordinator asks for it.
- **Interactive write-authorization prompts (anasalqoyyum).** Print and RPC coordinators cannot answer prompts. Role tool lists (`read` and `bash` for scouts and auditors) set the write boundary instead.
- **Nested delegation.** Child workers receive coding tools only, never the `swarm_*` tools. The coordinator owns all decomposition. This removes the nested-spawn limit problem by construction.

## Changes in 0.2.0

- Add `swarm_fanout` (`parallel` and `chain` modes) and `swarm_join`.
- Add per-worker usage and cost to `swarm_status`.
- Add `swarm_cleanup_worktree` with dirty-worktree refusal.
- All three features are covered by unit tests and were verified live: a parallel fan-out with join, an implement-then-review chain that ended in `APPROVED`, and a cleanup call refused on a dirty worktree.

## Changes in 0.2.1 (multi-agent review fixes)

Reviewed by four parallel subagents (correctness, durability, model policy,
fitness) with a final pass in the main session. Fixes:

- `swarm_steer` no longer bypasses the scheduler. A message to a queued
  worker folds into its pending task. A message to an idle worker re-enters
  through the scheduler, so the 6 and 2-per-provider bounds hold. Starting a
  new delivery clears the old result, so `swarm_join` cannot return a stale
  success (verified live).
- `swarm_join`, `swarm_result` with `wait: true`, and foreground
  `swarm_spawn` now wait through the same durable path, which periodically
  reconciles faulted runners instead of polling forever.
- Spawn checks the Pi model registry before it creates any durable state. An
  eligible model that Pi has not configured fails at spawn with a clear
  error. No other model is substituted.
- A failed scheduler pass no longer poisons later admissions, and a rejected
  scheduling pass no longer blocks shutdown.
- README now states the one-Pi-per-project rule, the orphan shell process
  case, and that read-only roles and worktrees are conventions, not
  sandboxes.

Known gaps left for later work, in order: a reproducible runtime and
recovery test harness in the repo (today the live verifications are
documented runs, and the 15 unit tests cover the pure modules); a wait
deadline or stall watchdog for `swarm_join` and chains; live worker
observability beyond status polls; default worktree isolation for write
roles in parallel fan-outs.

## Changes in 0.3.0 (isolation hardening)

Found while supervising two live Muse sessions that run separate
swarms on separate projects:

- **Owner lease.** One store now has exactly one owner process, enforced by
  a lockfile instead of by convention. A second opener is rejected while the
  owner lives. A dead owner's lock is reclaimed. This closes the
  "probe script opens the runtime next to a live coordinator" hole, which
  could steal tasks and break the concurrency bounds.
- **Wait deadlines.** `swarm_result` and `swarm_join` accept `timeout_ms`.
  A timeout reports the worker's current state and leaves the worker running
  for later collection; it never marks the worker failed or stopped.
- **`swarm_status` shows running time** for a running worker, so a
  coordinator can spot a stall without reading raw state.
- Runtime-level tests now cover the lease, reopening after close, and the
  spawn-time registry check (19 tests in total).

Isolation rule for running several swarms at once: separate projects get
separate stores, separate coordinators, and separate RPC sockets. Name each
socket after its project (for example `/tmp/<project>-swarm.sock`), never a
shared generic name. Two swarms on one machine still share the same provider
accounts, so their per-provider worker counts add up at the provider.

## Changes in 0.3.1 (live-supervision fixes)

Found by observing two production swarms run by parallel Muse
sessions:

- **Worker names are unique.** Reusing a name (two workers both called
  `w2-impl-strong` happened in production) now auto-suffixes: `w2-impl-strong`,
  `w2-impl-strong-2`, and so on. Name addressing in `swarm_result`,
  `swarm_steer` and `swarm_stop` is never ambiguous. Workers created before
  this change keep their duplicate names; address those by agent id.
- **Shared-cwd writer warning.** Spawning a writing worker with no worktree
  isolation while another unisolated writer is active in the same cwd now
  returns an explicit warning naming the peers. Sequential work in one
  checkout is fine; parallel unisolated writes are the mistake this names.
- **Failure results carry provider detail.** A worker that fails with
  `model_error` now appends the provider's error text (clipped) when the
  transcript has it, so the coordinator can choose between an explicit retry
  and an explicit reassignment to another eligible model without guessing.

## Changes in 0.3.2

- Ambiguous worker-name errors (only possible for workers created before
  unique naming in 0.3.1) now list every candidate's agent id, state and
  model, so the coordinator can re-address by id immediately.
- `swarm_status` and `/swarm` list lines include the agent id next to each
  worker. Found in production: a coordinator hit the ambiguous-name error
  repeatedly on legacy duplicate names with no id in sight.

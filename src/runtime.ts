import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import type { Models } from '@earendil-works/pi-ai';
import {
  configure,
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  InboxDoc,
  LiveDoc,
  type Conversation,
  type TaskId,
  UsageDoc,
} from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { assertThinking, resolveModel, roleInstructions, ROLES, type Thinking } from './policy.ts';
import { admit, DEFAULT_LIMITS, type SchedulerLimits } from './scheduler.ts';
import { Fleet, type AgentRecord, type SwarmResult } from './state.ts';
import { ambiguousNameMessage, uniqueName } from './workflow.ts';
import { codingTools, READ_ONLY_TOOLS, WRITE_TOOLS } from './tools.ts';
import { prepareWorktree, removeWorktree, verifyWorktree, worktreeStatus, type Worktree } from './worktrees.ts';
import { acquireLease, type Lease } from './lease.ts';

export const context = BACKGROUND_CONTEXT;

export type RuntimeOptions = {
  /** Directory holding the durable SQLite store; created if missing. */
  directory: string;
  models: Models;
  limits?: SchedulerLimits;
  onError?: (error: Error) => void;
};

export type SpawnInput = {
  requestId: string;
  name: string;
  task: string;
  role?: string;
  model?: string;
  thinking?: string;
  cwd: string;
  isolation?: 'none' | 'worktree';
};

const swarmCoding = defineExtension({ name: 'pi-durable-swarm.coding', tools: codingTools });

export async function openRuntime(options: RuntimeOptions) {
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const lease: Lease = await acquireLease(options.directory);
  const limits = options.limits ?? DEFAULT_LIMITS;
  const path = join(options.directory, 'swarm.sqlite');

  let harness: Harness | undefined;
  let scheduling = Promise.resolve();

  const schedule = (): Promise<void> => {
    scheduling = scheduling.then(async () => {
      try {
        if (!harness) return;
        const root = await harness.root(context);
        const fleet = await harness.snapshot(Fleet, root.id, context);
        if (!fleet) return;
        for (const id of admit(Object.values(fleet.agents), limits)) {
          await startAgent(id);
        }
      } catch (error) {
        // One failed admission must never poison later scheduling.
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return scheduling;
  };

  const Anchor = defineTask<null, { phase: 'done' }, null>({
    name: 'pi-durable-swarm.anchor',
    version: 1,
    initial: () => ({ phase: 'done' }),
    phases: {
      done: (_task, runtime, ctx) =>
        runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), ctx),
    },
    abort: (_task, runtime, ctx) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  });

  type RunnerInput = { agentId: string; message: string; mode: 'steer' | 'followUp' };

  const Runner = defineTask<RunnerInput, { phase: 'deliver' }, SwarmResult>({
    name: 'pi-durable-swarm.runner',
    version: 1,
    initial: () => ({ phase: 'deliver' }),
    phases: {
      deliver: async (task, runtime, ctx) => {
        const fleet = await runtime.snapshot(Fleet, runtime.conversationId, ctx);
        const agent = fleet?.agents[task.input.agentId];
        if (!agent) throw new Error(`Missing swarm agent ${task.input.agentId}`);
        const child = await runtime.conversation(agent.conversationId, ctx);
        if (!child) throw new Error(`Missing child conversation ${agent.conversationId}`);

        const submission = await child.submit(
          { type: 'input', content: task.input.message, whenBusy: task.input.mode, requestId: `swarm-input:${task.id}` },
          ctx,
        );
        const settled = await submission.wait(ctx);

        let result: SwarmResult;
        if (settled.status === 'done' && settled.type === 'input') {
          const view = await runtime.context(agent.conversationId, ctx);
          const entry = view.entries.find((candidate) => candidate.id === settled.answer);
          const text =
            entry?.model
              ?.flatMap((message) =>
                !Array.isArray(message.content)
                  ? [message.content]
                  : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
              )
              .join('') ?? '';
          result = { status: 'completed', text };
        } else {
          const reason = settled.status === 'unanswered' ? settled.reason : 'unexpected submission';
          let detail = '';
          try {
            const view = await runtime.context(agent.conversationId, ctx);
            for (const entry of [...view.entries].reverse()) {
              const message = entry.model?.find(
                (candidate) => typeof (candidate as { errorMessage?: unknown }).errorMessage === 'string',
              ) as { errorMessage?: string } | undefined;
              if (message?.errorMessage) {
                detail = ` Provider detail: ${message.errorMessage.slice(0, 300)}`;
                break;
              }
            }
          } catch {
            // Detail is best effort; the reason above always stands.
          }
          result = {
            status: reason === 'aborted' ? 'stopped' : 'failed',
            text: `Agent ${agent.name} ${reason === 'aborted' ? 'stopped' : `failed: ${reason}`}.${detail}`,
          };
        }

        let changedFiles: string | undefined;
        if (agent.worktree) {
          try {
            changedFiles = await worktreeStatus(agent.worktree);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            result = { status: 'failed', text: `${result.text}\nWorktree inspection failed: ${message}` };
            changedFiles = message;
          }
        }

        await runtime.commit(async (tx) => {
          const doc = await tx.doc(Fleet, runtime.conversationId);
          const record = doc.agents[agent.id];
          if (record && record.tasks.at(-1) === task.id) {
            record.result = result;
            record.state = result.status;
            record.finishedAt = runtime.now();
            if (changedFiles !== undefined) record.changedFiles = changedFiles;
            const reportId = `swarm-report:${task.id}`;
            if (!doc.outbox[reportId]) {
              const report: (typeof doc.outbox)[string] = { id: reportId, agentId: agent.id, result, state: 'pending' };
              if (agent.worktree) report.worktree = agent.worktree;
              if (changedFiles !== undefined) report.changedFiles = changedFiles;
              doc.outbox[reportId] = report;
            }
          }
          return { status: 'terminal', outcome: { status: 'completed', result } };
        }, ctx);
        void schedule();
      },
    },
    abort: async (task, runtime, ctx) => {
      const result: SwarmResult = { status: 'stopped', text: 'Agent stopped' };
      await runtime.commit(async (tx) => {
        const doc = await tx.doc(Fleet, runtime.conversationId);
        const record = doc.agents[task.input.agentId];
        if (record && record.tasks.at(-1) === task.id) {
          record.result = result;
          record.state = 'stopped';
          record.finishedAt = runtime.now();
        }
        return { status: 'terminal', outcome: { status: 'aborted' } };
      }, ctx);
      void schedule();
    },
  });

  const registry = createRegistry();
  registry.install(swarmCoding);
  registry.install(defineExtension({ name: 'pi-durable-swarm.execution', tasks: [Anchor, Runner] }));

  try {
    harness = await Harness.open(
    await openNodeSqliteStorage(path),
    {
      models: options.models,
      registry,
      settings: { retry: { enabled: false }, stream: { timeoutMs: 180_000 }, toolExecution: 'parallel' },
      env: async ({ cwd, conversationId, read }, ctx) => {
        const root = await harness!.root(ctx);
        const fleet = await read.snapshot(Fleet, root.id, ctx);
        const agent = Object.values(fleet?.agents ?? {}).find((a) => a.conversationId === conversationId);
        if (agent?.worktree) await verifyWorktree(agent.worktree);
        if (!cwd) throw new Error('Swarm agent has no recorded cwd');
        return new NodeExecutionEnv({ cwd });
      },
    },
    context,
    );
  } catch (error) {
    await lease.release();
    throw error;
  }

  const active = harness;
  const root = await active.root(context);

  async function startAgent(id: string): Promise<void> {
    await root.commit(async (tx) => {
      const fleet = await tx.doc(Fleet, root.id);
      const agent = fleet.agents[id];
      if (!agent || agent.state !== 'queued' || !agent.pendingTask) return;
      const runner = await tx.createTask(
        Runner,
        { agentId: id, message: agent.pendingTask, mode: 'followUp' } satisfies RunnerInput,
        { ownership: { kind: 'conversation' }, background: true },
      );
      agent.tasks.push(runner);
      agent.state = 'running';
      agent.startedAt = Date.now();
      delete agent.pendingTask;
    }, context);
  }

  const snapshot = () => active.snapshot(Fleet, root.id, context);

  const get = async (idOrName: string): Promise<AgentRecord> => {
    const fleet = await snapshot();
    const direct = fleet?.agents[idOrName];
    if (direct) return direct;
    const matches = Object.values(fleet?.agents ?? {}).filter((agent) => agent.name === idOrName);
    if (matches.length > 1) throw new Error(ambiguousNameMessage(idOrName, matches));
    if (matches.length !== 1) throw new Error(`Unknown swarm agent: ${idOrName}`);
    return matches[0]!;
  };

  const conversation = async (agent: AgentRecord): Promise<Conversation> => {
    const child = await active.conversation(agent.conversationId, context);
    if (!child) throw new Error(`Missing conversation for ${agent.id}`);
    return child;
  };

  /** Reconcile durable Runner tasks that faulted outside the Runner phases. */
  const reconcile = async (): Promise<void> => {
    const fleet = await snapshot();
    for (const agent of Object.values(fleet?.agents ?? {})) {
      if (agent.state !== 'running') continue;
      const latest = agent.tasks.at(-1);
      if (!latest) continue;
      const task = await active.getTask(latest, context);
      if (!task || task.state.status !== 'terminal') continue;
      const outcome = task.state.outcome;
      if (outcome.status === 'completed') continue;
      await root.commit(async (tx) => {
        const doc = await tx.doc(Fleet, root.id);
        const record = doc.agents[agent.id];
        if (!record || record.state !== 'running') return;
        record.state = outcome.status === 'aborted' ? 'stopped' : 'failed';
        record.result = {
          status: record.state,
          text: `Agent ${agent.name} ${outcome.status}${outcome.status === 'orphaned' ? `: ${outcome.reason}` : ''}`,
        };
        record.finishedAt = Date.now();
      }, context);
    }
    await schedule();
  };

  const spawn = async (input: SpawnInput): Promise<AgentRecord> => {
    const existing = (await snapshot())?.requests[input.requestId];
    if (existing) return get(existing);

    const roleName = input.role ?? 'w3-impl';
    const role = ROLES[roleName];
    if (!role) throw new Error(`Unknown role "${roleName}". Roles: ${Object.keys(ROLES).join(', ')}`);
    const model = resolveModel(input.model ?? role.model);
    const thinking = assertThinking(model, input.thinking ?? role.thinking) as Thinking;
    if (!options.models.getModel(model.provider, model.modelId)) {
      throw new Error(
        `Model ${model.canonical} is eligible but not available in the Pi model registry. ` +
          'Configure that provider in Pi first. The worker was not created and no other model was substituted.',
      );
    }
    const write = role.write;
    const tools = write ? WRITE_TOOLS : READ_ONLY_TOOLS;

    let worktree: Worktree | undefined;
    let cwd = input.cwd;
    if ((input.isolation ?? 'none') === 'worktree') {
      if (!write) throw new Error(`Role ${roleName} is read-only and cannot use worktree isolation`);
      worktree = await prepareWorktree({ cwd: input.cwd, root: join(options.directory, 'worktrees'), agentId: input.requestId });
      cwd = worktree.path;
    }

    const id = input.requestId;
    await root.commit(async (tx) => {
      const fleet = await tx.doc(Fleet, root.id);
      if (fleet.agents[id]) return;
      const owner = await tx.createTask(Anchor, null, { ownership: { kind: 'conversation' }, background: true });
      const child = await tx.createConversation({ ownership: { kind: 'task', taskId: owner } });
      const selected = codingTools.filter((tool) => tools.includes(tool.name));
      await configure(tx, child.id, {
        model: { provider: model.provider, modelId: model.modelId },
        thinkingLevel: thinking,
        instructions: roleInstructions(roleName, write),
        cwd,
        extensions: [swarmCoding],
        tools: selected,
      });
      const record: AgentRecord = {
        id,
        name: uniqueName(new Set(Object.values(fleet.agents).map((agent) => agent.name)), input.name),
        role: roleName, model: model.canonical, provider: model.provider,
        thinking, write, cwd, conversationId: child.id, ownerTask: owner, tasks: [],
        state: 'queued', pendingTask: input.task, queuedAt: Date.now(),
      };
      if (worktree) record.worktree = worktree;
      fleet.agents[id] = record;
      fleet.requests[input.requestId] = id;
    }, context);
    await schedule();
    return get(id);
  };

  const send = async (input: { id: string; requestId: string; message: string; followUp: boolean }): Promise<void> => {
    const agent = await get(input.id);
    const fleet = await snapshot();
    if (fleet?.requests[input.requestId]) return;
    await root.commit(async (tx) => {
      const doc = await tx.doc(Fleet, root.id);
      const record = doc.agents[agent.id];
      if (!record || doc.requests[input.requestId]) return;
      doc.requests[input.requestId] = agent.id;
      delete record.result;
      delete record.finishedAt;
      if (record.state === 'queued') {
        // Not admitted yet: fold the message into the pending task so the
        // scheduler delivers both, in order, when a slot frees.
        record.pendingTask = `${record.pendingTask ?? ''}\n\nAdditional instruction: ${input.message}`;
        return;
      }
      if (record.state === 'completed' || record.state === 'failed' || record.state === 'stopped') {
        // Idle: re-enter through the scheduler so hard bounds still apply.
        record.state = 'queued';
        record.pendingTask = input.message;
        record.queuedAt = Date.now();
        return;
      }
      const runner = await tx.createTask(
        Runner,
        { agentId: agent.id, message: input.message, mode: input.followUp ? 'followUp' : 'steer' } satisfies RunnerInput,
        { ownership: { kind: 'conversation' }, background: true },
      );
      record.tasks.push(runner);
      record.state = 'running';
    }, context);
    await schedule();
  };

  const waitResult = async (taskId: TaskId<SwarmResult>, signal?: AbortSignal): Promise<SwarmResult> => {
    const waitContext = signal ? withAbortSignal(signal, context) : context;
    const task = await active.waitForTask(taskId, waitContext);
    if (!task || task.state.status !== 'terminal') throw new Error(`Missing completed swarm task ${taskId}`);
    const outcome = task.state.outcome;
    if (outcome.status === 'completed') return outcome.result;
    return { status: outcome.status === 'aborted' ? 'stopped' : 'failed', text: `Swarm task ${outcome.status}` };
  };

  const stop = async (id: string): Promise<void> => {
    const agent = await get(id);
    if (agent.state === 'queued') {
      await root.commit(async (tx) => {
        const doc = await tx.doc(Fleet, root.id);
        const record = doc.agents[agent.id];
        if (record && record.state === 'queued') {
          record.state = 'stopped';
          record.result = { status: 'stopped', text: 'Agent stopped while queued' };
          record.finishedAt = Date.now();
          delete record.pendingTask;
        }
      }, context);
      return;
    }
    await Promise.all(agent.tasks.map((task) => active.abortTask(task, context)));
    await (await conversation(agent)).abort(context);
    await Promise.all(agent.tasks.map((task) => active.waitForTask(task, context).catch(() => undefined)));
    await schedule();
  };

  /** Per-worker spend from the harness usage ledger (pi.usage), keyed by model. */
  const usage = async (id: string): Promise<string> => {
    const agent = await get(id);
    const state = await active.snapshot(UsageDoc, agent.conversationId, context);
    if (!state) return 'no usage recorded';
    let tokens = 0;
    let cost = 0;
    const parts: string[] = [];
    for (const [key, value] of Object.entries(state.models)) {
      const usageValue = value as { totalTokens?: number; cost?: { total?: number } };
      tokens += usageValue.totalTokens ?? 0;
      cost += usageValue.cost?.total ?? 0;
      parts.push(key);
    }
    return `${tokens} tokens, $${cost.toFixed(4)} (${parts.join(', ') || 'no model calls'})`;
  };

  /** Fleet-wide spend by model, for delegation-balance reporting. */
  const usageSummary = async (): Promise<string> => {
    const fleet = await snapshot();
    const per = new Map<string, { tokens: number; cost: number }>();
    for (const agent of Object.values(fleet?.agents ?? {})) {
      const state = await active.snapshot(UsageDoc, agent.conversationId, context);
      for (const [key, value] of Object.entries(state?.models ?? {})) {
        const usageValue = value as { totalTokens?: number; cost?: { total?: number } };
        const entry = per.get(key) ?? { tokens: 0, cost: 0 };
        entry.tokens += usageValue.totalTokens ?? 0;
        entry.cost += usageValue.cost?.total ?? 0;
        per.set(key, entry);
      }
    }
    if (!per.size) return 'Fleet usage: no usage recorded';
    const lines = [...per.entries()]
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .map(([model, value]) => `${model}: ${value.tokens} tokens, $${value.cost.toFixed(4)}`);
    return `Fleet usage:\n${lines.join('\n')}`;
  };

  /** Poll durable state until a worker settles; survives queued admission. */
  const waitAgent = async (id: string, signal?: AbortSignal, timeoutMs?: number): Promise<SwarmResult> => {
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    let polls = 0;
    for (;;) {
      signal?.throwIfAborted();
      if (deadline !== undefined && Date.now() > deadline) {
        const current = await get(id);
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for ${current.name} [${current.state}]. ` +
            'The worker was NOT stopped. Collect it later with swarm_result, or stop it with swarm_stop.',
        );
      }
      // Periodically reconcile runners that faulted outside their phases,
      // so a dead runner settles here instead of polling forever.
      if (polls % 4 === 0) await reconcile().catch(() => undefined);
      polls += 1;
      const agent = await get(id);
      if (agent.result) return agent.result;
      if (agent.state === 'failed' || agent.state === 'stopped') {
        return agent.result ?? { status: agent.state, text: `Agent ${agent.name} ${agent.state}` };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };

  const cleanupWorktree = async (id: string, path: string): Promise<string> => {
    const agent = await get(id);
    if (!agent.worktree || agent.worktree.path !== path) {
      throw new Error('Cleanup requires the exact recorded worktree path for this agent');
    }
    if (agent.state === 'queued' || agent.state === 'running') {
      throw new Error('Stop the worker before cleaning up its worktree');
    }
    return removeWorktree(agent.worktree);
  };

  await reconcile();
  active.resume();

  return {
    harness: active,
    snapshot,
    get,
    spawn,
    send,
    stop,
    waitResult,
    waitAgent,
    usage,
    usageSummary,
    cleanupWorktree,
    schedule,
    reconcile,
    async acknowledge(reportId: string): Promise<void> {
      await root.commit(async (tx) => {
        const fleet = await tx.doc(Fleet, root.id);
        const report = fleet.outbox[reportId];
        if (report) report.state = 'delivered';
      }, context);
    },
    async close(): Promise<void> {
      await scheduling.catch(() => undefined);
      await active.close(context);
      harness = undefined;
      await lease.release();
    },
  };
}

export type SwarmRuntime = Awaited<ReturnType<typeof openRuntime>>;

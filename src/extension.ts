import { join } from 'node:path';
import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { modelsFromPi } from './models.ts';
import { ELIGIBLE_MODELS, ROLES } from './policy.ts';
import { openRuntime, type SwarmRuntime } from './runtime.ts';
import type { AgentRecord } from './state.ts';
import { formatJoin, sharedWriterWarning, substitutePrevious, type WriterPeer } from './workflow.ts';

async function writerWarning(active: SwarmRuntime, self: AgentRecord): Promise<string> {
  const fleet = await active.snapshot();
  const peers: WriterPeer[] = Object.values(fleet?.agents ?? {}).map((agent) => ({
    name: agent.name,
    state: agent.state,
    write: agent.write,
    cwd: agent.cwd,
    hasWorktree: Boolean(agent.worktree),
  }));
  return sharedWriterWarning(peers, self.name) ?? '';
}

function describe(agent: AgentRecord): string {
  const age =
    agent.state === 'running' && agent.startedAt
      ? `\nRunning for: ${Math.max(0, Math.round((Date.now() - agent.startedAt) / 1000))}s`
      : '';
  const worktree = agent.worktree
    ? `\nWorktree retained: ${agent.worktree.path}\nBranch: ${agent.worktree.branch}\nBase: ${agent.worktree.baseCommit}\nChanged files:\n${agent.changedFiles || 'none'}`
    : '';
  return `Agent ${agent.name} (${agent.id})\nRole: ${agent.role}\nModel: ${agent.model}\nThinking: ${agent.thinking}\nState: ${agent.state}${age}${worktree}`;
}

/**
 * pi-durable-swarm: durable multi-agent orchestration for Muse Code.
 * One Pi coordinator owns up to six workers (two per eligible provider) whose
 * conversations, tasks and results are committed to SQLite by
 * @earendil-works/pi-durable before anything is shown. Killing or restarting
 * Pi loses nothing: reopening the same project resumes queued and running
 * workers from their last durable checkpoint.
 */
export default function durableSwarm(pi: ExtensionAPI) {
  let runtime: SwarmRuntime | undefined;
  let initializing: Promise<void> | undefined;

  const initialize = async (ctx: ExtensionContext): Promise<void> => {
    if (runtime) return;
    if (initializing) return initializing;
    initializing = (async () => {
      runtime = await openRuntime({
        // Project-local store: a swarm belongs to the project it works on,
        // survives Pi restarts, and is never shared with other projects.
        directory: join(ctx.cwd, '.pi', 'durable-swarm'),
        models: modelsFromPi(ctx.modelRegistry),
        onError: (error) => {
          if (ctx.hasUI) ctx.ui.notify(`pi-durable-swarm: ${error.message}`, 'error');
        },
      });
      void runtime.reconcile().catch(() => undefined);
    })();
    try {
      await initializing;
    } finally {
      initializing = undefined;
    }
  };

  const ready = async (ctx: ExtensionContext): Promise<SwarmRuntime> => {
    await initialize(ctx);
    if (!runtime) throw new Error('pi-durable-swarm runtime is unavailable');
    return runtime;
  };

  pi.on('session_start', async (_event, ctx) => {
    await initialize(ctx);
  });
  pi.on('session_shutdown', async () => {
    await runtime?.close();
    runtime = undefined;
  });

  // Deliver background results to the coordinator at its next turn boundary.
  pi.on('agent_end', async (_event, ctx) => {
    if (!runtime) return;
    const fleet = await runtime.snapshot();
    for (const report of Object.values(fleet?.outbox ?? {})) {
      if (report.state !== 'pending') continue;
      const agent = fleet?.agents[report.agentId];
      pi.sendMessage(
        {
          customType: 'pi-durable-swarm-result',
          content:
            `[swarm ${agent?.name ?? report.agentId} ${report.result.status}; model ${agent?.model ?? 'unknown'}]\n` +
            `${report.result.text.slice(0, 4000)}` +
            (agent?.worktree ? `\nWorktree retained: ${agent.worktree.path}\nChanged files:\n${report.changedFiles || 'none'}` : ''),
          display: true,
          details: { reportId: report.id, agentId: report.agentId, status: report.result.status },
        },
        { triggerTurn: false, deliverAs: 'followUp' },
      );
      void runtime.acknowledge(report.id).catch(() => undefined);
    }
  });

  pi.registerTool({
    name: 'swarm_spawn',
    label: 'Spawn swarm worker',
    description:
      'Spawn one durable swarm worker with an exact eligible model pin. Background by default: the worker is committed to durable storage before this call returns, is admitted by a hard scheduler (max 6 running, max 2 per provider), and survives Pi restarts. Roles: ' +
      Object.entries(ROLES).map(([name, role]) => `${name} (${role.model}, thinking ${role.thinking})`).join(', ') +
      '. Eligible model overrides: ' + ELIGIBLE_MODELS.map((model) => model.id).join(', ') +
      '. Any other model or unsupported thinking level is rejected, never substituted or clamped.',
    parameters: Type.Object(
      {
        name: Type.String(),
        task: Type.String(),
        role: Type.Optional(Type.String()),
        model: Type.Optional(Type.String()),
        thinking: Type.Optional(Type.String()),
        isolation: Type.Optional(Type.Union([Type.Literal('none'), Type.Literal('worktree')])),
        run_in_background: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    async execute(callId, args, signal, _onUpdate, ctx) {
      const active = await ready(ctx);
      const agent = await active.spawn({
        requestId: `tool:${callId}`,
        name: args.name,
        task: args.task,
        role: args.role,
        model: args.model,
        thinking: args.thinking,
        cwd: ctx.cwd,
        isolation: args.isolation ?? 'none',
      });
      if (args.run_in_background ?? true) {
        const warning = await writerWarning(active, agent);
        return {
          content: [{ type: 'text' as const, text: `${describe(agent)}\nSpawned durably. Collect with swarm_result; it will also be delivered when it finishes.${warning ? `\n${warning}` : ''}` }],
          details: { agent_id: agent.id, model: agent.model, state: agent.state },
        };
      }
      const result = await active.waitAgent(agent.id, signal);
      const finished = await active.get(agent.id);
      return {
        content: [{ type: 'text' as const, text: `${describe(finished)}\n\n${result.text}` }],
        details: { agent_id: agent.id, model: agent.model, status: result.status },
        isError: result.status !== 'completed',
      };
    },
  });

  pi.registerTool({
    name: 'swarm_status',
    label: 'Swarm status',
    description: 'List swarm workers with their durable state, exact model and thinking. Optionally pass one agent id or unique name.',
    parameters: Type.Object({ agent_id: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute(_callId, args, _signal, _onUpdate, ctx) {
      const active = await ready(ctx);
      await active.reconcile();
      if (args.agent_id) {
        const agent = await active.get(args.agent_id);
        const usage = await active.usage(agent.id).catch(() => 'usage unavailable');
        return { content: [{ type: 'text' as const, text: `${describe(agent)}\nUsage: ${usage}` }], details: { agent_id: agent.id, state: agent.state } };
      }
      const fleet = await active.snapshot();
      const agents = Object.values(fleet?.agents ?? {});
      const summary = await active.usageSummary().catch(() => 'Fleet usage: unavailable');
      const text = agents.length
        ? `${agents.map((agent) => `${agent.name} [${agent.state}] ${agent.model}:${agent.thinking} (${agent.id})`).join('\n')}\n${summary}`
        : 'No swarm workers yet.';
      return { content: [{ type: 'text' as const, text }], details: { count: agents.length } };
    },
  });

  pi.registerTool({
    name: 'swarm_result',
    label: 'Swarm worker result',
    description: 'Collect a swarm worker result by id or unique name. wait=true blocks until its latest task settles. Failed or stopped work is returned as an error, never as success.',
    parameters: Type.Object(
      { agent_id: Type.String(), wait: Type.Optional(Type.Boolean()), timeout_ms: Type.Optional(Type.Number()) },
      { additionalProperties: false },
    ),
    async execute(_callId, args, signal, _onUpdate, ctx) {
      const active = await ready(ctx);
      let agent = await active.get(args.agent_id);
      if (args.wait) {
        await active.waitAgent(agent.id, signal, args.timeout_ms);
        agent = await active.get(args.agent_id);
      }
      if (!agent.result) {
        return {
          content: [{ type: 'text' as const, text: `${describe(agent)}\nNo result yet.` }],
          details: { agent_id: agent.id, state: agent.state },
        };
      }
      return {
        content: [{ type: 'text' as const, text: `${describe(agent)}\n\n${agent.result.text}` }],
        details: { agent_id: agent.id, status: agent.result.status },
        isError: agent.result.status !== 'completed',
      };
    },
  });

  pi.registerTool({
    name: 'swarm_steer',
    label: 'Steer swarm worker',
    description: 'Send a message to a swarm worker: steers its current run at the next boundary by default, or queues behind it with follow_up=true. Continues idle workers with their saved model and cwd.',
    parameters: Type.Object(
      { agent_id: Type.String(), message: Type.String(), follow_up: Type.Optional(Type.Boolean()) },
      { additionalProperties: false },
    ),
    async execute(callId, args, _signal, _onUpdate, ctx) {
      const active = await ready(ctx);
      await active.send({ id: args.agent_id, requestId: `steer:${callId}`, message: args.message, followUp: args.follow_up ?? false });
      return { content: [{ type: 'text' as const, text: `Sent to ${args.agent_id}.` }], details: { agent_id: args.agent_id } };
    },
  });

  pi.registerTool({
    name: 'swarm_stop',
    label: 'Stop swarm worker',
    description: 'Stop one swarm worker (queued or running) without affecting others. Its durable conversation and retained worktree stay available for inspection and continuation.',
    parameters: Type.Object({ agent_id: Type.String() }, { additionalProperties: false }),
    async execute(_callId, args, _signal, _onUpdate, ctx) {
      const active = await ready(ctx);
      await active.stop(args.agent_id);
      return { content: [{ type: 'text' as const, text: `Stopped ${args.agent_id}.` }], details: { agent_id: args.agent_id } };
    },
  });

  pi.registerTool({
    name: 'swarm_fanout',
    label: 'Swarm fan-out',
    description:
      'Deterministic fan-out borrowed from workflow-style orchestration: spawn 1-6 workers in one call. mode parallel (default) starts them all under the hard scheduler bounds (6 running, 2 per provider). mode chain runs steps one at a time, substituting the previous result into the next task at {previous}, which suits implement-then-review pipelines. Every worker keeps an exact role model pin.',
    parameters: Type.Object(
      {
        mode: Type.Optional(Type.Union([Type.Literal('parallel'), Type.Literal('chain')])),
        tasks: Type.Array(
          Type.Object(
            {
              name: Type.String(),
              task: Type.String(),
              role: Type.Optional(Type.String()),
              model: Type.Optional(Type.String()),
              thinking: Type.Optional(Type.String()),
              isolation: Type.Optional(Type.Union([Type.Literal('none'), Type.Literal('worktree')])),
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 12 },
        ),
      },
      { additionalProperties: false },
    ),
    async execute(callId, args, signal, _onUpdate, ctx) {
      const active = await ready(ctx);
      const mode = args.mode ?? 'parallel';
      if (mode === 'parallel') {
        const agents = [];
        for (const [index, step] of args.tasks.entries()) {
          agents.push(
            await active.spawn({
              requestId: `fanout:${callId}:${index}`,
              name: step.name,
              task: step.task,
              role: step.role,
              model: step.model,
              thinking: step.thinking,
              cwd: ctx.cwd,
              isolation: step.isolation ?? 'none',
            }),
          );
        }
        return {
          content: [{ type: 'text' as const, text: agents.map((agent) => describe(agent)).join('\n\n') + '\nCollect all with swarm_join.' }],
          details: { agent_ids: agents.map((agent) => agent.id), mode },
        };
      }
      const entries = [];
      let previous: string | undefined;
      for (const [index, step] of args.tasks.entries()) {
        const agent = await active.spawn({
          requestId: `chain:${callId}:${index}`,
          name: step.name,
          task: substitutePrevious(step.task, previous),
          role: step.role,
          model: step.model,
          thinking: step.thinking,
          cwd: ctx.cwd,
          isolation: step.isolation ?? 'none',
        });
        const result = await active.waitAgent(agent.id, signal);
        entries.push({ name: agent.name, status: result.status, text: result.text });
        previous = result.text;
        if (result.status !== 'completed') break;
      }
      return {
        content: [{ type: 'text' as const, text: formatJoin(entries) }],
        details: { mode, steps: entries.length },
        isError: entries.at(-1)?.status !== 'completed',
      };
    },
  });

  pi.registerTool({
    name: 'swarm_join',
    label: 'Join swarm workers',
    description: 'Wait for and collect several swarm workers at once by id or unique name. Returns one clipped section per worker; failed or stopped workers are reported as failures, never as success.',
    parameters: Type.Object(
      { agent_ids: Type.Array(Type.String(), { minItems: 1, maxItems: 12 }), timeout_ms: Type.Optional(Type.Number()) },
      { additionalProperties: false },
    ),
    async execute(_callId, args, signal, _onUpdate, ctx) {
      const active = await ready(ctx);
      const entries = [];
      for (const id of args.agent_ids) {
        const agent = await active.get(id);
        const result = await active.waitAgent(agent.id, signal, args.timeout_ms);
        entries.push({ name: agent.name, status: result.status, text: result.text });
      }
      return {
        content: [{ type: 'text' as const, text: formatJoin(entries) }],
        details: { count: entries.length },
        isError: entries.some((entry) => entry.status !== 'completed'),
      };
    },
  });

  pi.registerTool({
    name: 'swarm_cleanup_worktree',
    label: 'Clean up swarm worktree',
    description: 'Remove one retained swarm worktree after explicit coordinator decision. Requires the exact recorded path, a stopped or finished worker, and a clean worktree. Dirty worktrees are refused, never discarded. The branch is retained.',
    parameters: Type.Object(
      { agent_id: Type.String(), path: Type.String() },
      { additionalProperties: false },
    ),
    async execute(_callId, args, _signal, _onUpdate, ctx) {
      const active = await ready(ctx);
      const text = await active.cleanupWorktree(args.agent_id, args.path);
      return { content: [{ type: 'text' as const, text }], details: { agent_id: args.agent_id } };
    },
  });

  pi.registerCommand('swarm', {
    description: 'pi-durable-swarm workers. /swarm lists workers; /swarm <id> shows one worker.',
    async handler(args, ctx) {
      const active = await ready(ctx);
      await active.reconcile();
      const target = args.trim();
      if (target) {
        ctx.ui.notify(describe(await active.get(target)), 'info');
        return;
      }
      const fleet = await active.snapshot();
      const lines = Object.values(fleet?.agents ?? {}).map(
        (agent) => `${agent.name} [${agent.state}] ${agent.model}:${agent.thinking} (${agent.id})`,
      );
      ctx.ui.notify(lines.length ? lines.join('\n') : 'No swarm workers yet.', 'info');
    },
  });
}

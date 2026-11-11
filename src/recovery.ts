import type { AgentRecord } from './state.ts';

export type InterruptedAgentSummary = {
  name: string;
  model: string;
  provider: string;
  worktreePath?: string;
  branch?: string;
};

export type InterruptedSummary = { count: number; agents: InterruptedAgentSummary[] };

export function sweepInterruptedAgents(agents: Record<string, AgentRecord>, now: number): number {
  let count = 0;
  for (const record of Object.values(agents)) {
    if (record.state !== 'running' && record.state !== 'queued') continue;
    record.state = 'interrupted';
    record.interruptedReason = 'coordinator-stop';
    record.interruptedAt = now;
    count += 1;
  }
  return count;
}

export function interruptedAgents(agents: readonly AgentRecord[]): AgentRecord[] {
  return agents
    .filter((a) => a.state === 'interrupted')
    .sort((a, b) => a.queuedAt - b.queuedAt || a.id.localeCompare(b.id));
}

export function buildInterruptedSummary(agents: readonly AgentRecord[]): InterruptedSummary {
  const list = interruptedAgents(agents);
  return {
    count: list.length,
    agents: list.map((a) => ({
      name: a.name,
      model: a.model,
      provider: a.provider,
      ...(a.worktree ? { worktreePath: a.worktree.path, branch: a.worktree.branch } : {}),
    })),
  };
}

export function formatInterruptedLine(summary: InterruptedSummary): string {
  if (!summary.count) return '';
  return `Interrupted (coordinator stop): ${summary.count} — resume or respawn before new work`;
}

export function formatRecoveryNotice(summary: InterruptedSummary): string {
  if (!summary.count) return '';
  const names = summary.agents.map((a) => a.name).join(', ');
  return (
    `RECOVERY NOTICE: ${summary.count} agent(s) interrupted by coordinator stop: ${names}. ` +
    'Resume each with swarm_steer (retry/resume), respawn a same-name continuation with swarm_spawn, or explicitly swarm_stop it. ' +
    'This notice repeats every turn until no interrupted agents remain.'
  );
}

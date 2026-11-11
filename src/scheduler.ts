// Bounded concurrency admission. Pure and unit-tested: the runtime feeds it
// the durable fleet state, it decides which queued workers may start.
// Limits are hard bounds, not approximate policy: a worker starts only when
// both the global slot and its provider slot are free.

export type SchedulerLimits = { maxConcurrent: number; perProvider: number };

export const DEFAULT_LIMITS: SchedulerLimits = { maxConcurrent: 12, perProvider: 4 };

export type SchedulableAgent = {
  id: string;
  provider: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';
  queuedAt: number;
};

/** Ids of queued agents that may start now, oldest first. */
export function admit(agents: readonly SchedulableAgent[], limits: SchedulerLimits = DEFAULT_LIMITS): string[] {
  const running = agents.filter((agent) => agent.state === 'running');
  let globalFree = Math.max(0, limits.maxConcurrent - running.length);
  const providerRunning = new Map<string, number>();
  for (const agent of running) providerRunning.set(agent.provider, (providerRunning.get(agent.provider) ?? 0) + 1);

  const admitted: string[] = [];
  const queued = agents
    .filter((agent) => agent.state === 'queued')
    .sort((a, b) => a.queuedAt - b.queuedAt || a.id.localeCompare(b.id));

  for (const agent of queued) {
    if (globalFree <= 0) break;
    const used = providerRunning.get(agent.provider) ?? 0;
    if (used >= limits.perProvider) continue;
    admitted.push(agent.id);
    providerRunning.set(agent.provider, used + 1);
    globalFree -= 1;
  }
  return admitted;
}

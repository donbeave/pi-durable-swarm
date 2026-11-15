// Bounded concurrency admission. Pure and unit-tested: the runtime feeds it
// the durable fleet state, it decides which queued workers may start.
// Limits are hard bounds, not approximate policy: a worker starts only when
// both the global slot and its provider slot are free.

export type SchedulerLimits = {
  maxConcurrent: number;
  /** Default per-provider cap when providerCaps has no entry for the provider. */
  perProvider: number;
  /** Per-provider cap overrides, keyed by provider id (e.g. "minimax"). */
  providerCaps?: Readonly<Record<string, number>>;
};

// Flash-first caps: MiniMax Flash is the primary execution resource while
// its quota nears reset, so it gets 8; Kimi stays conservative at 2 until
// its quota refresh is verified; other providers stay at 4.
export const DEFAULT_LIMITS: SchedulerLimits = {
  maxConcurrent: 20,
  perProvider: 4,
  providerCaps: { minimax: 8, 'kimi-coding': 2 },
};

/** Effective concurrency cap for one provider under the given limits. */
export function providerLimit(limits: SchedulerLimits, provider: string): number {
  return limits.providerCaps?.[provider] ?? limits.perProvider;
}

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
    if (used >= providerLimit(limits, agent.provider)) continue;
    admitted.push(agent.id);
    providerRunning.set(agent.provider, used + 1);
    globalFree -= 1;
  }
  return admitted;
}

// Deterministic fan-out helpers, borrowed from the workflow idea in
// tintinweb/pi-subagents (agent / parallel / pipeline) and reduced to two
// total operations the coordinator can rely on: substitute the previous
// step's result into the next task, and format a join of settled workers.
// No script engine: the coordinator stays the only planner.

/** Replace every `{previous}` placeholder with the previous step's result text. */
export function substitutePrevious(task: string, previous: string | undefined): string {
  if (previous === undefined) return task;
  return task.split('{previous}').join(previous);
}

export type JoinEntry = { name: string; status: string; text: string };

/** One line per worker, result clipped so a join stays readable in one turn. */
export function formatJoin(entries: readonly JoinEntry[], clip = 1200): string {
  return entries
    .map((entry) => {
      const text = entry.text.length > clip ? `${entry.text.slice(0, clip)}\n[clipped; collect with swarm_result]` : entry.text;
      return `== ${entry.name} [${entry.status}] ==\n${text}`;
    })
    .join('\n\n');
}

/** First free worker name: base, then base-2, base-3. Names stay unique so
 * swarm_result and swarm_steer can always address a worker by name. */
export function uniqueName(existing: ReadonlySet<string>, base: string): string {
  if (!existing.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!existing.has(candidate)) return candidate;
  }
}

export type WriterPeer = { name: string; state: string; write: boolean; cwd: string; hasWorktree: boolean };

/** Warning when a writing worker shares its cwd with other active writers
 * and none of them is worktree-isolated. Parallel writes in one checkout are
 * the foreseeable coordinator mistake; the extension names it at spawn. */
export function sharedWriterWarning(agents: readonly WriterPeer[], selfName: string): string | undefined {
  const self = agents.find((agent) => agent.name === selfName);
  if (!self || !self.write || self.hasWorktree) return undefined;
  const peers = agents.filter(
    (agent) =>
      agent.name !== selfName &&
      agent.write &&
      !agent.hasWorktree &&
      agent.cwd === self.cwd &&
      (agent.state === 'running' || agent.state === 'queued'),
  );
  if (!peers.length) return undefined;
  return (
    `WARNING: ${selfName} shares cwd ${self.cwd} with active writer(s) ${peers.map((peer) => peer.name).join(', ')} ` +
    'and none is worktree-isolated. Parallel writes in one checkout can collide. ' +
    'Use isolation "worktree" for parallel writers, or run them one at a time.'
  );
}

/** Error text for an ambiguous worker name. It lists every candidate with
 * its id, state and model, so the coordinator can re-address by id in one
 * step instead of guessing. Duplicate names exist only on workers created
 * before unique naming; new workers are auto-suffixed at spawn. */
export function ambiguousNameMessage(
  name: string,
  matches: readonly { id: string; state: string; model: string }[],
): string {
  const list = matches.map((match) => `${match.id} [${match.state}] ${match.model}`).join('; ');
  return `Worker name "${name}" is ambiguous (${matches.length} workers). Address one by agent id: ${list}`;
}

export type ProviderFailureKind = 'transient' | 'content_filter' | 'other';

/**
 * Classify a provider failure from its error text. Transient transport and
 * quota failures (premature close, resets, timeouts, 429, 5xx, overload)
 * are worth one durable retry: completed tool calls are checkpointed in
 * the transcript, so continuing does not redo them. A content_filter
 * refusal is not retryable unchanged — the same request will be filtered
 * again; the coordinator must re-scope the task or pick another model.
 */
export function classifyProviderError(detail: string): ProviderFailureKind {
  const text = detail.toLowerCase();
  if (text.includes('content_filter') || text.includes('content filter')) return 'content_filter';
  if (
    text.includes('prematurely closed') ||
    text.includes('econnreset') ||
    text.includes('connection') ||
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('429') ||
    text.includes('rate limit') ||
    text.includes('overload') ||
    /\b5\d\d\b/.test(text)
  ) {
    return 'transient';
  }
  return 'other';
}

export const TRANSIENT_RETRY_MESSAGE =
  'The previous provider request failed transiently before completing. Continue the original task from where you left off. Do not redo tool work that already completed.';

export const CONTENT_FILTER_GUIDANCE =
  'This is a provider content_filter refusal. Do not retry the same task unchanged. The coordinator must re-scope or split the task, or assign another eligible model.';

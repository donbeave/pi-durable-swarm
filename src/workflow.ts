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

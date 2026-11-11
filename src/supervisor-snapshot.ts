import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SupervisorSummary } from './runtime.ts';

export const SUPERVISOR_SNAPSHOT_VERSION = '0.6.2';
export const STALE_AGE_SEC = 900;

export function supervisorSummaryPath(workspace: string): string {
  return join(workspace, '.pi', 'durable-swarm', 'supervisor-summary.json');
}

export type SupervisorSnapshotFile = {
  generatedAt: number;
  version: string;
  concurrency: SupervisorSummary['concurrency'];
  tokensByProvider: SupervisorSummary['tokensByProvider'];
  agentsRunning: { name: string; model: string; provider: string; ageSec: number; stale: boolean }[];
  stockpile: { dirty: number; unpushed: number };
  supervisorSummary: SupervisorSummary;
};

export function buildSupervisorSnapshot(sup: SupervisorSummary, version: string = SUPERVISOR_SNAPSHOT_VERSION): SupervisorSnapshotFile {
  return {
    generatedAt: sup.generatedAt,
    version,
    concurrency: sup.concurrency,
    tokensByProvider: sup.tokensByProvider,
    agentsRunning: sup.agents
      .filter((a) => a.state === 'running')
      .map((a) => {
        const ageSec = a.ageSec ?? 0;
        return { name: a.name, model: a.model, provider: a.provider, ageSec, stale: ageSec > STALE_AGE_SEC };
      }),
    stockpile: { dirty: sup.stockpileDirty, unpushed: sup.stockpileUnpushed },
    supervisorSummary: sup,
  };
}

export async function writeSupervisorSnapshot(workspace: string, sup: SupervisorSummary, version?: string): Promise<string | undefined> {
  try {
    const path = supervisorSummaryPath(workspace);
    await mkdir(join(workspace, '.pi', 'durable-swarm'), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(buildSupervisorSnapshot(sup, version), null, 2)}\n`, 'utf8');
    await rename(tmp, path);
    return path;
  } catch {
    return undefined;
  }
}

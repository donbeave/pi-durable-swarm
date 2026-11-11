import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// One swarm store has exactly one owner process. That is a real invariant
// (the Durable harness has no cross-process fencing), so it is enforced
// structurally with an owner lockfile instead of by convention. A lock left
// by a dead process is reclaimed; a lock held by a live process rejects the
// second opener with instructions to talk to the running coordinator.

export type Lease = { release: () => Promise<void> };

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireLease(directory: string): Promise<Lease> {
  const path = join(directory, 'owner.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(path, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      return {
        release: async () => {
          try {
            const current = JSON.parse(await readFile(path, 'utf8')) as { pid?: number };
            if (current.pid === process.pid) await unlink(path);
          } catch {
            // Already gone or replaced; nothing to release.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let ownerPid: number | undefined;
      try {
        ownerPid = (JSON.parse(await readFile(path, 'utf8')) as { pid?: number }).pid;
      } catch {
        ownerPid = undefined;
      }
      if (ownerPid !== undefined && pidAlive(ownerPid)) {
        throw new Error(
          `Another Pi process (pid ${ownerPid}) already owns the swarm store at ${directory}. ` +
            'Run one coordinator per project: send work to that coordinator (for example over its RPC socket) ' +
            'instead of opening a second runtime or reading the store with a side script.',
        );
      }
      // Owner is dead (or the lock is unreadable): reclaim and retry once.
      await unlink(path).catch(() => undefined);
    }
  }
  throw new Error(`Could not acquire the swarm owner lease at ${directory}`);
}

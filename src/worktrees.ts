import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type Worktree = { repository: string; path: string; branch: string; baseCommit: string };

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Create a retained worktree for one writing worker. The worktree starts at
 * recorded HEAD (parent uncommitted changes are never copied), is never
 * auto-committed, auto-merged or auto-removed by this extension, and is
 * reported back so the coordinator can validate and integrate manually.
 */
export async function prepareWorktree(input: {
  cwd: string;
  root: string;
  agentId: string;
}): Promise<Worktree> {
  const repository = await git(input.cwd, ['rev-parse', '--show-toplevel']);
  const baseCommit = await git(input.cwd, ['rev-parse', 'HEAD']);
  const safe = input.agentId.replace(/[^a-zA-Z0-9._-]/g, '-');
  const path = join(input.root, safe);
  const branch = `swarm/${safe}`;

  try {
    await stat(path);
    throw new Error(`Worktree path already exists: ${path}. Refusing to reuse or overwrite it.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  await mkdir(input.root, { recursive: true });
  await git(repository, ['worktree', 'add', '-b', branch, path, baseCommit]);
  return { repository, path, branch, baseCommit };
}

export async function verifyWorktree(worktree: Worktree): Promise<void> {
  const top = await git(worktree.path, ['rev-parse', '--show-toplevel']).catch(() => '');
  if (!top) throw new Error(`Worktree is missing or not a git checkout: ${worktree.path}. Refusing fallback to the parent cwd.`);
}

export async function worktreeHead(worktree: Worktree): Promise<string> {
  return git(worktree.path, ['rev-parse', 'HEAD']);
}

/** Porcelain change list for coordinator validation; empty string means clean. */
export async function worktreeStatus(worktree: Worktree): Promise<string> {
  return git(worktree.path, ['status', '--porcelain']);
}

/**
 * Remove one retained worktree, borrowed from the explicit cleanup rule in
 * anasalqoyyum/pi-durable-subagents: only a clean worktree may go, the call
 * needs the exact recorded path (checked by the caller), and the branch is
 * always retained. Dirty work is refused, never discarded.
 */
export async function removeWorktree(worktree: Worktree): Promise<string> {
  const status = await worktreeStatus(worktree);
  if (status) {
    throw new Error(`Worktree ${worktree.path} has uncommitted changes and will not be removed:\n${status}`);
  }
  await git(worktree.repository, ['worktree', 'remove', worktree.path]);
  return `Removed clean worktree ${worktree.path}. Branch ${worktree.branch} retained.`;
}

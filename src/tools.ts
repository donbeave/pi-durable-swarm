import type { Context } from '@earendil-works/chord';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { getOrThrow, type ExecutionEnv } from '@earendil-works/pi-durable/env';
import { createBashTool, createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools';

// Durable coding tools for swarm children. Replay semantics are the recovery
// contract: reads may replay after a crash; writes, edits and shell commands
// must never blindly replay, because their external effect may already exist.
async function coordinated<T>(
  env: ExecutionEnv | undefined,
  path: string,
  ctx: Context,
  run: () => Promise<T>,
): Promise<T> {
  if (!env) throw new Error('No execution environment');
  const absolute = getOrThrow(await env.absolutePath(path, ctx));
  return withFileMutationQueue(absolute, async () => {
    ctx.abortSignal?.throwIfAborted();
    return run();
  });
}

const read = createReadTool();
const write = createWriteTool();
const edit = createEditTool();
const bash = createBashTool();

export const codingTools = [
  { ...read, replay: 'safe' as const },
  {
    ...write,
    replay: 'unsafe' as const,
    execute: (args: Parameters<typeof write.execute>[0], api: Parameters<typeof write.execute>[1], ctx: Context) =>
      coordinated(api.env, args.path, ctx, () => write.execute(args, api, ctx)),
  },
  {
    ...edit,
    replay: 'unsafe' as const,
    execute: (args: Parameters<typeof edit.execute>[0], api: Parameters<typeof edit.execute>[1], ctx: Context) =>
      coordinated(api.env, args.path, ctx, () => edit.execute(args, api, ctx)),
  },
  { ...bash, replay: 'unsafe' as const },
];

export const READ_ONLY_TOOLS = ['read', 'bash'];
export const WRITE_TOOLS = ['read', 'write', 'edit', 'bash'];

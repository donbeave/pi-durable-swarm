import { defineDoc, type ConversationId, type TaskId } from '@earendil-works/pi-durable';
import type { Worktree } from './worktrees.ts';

export type SwarmResult = { status: 'completed' | 'failed' | 'stopped'; text: string };

export type AgentState = 'queued' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';

export type AgentRecord = {
  id: string;
  name: string;
  role: string;
  /** Canonical eligible model id, e.g. minimax/MiniMax-M3.1-Flash. */
  model: string;
  provider: string;
  thinking: string;
  write: boolean;
  cwd: string;
  conversationId: ConversationId;
  ownerTask: TaskId;
  tasks: TaskId<SwarmResult>[];
  state: AgentState;
  /** Initial task text, delivered by the Runner once a scheduler slot frees. */
  pendingTask?: string;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: SwarmResult;
  worktree?: Worktree;
  changedFiles?: string;
  /** HEAD of the retained worktree when the latest task settled. */
  resultCommit?: string;
  interruptedReason?: 'coordinator-stop';
  interruptedAt?: number;
};

export type SwarmReport = {
  id: string;
  agentId: string;
  result: SwarmResult;
  state: 'pending' | 'delivered';
  worktree?: Worktree;
  changedFiles?: string;
};

/** Durable fleet state, committed atomically with every task creation. */
export const Fleet = defineDoc<{
  agents: Record<string, AgentRecord>;
  requests: Record<string, string>;
  outbox: Record<string, SwarmReport>;
}>({
  kind: 'pi-durable-swarm.fleet',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ agents: {}, requests: {}, outbox: {} }),
});

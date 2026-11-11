// Exact model policy. No fuzzy matching, no cross-provider fallback, ever.
// A requested model either resolves to exactly one eligible registry entry
// or the spawn is rejected before any durable state is created.

export type Thinking = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type EligibleModel = {
  /** Canonical provider/modelId as it must appear in agent definitions. */
  id: string;
  provider: string;
  modelId: string;
  thinking: readonly Thinking[];
  role: string;
};

const MIMO = 'xiaomi-token-plan-sgp';

export const ELIGIBLE_MODELS: readonly EligibleModel[] = [
  { id: `${MIMO}/mimo-v2.6-flash`, provider: MIMO, modelId: 'mimo-v2.6-flash', thinking: ['off', 'high'], role: 'Exploration and audits' },
  { id: `${MIMO}/mimo-v2.6-pro`, provider: MIMO, modelId: 'mimo-v2.6-pro', thinking: ['off', 'high'], role: 'Complex implementation' },
  { id: 'minimax/MiniMax-M3.1-Flash', provider: 'minimax', modelId: 'MiniMax-M3.1-Flash', thinking: ['low', 'medium', 'high', 'xhigh', 'max'], role: 'Implementation and review' },
  { id: 'zai/glm-5.3-flash', provider: 'zai', modelId: 'glm-5.3-flash', thinking: ['low', 'high', 'max'], role: 'Regression tests and verification' },
  { id: 'zai/glm-5.3', provider: 'zai', modelId: 'glm-5.3', thinking: ['low', 'high', 'max'], role: 'Difficult fixes and integration' },
];

export type ResolvedModel = { provider: string; modelId: string; canonical: string };

/**
 * Resolve a request to an eligible model.
 * Accepts the canonical id, or the documented `xiaomi/<id>` alias for the
 * local Xiaomi token-plan provider. Anything else is rejected: unknown
 * providers, old generations, fuzzy names and bare model ids never resolve.
 */
export function resolveModel(request: string): ResolvedModel {
  const normalized = request.startsWith('xiaomi/')
    ? `${MIMO}/${request.slice('xiaomi/'.length)}`
    : request;
  const found = ELIGIBLE_MODELS.find((model) => model.id === normalized);
  if (!found) {
    throw new Error(
      `Model "${request}" is not eligible. Eligible models: ${ELIGIBLE_MODELS.map((m) => m.id).join(', ')}. ` +
        'Fuzzy names, other providers and older generations are rejected, never substituted.',
    );
  }
  return { provider: found.provider, modelId: found.modelId, canonical: found.id };
}

export function assertThinking(model: ResolvedModel, thinking: string): Thinking {
  const found = ELIGIBLE_MODELS.find((m) => m.id === model.canonical);
  if (!found || !(found.thinking as readonly string[]).includes(thinking)) {
    throw new Error(
      `Thinking "${thinking}" is not supported by ${model.canonical}. Supported: ${found?.thinking.join(', ')}. ` +
        'Unsupported levels are rejected, never silently clamped.',
    );
  }
  return thinking as Thinking;
}

/** Built-in worker roles W1-W6, two per provider, exact pins only. */
export const ROLES: Record<string, { description: string; model: string; thinking: Thinking; write: boolean }> = {
  'w1-scout': { description: 'Exploration / audit scout', model: `${MIMO}/mimo-v2.6-flash`, thinking: 'high', write: false },
  'w2-impl-strong': { description: 'Complex implementation', model: `${MIMO}/mimo-v2.6-pro`, thinking: 'high', write: true },
  'w3-impl': { description: 'Implementation', model: 'minimax/MiniMax-M3.1-Flash', thinking: 'high', write: true },
  'w4-audit': { description: 'Independent PR / security audit', model: 'minimax/MiniMax-M3.1-Flash', thinking: 'max', write: false },
  'w5-tests': { description: 'Regression tests', model: 'zai/glm-5.3-flash', thinking: 'high', write: true },
  'w6-fix-strong': { description: 'Difficult fix / integration', model: 'zai/glm-5.3', thinking: 'max', write: true },
};

export function roleInstructions(name: string, write: boolean): string {
  const base =
    `You are worker ${name} in a durable Pi swarm coordinated for Muse Code. ` +
    'Complete exactly the assigned task. Report what changed, the checks you ran and their results, and any limitations.';
  return write
    ? `${base} Work only inside your assigned working directory. Never commit, merge, push or change Git state beyond editing files.`
    : `${base} Do not edit files or change Git state. Use your tools only for inspection and report precise paths with evidence. This is an instruction boundary, not a sandbox: your shell could write, so do not.`;
}

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
  /** Review-only models may never implement, test-write or fix. */
  reviewOnly?: boolean;
};

const MIMO = 'xiaomi-token-plan-sgp';
const KIMI = 'kimi-coding';

// Quality-first policy (operator mandate): speed-optimized variants are
// prohibited for every role, including retries and fallbacks. The check runs
// on the model-id segment, case-insensitively, before eligibility, so a
// prohibited variant is rejected by name and never silently substituted.
export const PROHIBITED_MODEL_TOKENS: readonly string[] = [
  'flash',
  'fast',
  'highspeed',
  'high-speed',
  'turbo',
  'lite',
];

export function prohibitedToken(request: string): string | null {
  const modelId = request.split('/').pop()?.toLowerCase() ?? '';
  return PROHIBITED_MODEL_TOKENS.find((token) => modelId.includes(token)) ?? null;
}

export function assertNotProhibited(request: string): void {
  const token = prohibitedToken(request);
  if (token) {
    throw new Error(
      `Model "${request}" is prohibited: speed-optimized variants (matched "${token}") are banned for all roles. ` +
        'Use a standard or flagship model; never substitute a prohibited variant.',
    );
  }
}

export const ELIGIBLE_MODELS: readonly EligibleModel[] = [
  { id: `${MIMO}/mimo-v2.6-pro`, provider: MIMO, modelId: 'mimo-v2.6-pro', thinking: ['off', 'high'], role: 'Complex implementation' },
  { id: `${KIMI}/k3.1-pro`, provider: KIMI, modelId: 'k3.1-pro', thinking: ['high', 'max'], role: 'Architecture, complex implementation, difficult debugging, security review' },
  { id: `${KIMI}/kimi-for-coding`, provider: KIMI, modelId: 'kimi-for-coding', thinking: ['high', 'max'], role: 'Regular implementation, tests, documentation, code review' },
  { id: 'zai/glm-5.3', provider: 'zai', modelId: 'glm-5.3', thinking: ['low', 'high', 'max'], role: 'Difficult fixes and integration' },
  {
    id: 'openai-codex/gpt-6.1-sol',
    provider: 'openai-codex',
    modelId: 'gpt-6.1-sol',
    thinking: ['low', 'medium', 'high', 'xhigh', 'max'],
    role: 'Independent review (review-only, mandatory reviewer)',
    reviewOnly: true,
  },
];

export type ResolvedModel = { provider: string; modelId: string; canonical: string };

/**
 * Resolve a request to an eligible model.
 * Accepts the canonical id, or the documented `xiaomi/<id>` alias for the
 * local Xiaomi token-plan provider. Anything else is rejected: unknown
 * providers, old generations, fuzzy names and bare model ids never resolve.
 */
export function resolveModel(request: string): ResolvedModel {
  assertNotProhibited(request);
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

export type Role = {
  description: string;
  model: string;
  thinking: Thinking;
  write: boolean;
  /** Disabled roles keep their record for state recovery but reject spawns. */
  disabled?: boolean;
};

/**
 * Built-in worker roles, exact pins only. Roles pinned to prohibited
 * speed-optimized variants (w1, w3, w4, w5) are disabled, not re-pinned:
 * their work moves to the quality models below. w8/w9 are the Kimi roles.
 */
export const ROLES: Record<string, Role> = {
  'w1-scout': { description: 'Exploration / audit scout (disabled: Flash pin prohibited)', model: `${MIMO}/mimo-v2.6-flash`, thinking: 'high', write: false, disabled: true },
  'w2-impl-strong': { description: 'Complex implementation', model: `${MIMO}/mimo-v2.6-pro`, thinking: 'high', write: true },
  'w3-impl': { description: 'Implementation (disabled: Flash pin prohibited)', model: 'minimax/MiniMax-M3.1-Flash', thinking: 'high', write: true, disabled: true },
  'w4-audit': { description: 'Independent PR / security audit (disabled: Flash pin prohibited)', model: 'minimax/MiniMax-M3.1-Flash', thinking: 'max', write: false, disabled: true },
  'w5-tests': { description: 'Regression tests (disabled: Flash pin prohibited)', model: 'zai/glm-5.3-flash', thinking: 'high', write: true, disabled: true },
  'w6-fix-strong': { description: 'Difficult fix / integration', model: 'zai/glm-5.3', thinking: 'max', write: true },
  'w7-review': { description: 'Mandatory independent reviewer (Codex GPT-6.1-SOL, review-only)', model: 'openai-codex/gpt-6.1-sol', thinking: 'high', write: false },
  'w8-kimi-pro': { description: 'Kimi K3.1 Pro: architecture, complex implementation, difficult debugging, security review', model: `${KIMI}/k3.1-pro`, thinking: 'high', write: true },
  'w9-kimi-dev': { description: 'Kimi K2.8 Preview: regular implementation, tests, documentation, review', model: `${KIMI}/kimi-for-coding`, thinking: 'high', write: true },
};

/** Enabled roles only: every model must resolve and support its thinking level. */
export function validateRoles(): void {
  for (const [name, role] of Object.entries(ROLES)) {
    if (role.disabled) continue;
    const resolved = resolveModel(role.model);
    assertThinking(resolved, role.thinking);
    void name;
  }
}

export function roleInstructions(name: string, write: boolean): string {
  const base =
    `You are worker ${name} in a durable Pi swarm coordinated for Muse Code. ` +
    'Complete exactly the assigned task. Report what changed, the checks you ran and their results, and any limitations.';
  return write
    ? `${base} Work only inside your assigned working directory. Never commit, merge, push or change Git state beyond editing files.`
    : `${base} Do not edit files or change Git state. Use your tools only for inspection and report precise paths with evidence. This is an instruction boundary, not a sandbox: your shell could write, so do not.`;
}

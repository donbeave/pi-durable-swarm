import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { createModels, type Models } from '@earendil-works/pi-ai';

/**
 * Adapt Pi's own model registry to the Durable harness. All model traffic
 * (including credentials and provider streams) goes through Pi's registry,
 * so swarm children use exactly the providers configured in Pi.
 */
export function modelsFromPi(registry: ModelRegistry): Models {
  const unsupported = (): never => {
    throw new Error('Deferred model calls are not supported by pi-durable-swarm');
  };
  return {
    ...createModels(),
    getModel: (provider, id) => registry.find(provider, id),
    getModels: (provider) =>
      registry.getAll().filter((model) => !provider || model.provider === provider),
    getProvider: (id) => registry.getProvider(id),
    stream: (model, context, options) => registry.stream(model, context, options),
    complete: (model, context, options) => registry.complete(model, context, options),
    streamSimple: (model, context, options) => registry.streamSimple(model, context, options),
    completeSimple: (model, context, options) =>
      registry.streamSimple(model, context, options).result(),
    streamDeferred: unsupported,
    fetchDeferred: async () => unsupported(),
    cancelDeferred: async () => unsupported(),
  };
}

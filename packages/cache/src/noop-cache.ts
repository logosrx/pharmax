// The disabled cache.
//
// `NoopCache` implements `Cache` as a black hole: every `get` misses,
// every write is discarded. It is the DEFAULT the composition layer
// wires when caching is feature-flagged off, so a deployment with the
// flag off behaves EXACTLY as it did before any cache existed —
// `cached()` falls straight through to the loader on every call.
//
// This is the safe default: turning the feature off can never serve a
// stale value because nothing is ever stored.

import type { Cache, CacheSetOptions } from "./cache.js";

export class NoopCache implements Cache {
  public async get<T>(_key: string): Promise<T | null> {
    return null;
  }

  public async set<T>(_key: string, _value: T, _options: CacheSetOptions): Promise<void> {
    // Intentionally discards the value.
  }

  public async delete(_key: string): Promise<void> {
    // Nothing to remove.
  }

  public async deletePrefix(_prefix: string): Promise<void> {
    // Nothing to remove.
  }
}

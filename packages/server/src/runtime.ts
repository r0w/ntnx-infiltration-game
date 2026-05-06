import type {
  ClusterCache,
  ClusterCacheEntry,
  MockOverlay,
  Variables,
} from '@ntnx-game/engine';
import type {
  ClusterCacheQueries,
  MockOverlayQueries,
  VariableQueries,
} from './db/queries';

export function variablesForSession(
  sessionId: string,
  queries: VariableQueries,
  initial: Record<string, unknown> = {},
): Variables {
  const cache = new Map<string, unknown>();
  const persisted = queries.all(sessionId);
  for (const [k, v] of Object.entries(persisted)) cache.set(k, v);
  for (const [k, v] of Object.entries(initial)) {
    if (!cache.has(k)) cache.set(k, v);
  }
  return {
    get: (name) => cache.get(name),
    has: (name) => cache.has(name),
    set: (name, value, capturedAtStage) => {
      cache.set(name, value);
      queries.upsert(sessionId, name, value, capturedAtStage);
    },
    delete: (name) => {
      cache.delete(name);
      queries.delete(sessionId, name);
    },
    snapshot: () => Object.fromEntries(cache),
  };
}

export function clusterCacheForSession(
  sessionId: string,
  queries: ClusterCacheQueries,
): ClusterCache {
  return {
    get: (kind, logicalName) => queries.get(sessionId, kind, logicalName),
    set: (entry: ClusterCacheEntry) => queries.set(sessionId, entry),
    all: () => queries.all(sessionId),
  };
}

export function mockOverlayForSession(
  sessionId: string,
  queries: MockOverlayQueries,
): MockOverlay {
  return {
    mark: (kind, logicalName, op) => queries.mark(sessionId, kind, logicalName, op),
    unmark: (kind, logicalName) => queries.unmark(sessionId, kind, logicalName),
    list: () => queries.all(sessionId),
  };
}

import { getDb } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { canMakeRequest, canUseTokens, isOnCooldown } from './ratelimit.js';
import type { BaseProvider } from '../providers/base.js';

interface ModelRow {
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
}

interface KeyRow {
  id: number;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: number;
}

interface FallbackRow {
  model_db_id: number;
  priority: number;
  enabled: number;
}

export interface RouteResult {
  provider: BaseProvider;
  modelId: string;
  modelDbId: number;
  apiKey: string;
  keyId: number;
  platform: string;
  displayName: string;
}

// Round-robin index per platform
const roundRobinIndex = new Map<string, number>();

// ── Dynamic priority: track 429s per model and demote accordingly ──
const rateLimitPenalties = new Map<number, { count: number; lastHit: number; penalty: number }>();

const PENALTY_PER_429 = 3;
const MAX_PENALTY = 10;
const DECAY_INTERVAL_MS = 2 * 60 * 1000;
const DECAY_AMOUNT = 1;

export function recordRateLimitHit(modelDbId: number) {
  const existing = rateLimitPenalties.get(modelDbId);
  const now = Date.now();
  if (existing) {
    existing.count++;
    existing.lastHit = now;
    existing.penalty = Math.min(existing.penalty + PENALTY_PER_429, MAX_PENALTY);
  } else {
    rateLimitPenalties.set(modelDbId, { count: 1, lastHit: now, penalty: PENALTY_PER_429 });
  }
}

export function recordSuccess(modelDbId: number) {
  const existing = rateLimitPenalties.get(modelDbId);
  if (existing) {
    existing.penalty = Math.max(0, existing.penalty - 1);
    if (existing.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
    }
  }
}

function getPenalty(modelDbId: number): number {
  const entry = rateLimitPenalties.get(modelDbId);
  if (!entry) return 0;

  const now = Date.now();
  const elapsed = now - entry.lastHit;
  const decaySteps = Math.floor(elapsed / DECAY_INTERVAL_MS);
  if (decaySteps > 0) {
    entry.penalty = Math.max(0, entry.penalty - (decaySteps * DECAY_AMOUNT));
    entry.lastHit = now;
    if (entry.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
      return 0;
    }
  }

  return entry.penalty;
}

export function getAllPenalties(): Array<{ modelDbId: number; count: number; penalty: number }> {
  const result: Array<{ modelDbId: number; count: number; penalty: number }> = [];
  for (const [modelDbId, entry] of rateLimitPenalties) {
    const penalty = getPenalty(modelDbId);
    if (penalty > 0) {
      result.push({ modelDbId, count: entry.count, penalty });
    }
  }
  return result.sort((a, b) => b.penalty - a.penalty);
}

/**
 * Route a request to the best available model.
 *
 * Priority order (highest to lowest):
 *  1. Sticky session model (preferredModelDbId) — keeps multi-turn conversations
 *     on the same model to prevent hallucination from context switching.
 *  2. Judge-preferred models (preferredModelIds) — the LLM judge's ordered list
 *     for the classified task_type × complexity, moved to the front of the chain.
 *  3. Remaining models sorted by (base_priority + rate_limit_penalty).
 *
 * @param estimatedTokens    estimated total tokens for rate limit check
 * @param skipKeys           "platform:modelId:keyId" entries to skip (failed this request)
 * @param preferredModelDbId sticky session model db id — tried before anything else
 * @param preferredModelIds  judge-ordered model_id list — reorders the fallback chain
 */
export function routeRequest(
  estimatedTokens = 1000,
  skipKeys?: Set<string>,
  preferredModelDbId?: number,
  preferredModelIds?: string[],
): RouteResult {
  const db = getDb();

  // Get fallback chain ordered by priority
  const fallbackChain = db.prepare(`
    SELECT fc.model_db_id, fc.priority, fc.enabled
    FROM fallback_config fc
    ORDER BY fc.priority ASC
  `).all() as FallbackRow[];

  // Apply dynamic penalties: sort by (base priority + penalty)
  const sortedChain = fallbackChain.map(entry => ({
    ...entry,
    effectivePriority: entry.priority + getPenalty(entry.model_db_id),
  })).sort((a, b) => a.effectivePriority - b.effectivePriority);

  // ── Judge-based reordering ────────────────────────────────────────────────
  // Batch-fetch all model_ids in one query to avoid N+1 per entry.
  if (preferredModelIds && preferredModelIds.length > 0) {
    // Config entries are "platform/model_id" format (e.g. "groq/llama-3.1-8b-instant").
    // Build a lookup key of the same format from the DB so matching is unambiguous.
    const allModels = db.prepare(`
      SELECT id, platform, model_id FROM models
    `).all() as { id: number; platform: string; model_id: string }[];

    const dbIdToKey = new Map<number, string>();
    for (const row of allModels) {
      dbIdToKey.set(row.id, row.platform + '/' + row.model_id);
    }

    // Support both "platform/model_id" (new) and bare "model_id" (legacy) in config.
    // For bare entries, match any platform that has that model_id.
    const preferredSet = new Set(preferredModelIds);
    const preferredIndexMap = new Map(preferredModelIds.map((id, i) => [id, i]));

    function getMatchKey(dbKey: string, modelId: string): string | undefined {
      // Exact platform/model_id match
      if (preferredSet.has(dbKey)) return dbKey;
      // Legacy bare model_id match
      if (preferredSet.has(modelId)) return modelId;
      return undefined;
    }

    const preferred: typeof sortedChain = [];
    const rest: typeof sortedChain = [];

    for (const entry of sortedChain) {
      const dbKey = dbIdToKey.get(entry.model_db_id) ?? '';
      const modelId = dbKey.split('/').slice(1).join('/');
      const matchKey = getMatchKey(dbKey, modelId);
      if (matchKey) {
        preferred.push({ ...entry, _matchKey: matchKey } as any);
      } else {
        rest.push(entry);
      }
    }

    // Sort preferred entries by the judge's specified order
    preferred.sort((a: any, b: any) => {
      const aIdx = preferredIndexMap.get(a._matchKey) ?? 999;
      const bIdx = preferredIndexMap.get(b._matchKey) ?? 999;
      return aIdx - bIdx;
    });

    sortedChain.length = 0;
    sortedChain.push(...preferred, ...rest);
  }
  // ── End judge-based reordering ────────────────────────────────────────────

  // Sticky session: move preferred model to front of chain (overrides judge)
  if (preferredModelDbId) {
    const idx = sortedChain.findIndex(e => e.model_db_id === preferredModelDbId);
    if (idx > 0) {
      const [preferred] = sortedChain.splice(idx, 1);
      sortedChain.unshift(preferred);
    }
  }

  for (const entry of sortedChain) {
    if (!entry.enabled) continue;

    const model = db.prepare('SELECT * FROM models WHERE id = ? AND enabled = 1').get(entry.model_db_id) as ModelRow | undefined;
    if (!model) continue;

    const provider = getProvider(model.platform as any);
    if (!provider) continue;

    const keys = db.prepare(
      'SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status != ?'
    ).all(model.platform, 'invalid') as KeyRow[];

    if (keys.length === 0) continue;

    const limits = {
      rpm: model.rpm_limit,
      rpd: model.rpd_limit,
      tpm: model.tpm_limit,
      tpd: model.tpd_limit,
    };

    const rrKey = `${model.platform}:${model.model_id}`;
    let idx = roundRobinIndex.get(rrKey) ?? 0;

    for (let attempt = 0; attempt < keys.length; attempt++) {
      const key = keys[idx % keys.length];
      idx++;

      const skipId = `${model.platform}:${model.model_id}:${key.id}`;
      if (skipKeys?.has(skipId)) continue;

      if (isOnCooldown(model.platform, model.model_id, key.id)) continue;
      if (!canMakeRequest(model.platform, model.model_id, key.id, limits)) continue;
      if (!canUseTokens(model.platform, model.model_id, key.id, estimatedTokens, limits)) continue;

      roundRobinIndex.set(rrKey, idx);
      const decryptedKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);

      return {
        provider,
        modelId: model.model_id,
        modelDbId: model.id,
        apiKey: decryptedKey,
        keyId: key.id,
        platform: model.platform,
        displayName: model.display_name,
      };
    }

    roundRobinIndex.set(rrKey, idx);
  }

  const err = new Error('All models exhausted. Add more API keys or wait for rate limits to reset.') as any;
  err.status = 429;
  throw err;
}
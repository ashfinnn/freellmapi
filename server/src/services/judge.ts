/**
 * judge.ts
 *
 * Classifies an incoming request by task_type and complexity using the cheapest
 * available healthy model. The result is used to reorder the fallback chain so
 * the most capable model for the task is tried first.
 *
 * Design constraints:
 *  - Uses the highest intelligence_rank (= cheapest/weakest) enabled model with
 *    at least one healthy key — no extra cost.
 *  - Hard 1500 ms timeout; on failure the caller falls back to normal routing.
 *  - Returns a plain JSON object: { task_type, complexity }
 *  - Judge never sees the full conversation — only the last user message (plus
 *    the system message if present), keeping the judge call cheap.
 */

import { getDb } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { isOnCooldown, canMakeRequest } from './ratelimit.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';

export type TaskType = 'coding' | 'reasoning' | 'creative' | 'factual' | 'summarization' | 'chat';
export type Complexity = 'simple' | 'medium' | 'hard';

export interface JudgeResult {
  task_type: TaskType;
  complexity: Complexity;
}

const JUDGE_TIMEOUT_MS = 2500;

const TASK_TYPES: TaskType[] = ['coding', 'reasoning', 'creative', 'factual', 'summarization', 'chat'];
const COMPLEXITIES: Complexity[] = ['simple', 'medium', 'hard'];

const JUDGE_SYSTEM_PROMPT = `You are a request classifier. Given a user message, output ONLY a JSON object with two fields:
- "task_type": one of ${TASK_TYPES.map(t => `"${t}"`).join(', ')}
- "complexity": one of "simple", "medium", "hard"

Rules:
- coding: any programming, debugging, code review, or script writing task
- reasoning: math, logic puzzles, multi-step analysis, argument evaluation
- creative: stories, poems, brainstorming, writing assistance, humor
- factual: definitions, how-things-work, historical/scientific facts, lookup
- summarization: condensing or extracting from provided text
- chat: casual conversation, greetings, opinions, anything else

Complexity:
- simple: short, single-step, no domain knowledge needed
- medium: multi-step or moderate domain knowledge
- hard: expert-level, long context, deep reasoning or synthesis required

Respond ONLY with the JSON object. No explanation, no markdown.`;

interface ModelRow {
  id: number;
  platform: string;
  model_id: string;
  intelligence_rank: number;
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
}

/**
 * Find the cheapest (highest intelligence_rank = weakest) available model+key.
 * Returns null if nothing is available.
 */
function getCheapestAvailableModel(): { model: ModelRow; apiKey: string; keyId: number } | null {
  const db = getDb();

  // Highest intelligence_rank = weakest/cheapest model
  const models = db.prepare(`
    SELECT m.id, m.platform, m.model_id, m.intelligence_rank,
           m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit
    FROM models m
    INNER JOIN fallback_config f ON m.id = f.model_db_id
    WHERE m.enabled = 1
      AND f.enabled = 1
      AND m.platform NOT IN ('llm7', 'pollinations', 'kilo', 'ollama')
    ORDER BY m.intelligence_rank DESC
  `).all() as ModelRow[];

  for (const model of models) {
    const provider = getProvider(model.platform as any);
    if (!provider) continue;

    const keys = db.prepare(
      "SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status != 'invalid'"
    ).all(model.platform) as KeyRow[];

    if (keys.length === 0) continue;

    const limits = {
      rpm: model.rpm_limit,
      rpd: model.rpd_limit,
      tpm: model.tpm_limit,
      tpd: model.tpd_limit,
    };

    for (const key of keys) {
      if (isOnCooldown(model.platform, model.model_id, key.id)) continue;
      // Estimate 200 tokens for the judge call itself
      if (!canMakeRequest(model.platform, model.model_id, key.id, limits)) continue;

      const apiKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
      return { model, apiKey, keyId: key.id };
    }
  }

  return null;
}

/**
 * Extract the minimal context for the judge:
 * - system message (if any), truncated to 300 chars
 * - last user message, truncated to 500 chars
 */
function extractJudgeContext(messages: ChatMessage[]): string {
  const system = messages.find(m => m.role === 'system');
  const lastUser = [...messages].reverse().find(m => m.role === 'user');

  const parts: string[] = [];
  if (system && typeof system.content === 'string') {
    parts.push(`[system]: ${system.content.slice(0, 300)}`);
  }
  if (lastUser && typeof lastUser.content === 'string') {
    parts.push(lastUser.content.slice(0, 500));
  }

  return parts.join('\n');
}

function isValidJudgeResult(obj: any): obj is JudgeResult {
  return (
    obj &&
    typeof obj === 'object' &&
    TASK_TYPES.includes(obj.task_type) &&
    COMPLEXITIES.includes(obj.complexity)
  );
}

/**
 * Classify the request. Returns null on any failure so the caller can fall back
 * to the standard availability-based router silently.
 */
export async function classifyRequest(messages: ChatMessage[]): Promise<JudgeResult | null> {
  const slot = getCheapestAvailableModel();
  if (!slot) return null;

  const { model, apiKey } = slot;
  const provider = getProvider(model.platform as any);
  if (!provider) return null;

  const userContent = extractJudgeContext(messages);
  if (!userContent.trim()) return null;

  const judgeMessages: ChatMessage[] = [
    { role: 'system', content: JUDGE_SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];

  try {
    const result = await Promise.race([
      provider.chatCompletion(apiKey, judgeMessages, model.model_id, {
        max_tokens: 60,
        temperature: 0,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Judge timeout')), JUDGE_TIMEOUT_MS)
      ),
    ]);

    const rawContent = result.choices?.[0]?.message?.content ?? '';
    // Normalize content which may be a string or an array of content blocks
    let raw: string;
    if (typeof rawContent === 'string') {
      raw = rawContent;
    } else if (Array.isArray(rawContent)) {
      raw = rawContent.map(block => typeof block === 'string' ? block : (block as any)?.content ?? JSON.stringify(block)).join('\n');
    } else {
      raw = String(rawContent);
    }

    console.log('[Judge] raw response:', raw, 'model:', model.platform + '/' + model.model_id);
    // Strip markdown fences if the model ignored instructions
    const cleaned = raw.replace(/```(?:json)?/g, '').trim();
    const parsed = JSON.parse(cleaned);

    if (!isValidJudgeResult(parsed)) {
      console.log('[Judge] invalid result:', parsed);
      return null;
    }
    console.log('[Judge] classified: task=' + parsed.task_type + ' complexity=' + parsed.complexity);
    return parsed;
  } catch (err: any) {
    console.log('[Judge] failed:', err?.message ?? err);
    return null;
  }
}
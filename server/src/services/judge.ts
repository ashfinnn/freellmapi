/**
 * judge.ts
 *
 * Lightweight request classifier used to reorder the fallback chain.
 * It runs only when a cheap healthy model is available and returns:
 *   { task_type, complexity }
 *
 * Design goals:
 * - Use the cheapest available healthy model with a healthy API key.
 * - Fail fast and silently on any error.
 * - Keep the prompt tiny.
 * - Be resilient to messy model output.
 * - Fast-path obvious requests without spending a judge call.
 */

import { getDb } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { isOnCooldown, canMakeRequest } from './ratelimit.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';

export type TaskType =
  | 'coding'
  | 'reasoning'
  | 'creative'
  | 'factual'
  | 'summarization'
  | 'chat';

export type Complexity = 'simple' | 'medium' | 'hard';

export interface JudgeResult {
  task_type: TaskType;
  complexity: Complexity;
}

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

const JUDGE_TIMEOUT_MS = 1500;
const JUDGE_MAX_TOKENS = 48;

const TASK_TYPES = new Set<TaskType>([
  'coding',
  'reasoning',
  'creative',
  'factual',
  'summarization',
  'chat',
]);

const COMPLEXITIES = new Set<Complexity>(['simple', 'medium', 'hard']);

const JUDGE_SYSTEM_PROMPT = `You are a request classifier.

Return ONLY valid JSON with exactly these keys:
{"task_type":"...", "complexity":"..."}

task_type must be one of:
coding, reasoning, creative, factual, summarization, chat

complexity must be one of:
simple, medium, hard

Guidance:
- coding: programming, debugging, code review, scripts
- reasoning: math, logic, planning, analysis, multi-step thought
- creative: stories, poems, rewriting, brainstorming, humor
- factual: facts, explanations, how things work, lookups
- summarization: condensing, extracting, summarizing provided text
- chat: greetings, casual talk, opinions, small talk

- simple: one step, short, low effort
- medium: a few steps or some domain knowledge
- hard: deep reasoning, expert knowledge, long context, synthesis

No markdown. No explanation. No extra keys.`;

function getCheapestAvailableModel(): { model: ModelRow; apiKey: string; keyId: number } | null {
  const db = getDb();

  const models = db.prepare(`
    SELECT
      m.id,
      m.platform,
      m.model_id,
      m.intelligence_rank,
      m.rpm_limit,
      m.rpd_limit,
      m.tpm_limit,
      m.tpd_limit
    FROM models m
    INNER JOIN fallback_config f ON m.id = f.model_db_id
    WHERE m.enabled = 1
      AND f.enabled = 1
    ORDER BY m.intelligence_rank DESC, m.id DESC
  `).all() as ModelRow[];

  for (const model of models) {
    const provider = getProvider(model.platform as any);
    if (!provider) continue;

    const keys = db
      .prepare(
        `SELECT *
         FROM api_keys
         WHERE platform = ?
           AND enabled = 1
           AND status != 'invalid'
         ORDER BY id ASC`
      )
      .all(model.platform) as KeyRow[];

    if (!keys.length) continue;

    const limits = {
      rpm: model.rpm_limit,
      rpd: model.rpd_limit,
      tpm: model.tpm_limit,
      tpd: model.tpd_limit,
    };

    for (const key of keys) {
      if (isOnCooldown(model.platform, model.model_id, key.id)) continue;
      if (!canMakeRequest(model.platform, model.model_id, key.id, limits)) continue;

      try {
        const apiKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
        return { model, apiKey, keyId: key.id };
      } catch {
        continue;
      }
    }
  }

  return null;
}

function isTextMessage(
  message: ChatMessage,
  role: ChatMessage['role'],
): message is ChatMessage & { content: string } {
  return message.role === role && typeof message.content === 'string' && message.content.trim().length > 0;
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen);
}

function getLastUserText(messages: ChatMessage[]): string | null {
  const lastUser = [...messages].reverse().find((m): m is ChatMessage & { content: string } => isTextMessage(m, 'user'));
  return lastUser ? lastUser.content.trim() : null;
}

function extractJudgeContext(messages: ChatMessage[]): string {
  const systemMessages = messages.filter((m): m is ChatMessage & { content: string } => isTextMessage(m, 'system'));
  const lastUser = getLastUserText(messages);

  const parts: string[] = [];

  if (systemMessages.length) {
    const systemText = systemMessages.map((m) => m.content.trim()).join('\n');
    parts.push(`[system]\n${truncate(systemText, 400)}`);
  }

  if (lastUser) {
    parts.push(`[user]\n${truncate(lastUser, 700)}`);
  }

  return parts.join('\n\n');
}

function detectFastPath(userText: string): JudgeResult | null {
  const trimmed = userText.trim();

  if (!trimmed) return null;

  // Trivial arithmetic: bypass the judge entirely.
  if (/^\s*-?\d+(?:\.\d+)?\s*[\+\-\*\/]\s*-?\d+(?:\.\d+)?\s*$/.test(trimmed)) {
    return {
      task_type: 'factual',
      complexity: 'simple',
    };
  }
  // Obvious small-talk.
  if (/^(hi|hello|hey|yo|sup|good (morning|afternoon|evening))\b/i.test(trimmed)) {
    return { task_type: 'chat', complexity: 'simple' };
  }

  // Obvious summarization requests on long text.
  if (
    trimmed.length >= 1500 &&
    /(summarize|summary|tl;dr|tldr|condense|extract the main points)/i.test(trimmed)
  ) {
    return { task_type: 'summarization', complexity: 'medium' };
  }

  return null;
}

function stripCodeFences(text: string): string {
  return text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

function stripThinkingBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function extractFirstJSONObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') depth++;
    if (ch === '}') depth--;

    if (depth === 0) {
      return text.slice(start, i + 1);
    }
  }

  return null;
}

function normalizeJudgeResult(value: unknown): JudgeResult | null {
  if (!value || typeof value !== 'object') return null;

  const obj = value as Record<string, unknown>;
  const task = typeof obj.task_type === 'string' ? obj.task_type.toLowerCase().trim() : '';
  const complexity = typeof obj.complexity === 'string' ? obj.complexity.toLowerCase().trim() : '';

  if (!TASK_TYPES.has(task as TaskType)) return null;
  if (!COMPLEXITIES.has(complexity as Complexity)) return null;

  return {
    task_type: task as TaskType,
    complexity: complexity as Complexity,
  };
}

function parseJudgeResponse(raw: string): JudgeResult | null {
  const cleaned = stripThinkingBlocks(stripCodeFences(raw));
  const jsonText = extractFirstJSONObject(cleaned) ?? cleaned;

  try {
    const parsed = JSON.parse(jsonText);
    return normalizeJudgeResult(parsed);
  } catch {
    return null;
  }
}

/**
 * Classify the request. Returns null on any failure so the caller can
 * fall back to normal routing.
 */
export async function classifyRequest(messages: ChatMessage[]): Promise<JudgeResult | null> {
  const lastUserText = getLastUserText(messages);
  if (!lastUserText) return null;

  // Cheap bypass for obvious requests.
  const fastPath = detectFastPath(lastUserText);
  if (fastPath) return fastPath;

  const slot = getCheapestAvailableModel();
  if (!slot) return null;

  const provider = getProvider(slot.model.platform as any);
  if (!provider) return null;

  const userContent = extractJudgeContext(messages);
  if (!userContent.trim()) return null;

  const judgeMessages: ChatMessage[] = [
    { role: 'system', content: JUDGE_SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const result = await Promise.race([
      provider.chatCompletion(slot.apiKey, judgeMessages, slot.model.model_id, {
        max_tokens: JUDGE_MAX_TOKENS,
        temperature: 0,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Judge timeout')), JUDGE_TIMEOUT_MS);
      }),
    ]);

    const raw = String(result?.choices?.[0]?.message?.content ?? '');
    const parsed = parseJudgeResponse(raw);

    if (!parsed) {
      console.log('[Judge] failed to parse response');
      return null;
    }

    console.log(
      `[Judge] task=${parsed.task_type} complexity=${parsed.complexity}`
    );

    if (process.env.NODE_ENV !== 'production') {
      console.debug('[Judge]', {
        platform: slot.model.platform,
        model_id: slot.model.model_id,
        parsed,
      });
    }

    return parsed;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
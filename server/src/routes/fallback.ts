import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { getAllPenalties } from '../services/router.js';

export const fallbackRouter = Router();

// Get fallback chain (with dynamic penalties)
fallbackRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT fc.model_db_id, fc.priority, fc.enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
           m.monthly_token_budget
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    ORDER BY fc.priority ASC
  `).all() as any[];

  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys WHERE enabled = 1
    GROUP BY platform
  `).all() as { platform: string; count: number }[];
  const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));

  const penalties = getAllPenalties();
  const penaltyMap = new Map(penalties.map(p => [p.modelDbId, p]));

  res.json(rows.map(r => {
    const penalty = penaltyMap.get(r.model_db_id);
    return {
      modelDbId: r.model_db_id,
      priority: r.priority,
      effectivePriority: r.priority + (penalty?.penalty ?? 0),
      penalty: penalty?.penalty ?? 0,
      rateLimitHits: penalty?.count ?? 0,
      enabled: r.enabled === 1,
      platform: r.platform,
      modelId: r.model_id,
      displayName: r.display_name,
      intelligenceRank: r.intelligence_rank,
      speedRank: r.speed_rank,
      sizeLabel: r.size_label,
      rpmLimit: r.rpm_limit,
      rpdLimit: r.rpd_limit,
      monthlyTokenBudget: r.monthly_token_budget,
      keyCount: keyCountMap.get(r.platform) ?? 0,
    };
  }));
});

const updateSchema = z.array(z.object({
  modelDbId: z.number(),
  priority: z.number(),
  enabled: z.boolean(),
}));

// Update fallback chain (full replace)
fallbackRouter.put('/', (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const update = db.prepare(`
    UPDATE fallback_config SET priority = ?, enabled = ? WHERE model_db_id = ?
  `);

  const updateAll = db.transaction(() => {
    for (const entry of parsed.data) {
      update.run(entry.priority, entry.enabled ? 1 : 0, entry.modelDbId);
    }
  });
  updateAll();

  res.json({ success: true });
});

// ── Sort presets ────────────────────────────────────────────────────────────
// `orderBy` is selected from a fixed whitelist so interpolation is safe.

const SORT_PRESETS: Record<string, string> = {
  intelligence: 'm.intelligence_rank ASC',
  speed:        'm.speed_rank ASC',
  budget: `CASE m.monthly_token_budget
    WHEN '~120M'     THEN 1
    WHEN '~50-100M'  THEN 2
    WHEN '~30M'      THEN 3
    WHEN '~20-30M'   THEN 4
    WHEN '~18-45M'   THEN 5
    WHEN '~18M'      THEN 6
    WHEN '~15M'      THEN 7
    WHEN '~10-20M'   THEN 8
    WHEN '~9M'       THEN 9
    WHEN '~6M'       THEN 10
    WHEN '~5-10M'    THEN 11
    WHEN '~3-5M'     THEN 12
    WHEN '~3M'       THEN 13
    ELSE 14 END ASC`,
};

// Availability-optimised order computed from:
//   score = rpm_score + rpd_score + (12 - speed_rank)*3 + budget_score
// Higher score = less likely to 429 = should be tried first.
// Precomputed May 2026 against the live catalog.
const AVAILABILITY_ORDER: number[] = [
  112,114,110,111,113,  // llm7 (100 RPM, no RPD cap)
  10,                   // cerebras qwen3-235b (30 RPM, 14400 RPD)
  55,                   // groq llama-3.1-8b-instant (30 RPM, 14400 RPD)
  19,95,96,             // nvidia llama models (40 RPM, no RPD cap, credits)
  54,                   // groq qwen3-32b (60 RPM)
  101,102,97,98,99,100,103, // nvidia other models (40 RPM)
  23,80,                // zhipu glm (no hard limits, large budget)
  93,94,                // ollama large budget models
  91,                   // ollama gpt-oss:120b
  108,                  // kilo (200/hr)
  2685,105,             // cerebras gpt-oss-120b, llama3.1-8b (30 RPM, 1000 RPD)
  85,86,87,88,89,90,    // ollama frontier models
  21,60,61,62,65,       // cloudflare (no hard limits, 18-45M budget)
  92,                   // ollama devstral-2
  109,                  // pollinations (anon)
  18,                   // groq llama-4-scout
  83,64,                // cloudflare kimi-k2.6, kimi-k2.5 (10-20M budget)
  17,                   // groq llama-3.3-70b
  84,                   // cloudflare granite micro
  66,                   // cloudflare deepseek-r1-distill
  52,53,106,107,        // groq gpt-oss, compound
  16,14,15,56,57,       // mistral (2 RPM but large budget — last resort quality)
  3,67,                 // google flash-lite (fast but 20 RPD)
  40,45,46,47,6,39,38,7,72,73,74,75,2651,44,76, // openrouter :free (20 RPM, 200 RPD)
  2,68,                 // google flash (20 RPD)
  12,                   // github gpt-4o (10 RPM, 50 RPD)
  13,48,49,50,51,81,82, // sambanova (20 RPM, 20 RPD — low daily cap)
  77,78,71,79,          // openrouter small/slow models
  58,                   // github gpt-4.1
  20,59,                // cohere (20 RPM, 33 RPD — very low budget)
  69,                   // google pro preview (5 RPM, 20 RPD)
];

fallbackRouter.post('/sort/:preset', (req: Request, res: Response) => {
  const preset = String(req.params.preset);

  if (preset === 'availability') {
    return applyAvailabilitySortHttp(res);
  }

  const orderBy = SORT_PRESETS[preset];
  if (!orderBy) {
    res.status(400).json({
      error: { message: `Unknown preset: ${preset}. Use: intelligence, speed, budget, availability` },
    });
    return;
  }

  const db = getDb();
  const models = db.prepare(`SELECT m.id FROM models m ORDER BY ${orderBy}`).all() as { id: number }[];

  const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
  const reorder = db.transaction(() => {
    for (let i = 0; i < models.length; i++) {
      update.run(i + 1, models[i].id);
    }
  });
  reorder();

  res.json({ success: true, preset });
});

export function applyAvailabilitySort(): number {
  const db = getDb();

  const allIds = db.prepare(`
    SELECT model_db_id FROM fallback_config
  `).all() as { model_db_id: number }[];
  const allIdSet = new Set(allIds.map(r => r.model_db_id));

  const orderedSet = new Set(AVAILABILITY_ORDER);
  const tail = [...allIdSet].filter(id => !orderedSet.has(id)).sort((a, b) => a - b);
  const finalOrder = [...AVAILABILITY_ORDER.filter(id => allIdSet.has(id)), ...tail];

  const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
  const reorder = db.transaction(() => {
    for (let i = 0; i < finalOrder.length; i++) {
      update.run(i + 1, finalOrder[i]);
    }
  });
  reorder();

  return finalOrder.length;
}

function applyAvailabilitySortHttp(res: Response) {
  const applied = applyAvailabilitySort();
  res.json({ success: true, preset: 'availability', applied });
}

// Token usage per model for the stacked bar
fallbackRouter.get('/token-usage', (_req: Request, res: Response) => {
  const db = getDb();

  const platforms = db.prepare(`
    SELECT DISTINCT ak.platform
    FROM api_keys ak
    WHERE ak.enabled = 1
  `).all() as { platform: string }[];
  const platformSet = new Set(platforms.map(p => p.platform));

  const models = db.prepare(`
    SELECT m.platform, m.model_id, m.display_name, m.monthly_token_budget,
           fc.priority
    FROM models m
    JOIN fallback_config fc ON fc.model_db_id = m.id
    WHERE m.enabled = 1
    ORDER BY fc.priority ASC
  `).all() as { platform: string; model_id: string; display_name: string; monthly_token_budget: string; priority: number }[];

  function parseBudget(s: string): number {
    const m = s.match(/~?([\d.]+)(?:-([\d.]+))?([MK])?/);
    if (!m) return 0;
    const high = parseFloat(m[2] ?? m[1]);
    const unit = m[3] === 'M' ? 1_000_000 : m[3] === 'K' ? 1_000 : 1;
    return high * unit;
  }

  const modelBudgets = models
    .filter(m => platformSet.has(m.platform))
    .map(m => ({
      displayName: m.display_name,
      platform: m.platform,
      budget: parseBudget(m.monthly_token_budget),
    }));

  const totalBudget = modelBudgets.reduce((s, m) => s + m.budget, 0);

  const usage = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens + output_tokens), 0) as total_used
    FROM requests
    WHERE created_at >= datetime('now', 'start of month')
  `).get() as { total_used: number };

  res.json({
    totalBudget,
    totalUsed: usage.total_used,
    models: modelBudgets,
  });
});
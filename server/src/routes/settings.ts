import { Router } from 'express';
import type { Request, Response } from 'express';
import { getUnifiedApiKey, regenerateUnifiedKey } from '../db/index.js';
import { getRouterConfig, setRouterConfig } from '../services/routerConfig.js';

export const settingsRouter = Router();

// Get the unified API key
settingsRouter.get('/api-key', (_req: Request, res: Response) => {
  res.json({ apiKey: getUnifiedApiKey() });
});

// Regenerate the unified API key
settingsRouter.post('/api-key/regenerate', (_req: Request, res: Response) => {
  const newKey = regenerateUnifiedKey();
  res.json({ apiKey: newKey });
});

// ── Router config (LLM judge routing table) ────────────────────────────────

// GET /settings/router-config
// Returns the full task_type × complexity → model list mapping.
settingsRouter.get('/router-config', (_req: Request, res: Response) => {
  res.json(getRouterConfig());
});

// PUT /settings/router-config
// Replaces the routing table. Body must be the full config JSON object.
settingsRouter.put('/router-config', (req: Request, res: Response) => {
  try {
    const updated = setRouterConfig(req.body);
    res.json({ ok: true, config: updated });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

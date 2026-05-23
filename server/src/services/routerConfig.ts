import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { TaskType, Complexity } from './judge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, '../../config/router-config.json');

type RouterConfig = Record<string, Record<string, string[]>>;

const VALID_TASK_TYPES: TaskType[] = ['coding', 'reasoning', 'creative', 'factual', 'summarization', 'chat'];
const VALID_COMPLEXITIES: Complexity[] = ['simple', 'medium', 'hard'];

let _config: RouterConfig | null = null;

function loadConfig(): RouterConfig {
  if (_config) return _config;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    _config = JSON.parse(raw) as RouterConfig;
    console.log('[RouterConfig] Loaded router-config.json');
    return _config;
  } catch (err) {
    console.warn('[RouterConfig] Failed to load router-config.json, using empty config:', err);
    _config = {};
    return _config;
  }
}

export function getPreferredModelIds(taskType: TaskType, complexity: Complexity): string[] {
  const config = loadConfig();
  const ids = config?.[taskType]?.[complexity] ?? [];
  if (ids.length > 0) {
    console.log('[RouterConfig] ' + taskType + '/' + complexity + ' -> [' + ids.join(', ') + ']');
  }
  return ids;
}

export function getRouterConfig(): RouterConfig {
  return loadConfig();
}

export function setRouterConfig(newConfig: unknown): RouterConfig {
  if (typeof newConfig !== 'object' || newConfig === null || Array.isArray(newConfig)) {
    throw new Error('Config must be a JSON object');
  }

  const config = newConfig as Record<string, unknown>;

  for (const taskType of VALID_TASK_TYPES) {
    if (!(taskType in config)) continue;
    const byComplexity = config[taskType];
    if (typeof byComplexity !== 'object' || byComplexity === null) {
      throw new Error('config.' + taskType + ' must be an object');
    }
    for (const complexity of VALID_COMPLEXITIES) {
      const entry = (byComplexity as Record<string, unknown>)[complexity];
      if (entry === undefined) continue;
      if (!Array.isArray(entry) || !entry.every((e) => typeof e === 'string')) {
        throw new Error('config.' + taskType + '.' + complexity + ' must be an array of strings');
      }
    }
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2), 'utf-8');
  _config = newConfig as RouterConfig;
  return _config;
}
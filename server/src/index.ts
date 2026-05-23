import './env.js';
import { createApp } from './app.js';
import { initDb } from './db/index.js';
import { startHealthChecker } from './services/health.js';
import { applyAvailabilitySort } from './routes/fallback.js';

const PORT = process.env.PORT ?? 3001;

async function main() {
  initDb();

  // Re-apply availability-optimised fallback order on every startup.
  // This is idempotent and runs in a single transaction — safe to call always.
  const applied = applyAvailabilitySort();
  console.log(`[Fallback] Availability sort applied to ${applied} models`);

  const app = createApp();
  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    console.log(`Proxy endpoint: http://0.0.0.0:${PORT}/v1/chat/completions`);
    startHealthChecker();
  });
}

main().catch(console.error);
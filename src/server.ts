import { buildApp } from './app.js';
import { getPool, closePool } from './lib/db.js';
import { runMigrations } from './lib/migrate.js';

const HOST = process.env['HOST'] ?? '0.0.0.0';
const PORT = Number(process.env['PORT'] ?? 3000);

const app = buildApp();

// Run migrations before accepting traffic
try {
  await runMigrations(getPool());
} catch (err) {
  app.log.error({ err }, 'Migration failed – aborting startup');
  process.exit(1);
}

try {
  await app.listen({ host: HOST, port: PORT });
} catch (err) {
  app.log.error(err);
  await closePool();
  process.exit(1);
}

// Graceful shutdown
const shutdown = async (): Promise<void> => {
  app.log.info('Shutting down…');
  await app.close();
  await closePool();
  process.exit(0);
};

process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT',  () => { void shutdown(); });

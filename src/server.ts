import { buildApp } from './app.js';

const HOST = process.env['HOST'] ?? '0.0.0.0';
const PORT = Number(process.env['PORT'] ?? 3000);

const app = buildApp();

try {
  await app.listen({ host: HOST, port: PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

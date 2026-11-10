/**
 * OpenAPI export script.
 *
 * Bootstraps the Fastify application, calls app.swagger(),
 * and writes the complete OpenAPI specification to docs/openapi.json.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from '../app.js';

process.env['DATABASE_URL'] ??= 'postgres://sitetrack:sitetrack@localhost:5432/sitetrack';

export async function exportOpenApi(): Promise<void> {
  const app = buildApp();
  await app.ready();
  const spec = app.swagger();
  const outPath = join(process.cwd(), 'docs/openapi.json');
  writeFileSync(outPath, JSON.stringify(spec, null, 2), 'utf8');
  console.log(`OpenAPI specification exported to ${outPath}`);
  await app.close();
}

if (process.argv[1]?.endsWith('export-openapi.ts') || process.argv[1]?.endsWith('export-openapi.js')) {
  exportOpenApi()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Failed to export OpenAPI:', err);
      process.exit(1);
    });
}

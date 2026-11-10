/**
 * Tests for OpenAPI specification and export.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from '../../app.js';

describe('OpenAPI specification & export', () => {
  it('generates a valid OpenAPI v3 schema via Fastify Swagger', async () => {
    const app = buildApp();
    await app.ready();
    const swaggerSpec = app.swagger();

    expect(swaggerSpec).toBeDefined();
    expect(swaggerSpec.openapi).toMatch(/^3\./);
    expect(swaggerSpec.info.title).toBe('SiteTrack API');
    expect(swaggerSpec.paths).toBeDefined();

    // Key routes exist in OpenAPI specification
    expect(swaggerSpec.paths['/health']).toBeDefined();
    expect(swaggerSpec.paths['/auth/register']).toBeDefined();
    expect(swaggerSpec.paths['/auth/login']).toBeDefined();
    expect(swaggerSpec.paths['/projects']).toBeDefined();
    expect(swaggerSpec.paths['/materials']).toBeDefined();
    expect(swaggerSpec.paths['/company-store/stock']).toBeDefined();

    await app.close();
  });

  it('verifies exported docs/openapi.json exists and is valid', () => {
    const filePath = join(process.cwd(), 'docs/openapi.json');
    expect(existsSync(filePath)).toBe(true);

    const content = JSON.parse(readFileSync(filePath, 'utf8')) as {
      openapi: string;
      info: { title: string };
      paths: Record<string, unknown>;
    };

    expect(content.openapi).toMatch(/^3\./);
    expect(content.info.title).toBe('SiteTrack API');
    expect(Object.keys(content.paths).length).toBeGreaterThanOrEqual(30);
  });
});

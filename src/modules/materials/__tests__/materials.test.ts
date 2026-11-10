import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildApp } from '../../../app.js';
import { getPool, closePool } from '../../../lib/db.js';
import { runMigrations } from '../../../lib/migrate.js';
import {
  executePermissionMatrix,
  setupPermissionTestActors,
  type MatrixRow,
  type TestActors,
} from '../../../test/permissionHarness.js';
import { MaterialsRepo } from '../repo.js';

describe('Materials catalogue, trigram search, and company stock rows (real Postgres)', () => {
  const pool = getPool();
  const app = buildApp();
  const repo = new MaterialsRepo(pool);
  let actors: TestActors;

  beforeAll(async () => {
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE stock, materials, stores, project_members, projects, sessions, users RESTART IDENTITY CASCADE');
    await pool.query("UPDATE counters SET value = 0 WHERE name = 'project'");
    // Re-seed company store if missing after truncate
    await pool.query(`
      INSERT INTO stores (project_id, name)
      VALUES (NULL, 'Company Store')
      ON CONFLICT DO NOTHING
    `);
    actors = await setupPermissionTestActors();
  });

  afterAll(async () => {
    await closePool();
  });

  it('Store Manager creates material; automatically creates company stock row with quantity 0 and out_of_stock status (Rule 121 & 122)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/materials',
      headers: { authorization: `Bearer ${actors.managerToken}` },
      payload: {
        name: 'Portland Cement Type I',
        category: 'Cement & Concrete',
        unit: 'bags',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.material).toMatchObject({
      name: 'Portland Cement Type I',
      category: 'Cement & Concrete',
      unit: 'bags',
    });
    expect(typeof body.material.id).toBe('number');
    expect(typeof body.material.createdAt).toBe('string');

    // Rule 121: Company store stock row is created when a material is created
    const stockRow = await repo.getCompanyStockRow(body.material.id);
    expect(stockRow).not.toBeNull();
    expect(stockRow?.quantity).toBe('0.000');
    expect(stockRow?.reorder_point).toBe('0.000');
    // Rule 122: status is out_of_stock when quantity = 0
    expect(stockRow?.status).toBe('out_of_stock');
  });

  it('SuperAdmin can also create material (Decision 4)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/materials',
      headers: { authorization: `Bearer ${actors.superAdminToken}` },
      payload: {
        name: 'Structural Steel I-Beam 200mm',
        category: 'Steel',
        unit: 'meters',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().material.name).toBe('Structural Steel I-Beam 200mm');
  });

  it('rejects duplicate material name case-insensitively with 409 MATERIAL_EXISTS', async () => {
    // 1. Create first material
    await app.inject({
      method: 'POST',
      url: '/materials',
      headers: { authorization: `Bearer ${actors.managerToken}` },
      payload: {
        name: 'Gravel 20mm',
        category: 'Aggregates',
        unit: 'tonnes',
      },
    });

    // 2. Try creating duplicate with different casing
    const dupRes = await app.inject({
      method: 'POST',
      url: '/materials',
      headers: { authorization: `Bearer ${actors.managerToken}` },
      payload: {
        name: 'gravel 20mm',
        category: 'Aggregates',
        unit: 'tonnes',
      },
    });

    expect(dupRes.statusCode).toBe(409);
    expect(dupRes.json()).toMatchObject({
      error: { code: 'MATERIAL_EXISTS' },
    });
  });

  it('permission matrix: only managers/SuperAdmin can write catalogue; all authenticated can read (Decision 4)', async () => {
    // Non-managers get 403
    for (const token of [actors.nonMemberToken, actors.memberToken, actors.adminToken]) {
      const res = await app.inject({
        method: 'POST',
        url: '/materials',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: 'Unauthorized Material',
          category: 'Testing',
          unit: 'pcs',
        },
      });
      expect(res.statusCode).toBe(403);
    }

    // Manager gets 201
    const mgrRes = await app.inject({
      method: 'POST',
      url: '/materials',
      headers: { authorization: `Bearer ${actors.managerToken}` },
      payload: {
        name: 'Manager Created Material',
        category: 'Testing',
        unit: 'pcs',
      },
    });
    expect(mgrRes.statusCode).toBe(201);

    // SuperAdmin gets 201
    const saRes = await app.inject({
      method: 'POST',
      url: '/materials',
      headers: { authorization: `Bearer ${actors.superAdminToken}` },
      payload: {
        name: 'SuperAdmin Created Material',
        category: 'Testing',
        unit: 'pcs',
      },
    });
    expect(saRes.statusCode).toBe(201);

    // Test GET /materials across the whole table-driven matrix
    const matrix: MatrixRow[] = [
      {
        name: 'List materials (GET /materials)',
        method: 'GET',
        path: '/materials',
        expected: {
          nonMember: 200,
          member: 200,
          admin: 200,
          manager: 200,
          superAdmin: 200,
        },
      },
    ];

    await executePermissionMatrix(app, actors, matrix);
  });

  it('searches materials via trigram index and filters by category', async () => {
    // Seed materials
    const materialsToCreate = [
      { name: 'Reinforced Steel Rebar 12mm', category: 'Steel', unit: 'meters' },
      { name: 'Structural Steel I-Beam 200mm', category: 'Steel', unit: 'meters' },
      { name: 'Standard Red Clay Brick', category: 'Masonry', unit: 'pcs' },
      { name: 'Ready-Mix Concrete C25', category: 'Cement & Concrete', unit: 'm3' },
    ];

    for (const mat of materialsToCreate) {
      await app.inject({
        method: 'POST',
        url: '/materials',
        headers: { authorization: `Bearer ${actors.managerToken}` },
        payload: mat,
      });
    }

    // 1. Search by substring / trigram 'Steel'
    const searchRes = await app.inject({
      method: 'GET',
      url: '/materials?search=Steel',
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(searchRes.statusCode).toBe(200);
    const searchBody = searchRes.json<{
      materials: { name: string }[];
      total: number;
    }>();
    expect(searchBody.total).toBe(2);
    expect(searchBody.materials.map((m) => m.name)).toEqual([
      'Reinforced Steel Rebar 12mm',
      'Structural Steel I-Beam 200mm',
    ]);

    // 2. Search for 'rebar' case-insensitively
    const rebarRes = await app.inject({
      method: 'GET',
      url: '/materials?search=rebar',
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(rebarRes.statusCode).toBe(200);
    expect(rebarRes.json().total).toBe(1);
    expect(rebarRes.json().materials[0].name).toBe('Reinforced Steel Rebar 12mm');

    // 3. Filter by category
    const catRes = await app.inject({
      method: 'GET',
      url: '/materials?category=Masonry',
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(catRes.statusCode).toBe(200);
    expect(catRes.json().total).toBe(1);
    expect(catRes.json().materials[0].name).toBe('Standard Red Clay Brick');

    // 4. Combined filter and search
    const comboRes = await app.inject({
      method: 'GET',
      url: '/materials?category=Steel&search=Beam',
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(comboRes.statusCode).toBe(200);
    expect(comboRes.json().total).toBe(1);
    expect(comboRes.json().materials[0].name).toBe('Structural Steel I-Beam 200mm');
  });

  it('GET /materials/:id returns material details or 404', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/materials',
      headers: { authorization: `Bearer ${actors.managerToken}` },
      payload: {
        name: 'Plasterboard 12.5mm',
        category: 'Drywall',
        unit: 'sheets',
      },
    });
    const id = Number(createRes.json().material.id);

    // Found
    const getRes = await app.inject({
      method: 'GET',
      url: `/materials/${String(id)}`,
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().material.name).toBe('Plasterboard 12.5mm');

    // Not found
    const notFoundRes = await app.inject({
      method: 'GET',
      url: '/materials/99999999',
      headers: { authorization: `Bearer ${actors.memberToken}` },
    });
    expect(notFoundRes.statusCode).toBe(404);
    expect(notFoundRes.json()).toMatchObject({
      error: { code: 'MATERIAL_NOT_FOUND' },
    });
  });

  it('returns 400 VALIDATION on invalid input', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/materials',
      headers: { authorization: `Bearer ${actors.managerToken}` },
      payload: {
        name: '',
        category: 'Test',
        unit: '',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: { code: 'VALIDATION' },
    });
  });
});

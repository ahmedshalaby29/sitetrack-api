import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../app.js';
import { closePool, getPool } from '../../../lib/db.js';
import { runMigrations } from '../../../lib/migrate.js';
import {
  executePermissionMatrix,
  setupPermissionTestActors,
  type MatrixRow,
  type TestActors,
} from '../../../test/permissionHarness.js';
import type {
  CompanyStockListResponse,
  ProjectStoreResponse,
  SingleStockResponse,
} from '../schemas.js';

describe('Stock management, company stock screen, and project store screen (real Postgres)', () => {
  const pool = getPool();
  const app = buildApp();
  let actors: TestActors;

  beforeAll(async () => {
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE TABLE stock, materials, task_dependencies, tasks, stores, project_members, projects, sessions, users RESTART IDENTITY CASCADE',
    );
    await pool.query("UPDATE counters SET value = 0 WHERE name = 'project'");
    // Re-seed company store
    await pool.query(
      "INSERT INTO stores (project_id, name) VALUES (NULL, 'Company Store') ON CONFLICT DO NOTHING",
    );
    actors = await setupPermissionTestActors();
  });

  afterAll(async () => {
    await closePool();
  });

  async function createMaterial(name: string, category = 'Structural', unit = 'bags'): Promise<number> {
    const res = await app.inject({
      method: 'POST',
      url: '/materials',
      headers: { authorization: `Bearer ${actors.managerToken}` },
      payload: { name, category, unit },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ material: { id: number } }>().material.id;
  }

  describe('Add stock & Reorder point (Company store)', () => {
    it('credits company stock via add stock with positive NUMERIC(14,3) quantities', async () => {
      const matId = await createMaterial('Portland Cement 50kg');

      // 1. Initial stock is 0.000, status out_of_stock
      const initRes = await app.inject({
        method: 'GET',
        url: '/company-store/stock',
        headers: { authorization: `Bearer ${actors.managerToken}` },
      });
      expect(initRes.statusCode).toBe(200);
      const initBody = initRes.json<CompanyStockListResponse>();
      expect(initBody.stock[0]).toMatchObject({
        materialId: matId,
        quantity: '0.000',
        reorderPoint: '0.000',
        status: 'out_of_stock',
        inTransitToProjects: '0.000',
      });

      // 2. Add stock: +100.500
      const add1 = await app.inject({
        method: 'POST',
        url: '/company-store/stock/add',
        headers: { authorization: `Bearer ${actors.managerToken}` },
        payload: {
          materialId: matId,
          quantity: '100.500',
        },
      });
      expect(add1.statusCode).toBe(200);
      const add1Body = add1.json<SingleStockResponse>();
      expect(add1Body.stock).toMatchObject({
        materialId: matId,
        quantity: '100.500',
        status: 'available', // > reorder_point (0.000)
      });

      // 3. Add more stock: +49.500 => 150.000
      const add2 = await app.inject({
        method: 'POST',
        url: '/company-store/stock',
        headers: { authorization: `Bearer ${actors.managerToken}` },
        payload: {
          materialId: matId,
          quantity: 49.5, // numeric input
        },
      });
      expect(add2.statusCode).toBe(200);
      expect(add2.json<SingleStockResponse>().stock.quantity).toBe('150.000');
    });

    it('rejects invalid quantities (non-positive, invalid decimals, non-existent material)', async () => {
      const matId = await createMaterial('Steel Rebar 12mm');

      // Non-positive quantity (0)
      const resZero = await app.inject({
        method: 'POST',
        url: '/company-store/stock/add',
        headers: { authorization: `Bearer ${actors.managerToken}` },
        payload: { materialId: matId, quantity: '0' },
      });
      expect(resZero.statusCode).toBe(400);

      // Negative quantity
      const resNeg = await app.inject({
        method: 'POST',
        url: '/company-store/stock/add',
        headers: { authorization: `Bearer ${actors.managerToken}` },
        payload: { materialId: matId, quantity: '-10' },
      });
      expect(resNeg.statusCode).toBe(400);

      // Non-existent material -> 404
      const resNotFound = await app.inject({
        method: 'POST',
        url: '/company-store/stock/add',
        headers: { authorization: `Bearer ${actors.managerToken}` },
        payload: { materialId: 999999, quantity: '50.000' },
      });
      expect(resNotFound.statusCode).toBe(404);
      expect(resNotFound.json()).toMatchObject({
        error: { code: 'MATERIAL_NOT_FOUND' },
      });
    });

    it('updates reorder_point and dynamically recalculates stored status (out_of_stock, low_stock, available)', async () => {
      const matId = await createMaterial('Copper Pipe 15mm');

      // 1. Initial: quantity 0, reorder_point 0 -> out_of_stock
      const s0 = await app.inject({
        method: 'GET',
        url: '/company-store/stock',
        headers: { authorization: `Bearer ${actors.managerToken}` },
      });
      expect(s0.json<CompanyStockListResponse>().stock[0]?.status).toBe('out_of_stock');

      // 2. Add 50 quantity: 50 > 0 -> available
      await app.inject({
        method: 'POST',
        url: '/company-store/stock/add',
        headers: { authorization: `Bearer ${actors.managerToken}` },
        payload: { materialId: matId, quantity: '50.000' },
      });

      // 3. Set reorder_point to 100: quantity (50) <= reorder_point (100) -> low_stock!
      const patchLow = await app.inject({
        method: 'PATCH',
        url: `/company-store/stock/${String(matId)}/reorder-point`,
        headers: { authorization: `Bearer ${actors.managerToken}` },
        payload: { reorderPoint: '100.000' },
      });
      expect(patchLow.statusCode).toBe(200);
      expect(patchLow.json<SingleStockResponse>().stock).toMatchObject({
        reorderPoint: '100.000',
        status: 'low_stock',
      });

      // 4. Set reorder_point to 20: quantity (50) > reorder_point (20) -> available!
      const patchAvail = await app.inject({
        method: 'PATCH',
        url: `/company-store/stock/${String(matId)}`,
        headers: { authorization: `Bearer ${actors.managerToken}` },
        payload: { reorderPoint: 20 },
      });
      expect(patchAvail.statusCode).toBe(200);
      expect(patchAvail.json<SingleStockResponse>().stock).toMatchObject({
        reorderPoint: '20.000',
        status: 'available',
      });
    });
  });

  describe('Screen 10: Company stock screen (GET /company-store/stock)', () => {
    it('filters by category, status, search, and sorts by name, quantity, and status', async () => {
      const m1 = await createMaterial('Alpha Cement', 'Aggregates', 'bags');
      const m2 = await createMaterial('Beta Rebar', 'Metals', 'bars');
      const m3 = await createMaterial('Gamma Pipe', 'Metals', 'meters');

      // Add stock
      // m1: 0 (out_of_stock)
      // m2: 20 with reorder 50 (low_stock)
      // m3: 100 with reorder 10 (available)
      await app.inject({
        method: 'POST',
        url: '/company-store/stock/add',
        headers: { authorization: `Bearer ${actors.managerToken}` },
        payload: { materialId: m2, quantity: '20.000' },
      });
      await app.inject({
        method: 'PATCH',
        url: `/company-store/stock/${String(m2)}/reorder-point`,
        headers: { authorization: `Bearer ${actors.managerToken}` },
        payload: { reorderPoint: '50.000' },
      });

      await app.inject({
        method: 'POST',
        url: '/company-store/stock/add',
        headers: { authorization: `Bearer ${actors.managerToken}` },
        payload: { materialId: m3, quantity: '100.000' },
      });
      await app.inject({
        method: 'PATCH',
        url: `/company-store/stock/${String(m3)}/reorder-point`,
        headers: { authorization: `Bearer ${actors.managerToken}` },
        payload: { reorderPoint: '10.000' },
      });

      // Filter by category: Metals
      const catRes = await app.inject({
        method: 'GET',
        url: '/company-store/stock?category=Metals',
        headers: { authorization: `Bearer ${actors.managerToken}` },
      });
      expect(catRes.statusCode).toBe(200);
      const catBody = catRes.json<CompanyStockListResponse>();
      expect(catBody.total).toBe(2);
      expect(catBody.stock.map((s) => s.materialId)).toEqual([m2, m3]);

      // Filter by status: low_stock
      const statusRes = await app.inject({
        method: 'GET',
        url: '/company-store/stock?status=low_stock',
        headers: { authorization: `Bearer ${actors.managerToken}` },
      });
      expect(statusRes.statusCode).toBe(200);
      const statusBody = statusRes.json<CompanyStockListResponse>();
      expect(statusBody.total).toBe(1);
      expect(statusBody.stock[0]?.materialId).toBe(m2);

      // Search by name
      const searchRes = await app.inject({
        method: 'GET',
        url: '/company-store/stock?search=cement',
        headers: { authorization: `Bearer ${actors.managerToken}` },
      });
      expect(searchRes.statusCode).toBe(200);
      expect(searchRes.json<CompanyStockListResponse>().stock[0]?.materialId).toBe(m1);

      // Sort by quantity desc
      const sortQtyDesc = await app.inject({
        method: 'GET',
        url: '/company-store/stock?sort=quantity&order=desc',
        headers: { authorization: `Bearer ${actors.managerToken}` },
      });
      expect(sortQtyDesc.statusCode).toBe(200);
      const qtyList = sortQtyDesc.json<CompanyStockListResponse>().stock.map((s) => s.materialId);
      expect(qtyList).toEqual([m3, m2, m1]);
    });
  });

  describe('Screen 7: Project store screen (GET /projects/:projectId/store)', () => {
    it('returns only materials with a stock row in that project store', async () => {
      const m1 = await createMaterial('Project Concrete', 'Structural', 'm3');
      const _m2 = await createMaterial('Unused Lumber', 'Timber', 'pcs');

      // Initially project store has no stock rows
      const emptyStore = await app.inject({
        method: 'GET',
        url: `/projects/${actors.formattedProjectId}/store`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });
      expect(emptyStore.statusCode).toBe(200);
      expect(emptyStore.json<ProjectStoreResponse>()).toEqual({
        stock: [],
        total: 0,
      });

      // Insert a stock row directly for project store (simulating received delivery)
      const storeRes = await pool.query<{ id: string | number }>(
        'SELECT id FROM stores WHERE project_id = $1',
        [actors.projectId],
      );
      const projStoreId = storeRes.rows[0]?.id;
      expect(projStoreId).toBeDefined();

      const deliveryDate = new Date('2026-11-08T10:00:00Z');
      await pool.query(
        `INSERT INTO stock (store_id, material_id, quantity, reorder_point, last_delivery_at)
         VALUES ($1, $2, 45.000, 0, $3)`,
        [projStoreId, m1, deliveryDate],
      );

      // Now project store shows only m1
      const projStoreRes = await app.inject({
        method: 'GET',
        url: `/projects/${actors.formattedProjectId}/store`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });
      expect(projStoreRes.statusCode).toBe(200);
      const body = projStoreRes.json<ProjectStoreResponse>();
      expect(body.total).toBe(1);
      expect(body.stock[0]).toMatchObject({
        materialId: m1,
        name: 'Project Concrete',
        category: 'Structural',
        unit: 'm3',
        quantity: '45.000',
        lastDeliveryAt: deliveryDate.toISOString(),
      });
    });

    it('filters project store by category and searches by name', async () => {
      const storeRes = await pool.query<{ id: string | number }>(
        'SELECT id FROM stores WHERE project_id = $1',
        [actors.projectId],
      );
      const projStoreId = storeRes.rows[0]?.id;

      const m1 = await createMaterial('Steel Mesh Heavy', 'Reinforcement', 'sheets');
      const m2 = await createMaterial('Steel Wire Thin', 'Reinforcement', 'rolls');
      const m3 = await createMaterial('Clay Bricks Standard', 'Masonry', 'pcs');

      await pool.query(
        `INSERT INTO stock (store_id, material_id, quantity, reorder_point)
         VALUES ($1, $2, 10.000, 0), ($1, $3, 20.000, 0), ($1, $4, 500.000, 0)`,
        [projStoreId, m1, m2, m3],
      );

      // Search "mesh"
      const searchRes = await app.inject({
        method: 'GET',
        url: `/projects/${actors.formattedProjectId}/store?search=mesh`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });
      expect(searchRes.statusCode).toBe(200);
      const searchBody = searchRes.json<ProjectStoreResponse>();
      expect(searchBody.total).toBe(1);
      expect(searchBody.stock[0]?.materialId).toBe(m1);

      // Filter category "Reinforcement"
      const catRes = await app.inject({
        method: 'GET',
        url: `/projects/${actors.formattedProjectId}/store?category=Reinforcement`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });
      expect(catRes.statusCode).toBe(200);
      expect(catRes.json<ProjectStoreResponse>().total).toBe(2);
    });
  });

  describe('Permission Matrix: stock and store routes', () => {
    it('enforces RBAC matrix: company store restricted to managers/SuperAdmin (403), project store to members/SuperAdmin (404 for non-members)', async () => {
      const matId = await createMaterial('Matrix Material');

      const matrix: MatrixRow[] = [
        {
          name: 'Company store stock list (GET /company-store/stock)',
          method: 'GET',
          path: '/company-store/stock',
          expected: {
            nonMember: 403, // user role -> 403
            member: 403,    // user role -> 403
            admin: 403,     // user role -> 403
            manager: 200,   // store_manager -> 200
            superAdmin: 200,// super_admin -> 200
          },
        },
        {
          name: 'Add company stock (POST /company-store/stock/add)',
          method: 'POST',
          path: '/company-store/stock/add',
          payload: { materialId: matId, quantity: '10.000' },
          expected: {
            nonMember: 403,
            member: 403,
            admin: 403,
            manager: 200,
            superAdmin: 200,
          },
        },
        {
          name: 'Project store stock list (GET /projects/:projectId/store)',
          method: 'GET',
          path: '/projects/:projectId/store',
          expected: {
            nonMember: 404, // rule 2: non-members get 404, never 403
            member: 200,
            admin: 200,
            manager: 404,   // manager is non-member of project -> 404
            superAdmin: 200,// super_admin passes guard
          },
        },
      ];

      await executePermissionMatrix(app, actors, matrix);
    });
  });
});

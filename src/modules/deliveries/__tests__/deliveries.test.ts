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
import type { CompanyStockListResponse, ProjectStoreResponse } from '../../stock/schemas.js';
import type { SingleDeliveryResponse } from '../schemas.js';

describe('Deliveries: initiate, record, reject, cancel, atomicity, and concurrency (real Postgres)', () => {
  const pool = getPool();
  const app = buildApp();
  let actors: TestActors;

  beforeAll(async () => {
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE TABLE delivery_lines, deliveries, stock, materials, task_dependencies, tasks, stores, project_members, projects, sessions, users RESTART IDENTITY CASCADE',
    );
    await pool.query("UPDATE counters SET value = 0 WHERE name = 'project'");
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

  async function addCompanyStock(materialId: number, quantity: string | number): Promise<void> {
    const res = await app.inject({
      method: 'POST',
      url: '/company-store/stock/add',
      headers: { authorization: `Bearer ${actors.managerToken}` },
      payload: { materialId, quantity },
    });
    expect(res.statusCode).toBe(200);
  }

  describe('Initiate delivery', () => {
    it('initiates outward delivery (to_project) and race-safe debits company stock immediately', async () => {
      const matId = await createMaterial('Portland Cement 50kg');
      await addCompanyStock(matId, '100.000');

      const initRes = await app.inject({
        method: 'POST',
        url: '/company-store/deliveries',
        headers: { authorization: `Bearer ${actors.managerToken}` },
        payload: {
          projectId: actors.formattedProjectId,
          lines: [{ materialId: matId, quantity: '35.500' }],
        },
      });

      expect(initRes.statusCode).toBe(201);
      const body = initRes.json<SingleDeliveryResponse>();
      expect(body.delivery).toMatchObject({
        projectId: actors.projectId,
        formattedProjectId: actors.formattedProjectId,
        direction: 'to_project',
        status: 'in_transit',
        receiverUserId: null,
        receivedAt: null,
      });
      expect(body.delivery.lines[0]).toMatchObject({
        materialId: matId,
        materialName: 'Portland Cement 50kg',
        quantity: '35.500',
      });

      // Verify company stock debited from 100.000 to 64.500
      const stockRes = await app.inject({
        method: 'GET',
        url: '/company-store/stock',
        headers: { authorization: `Bearer ${actors.managerToken}` },
      });
      const stockBody = stockRes.json<CompanyStockListResponse>();
      expect(stockBody.stock[0]?.quantity).toBe('64.500');
      // Rule 134: inTransitToProjects should now reflect 35.500!
      expect(stockBody.stock[0]?.inTransitToProjects).toBe('35.500');
    });

    it('rejects duplicate materials in delivery lines with 422', async () => {
      const matId = await createMaterial('Rebar 10mm');
      await addCompanyStock(matId, '50.000');

      const res = await app.inject({
        method: 'POST',
        url: '/company-store/deliveries',
        headers: { authorization: `Bearer ${actors.managerToken}` },
        payload: {
          projectId: actors.formattedProjectId,
          lines: [
            { materialId: matId, quantity: '10.000' },
            { materialId: matId, quantity: '5.000' },
          ],
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('DUPLICATE_DELIVERY_MATERIAL');
    });

    it('rejects initiate delivery when stock is insufficient with 409', async () => {
      const matId = await createMaterial('Gravel 20mm');
      await addCompanyStock(matId, '10.000');

      const res = await app.inject({
        method: 'POST',
        url: '/company-store/deliveries',
        headers: { authorization: `Bearer ${actors.managerToken}` },
        payload: {
          projectId: actors.formattedProjectId,
          lines: [{ materialId: matId, quantity: '15.000' }],
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('INSUFFICIENT_STOCK');
    });
  });

  describe('Record delivery (receive)', () => {
    it('records to_project delivery: receiver credits project store and sets last_delivery_at', async () => {
      const matId = await createMaterial('ReadyMix Concrete');
      await addCompanyStock(matId, '20.000');

      const delivRes = await app.inject({
        method: 'POST',
        url: '/company-store/deliveries',
        headers: { authorization: `Bearer ${actors.managerToken}` },
        payload: {
          projectId: actors.formattedProjectId,
          lines: [{ materialId: matId, quantity: '20.000' }],
        },
      });
      const deliveryId = delivRes.json<SingleDeliveryResponse>().delivery.id;

      // Project member records delivery receipt
      const recordRes = await app.inject({
        method: 'POST',
        url: `/projects/${actors.formattedProjectId}/deliveries/${String(deliveryId)}/record`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });

      expect(recordRes.statusCode).toBe(200);
      const recordBody = recordRes.json<SingleDeliveryResponse>();
      expect(recordBody.delivery.status).toBe('delivered');
      expect(recordBody.delivery.receivedAt).toBeDefined();

      // Check project store shows material with 20.000 quantity and valid lastDeliveryAt
      const projStoreRes = await app.inject({
        method: 'GET',
        url: `/projects/${actors.formattedProjectId}/store`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });
      const projStoreBody = projStoreRes.json<ProjectStoreResponse>();
      expect(projStoreBody.total).toBe(1);
      expect(projStoreBody.stock[0]).toMatchObject({
        materialId: matId,
        quantity: '20.000',
      });
      expect(projStoreBody.stock[0]?.lastDeliveryAt).not.toBeNull();

      // Company inTransit drops back to 0.000
      const stockRes = await app.inject({
        method: 'GET',
        url: '/company-store/stock',
        headers: { authorization: `Bearer ${actors.managerToken}` },
      });
      expect(stockRes.json<CompanyStockListResponse>().stock[0]?.inTransitToProjects).toBe('0.000');

      // Attempting to record again yields 409 DELIVERY_NOT_IN_TRANSIT
      const duplicateRecord = await app.inject({
        method: 'POST',
        url: `/projects/${actors.formattedProjectId}/deliveries/${String(deliveryId)}/record`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });
      expect(duplicateRecord.statusCode).toBe(409);
      expect(duplicateRecord.json<{ error: { code: string } }>().error.code).toBe(
        'DELIVERY_NOT_IN_TRANSIT',
      );
    });

    it('records to_company return delivery: company store manager credits company stock', async () => {
      const matId = await createMaterial('Surplus Steel');
      // Set project store initial stock directly
      const storeRes = await pool.query<{ id: string | number }>(
        'SELECT id FROM stores WHERE project_id = $1',
        [actors.projectId],
      );
      const projStoreId = storeRes.rows[0]?.id;
      await pool.query(
        'INSERT INTO stock (store_id, material_id, quantity, reorder_point) VALUES ($1, $2, 50.000, 0)',
        [projStoreId, matId],
      );

      // Project member initiates return delivery
      const returnRes = await app.inject({
        method: 'POST',
        url: `/projects/${actors.formattedProjectId}/deliveries`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
        payload: {
          direction: 'to_company',
          lines: [{ materialId: matId, quantity: '30.000' }],
        },
      });
      expect(returnRes.statusCode).toBe(201);
      const deliveryId = returnRes.json<SingleDeliveryResponse>().delivery.id;

      // Project stock debited to 20.000
      const storeAfterDebit = await app.inject({
        method: 'GET',
        url: `/projects/${actors.formattedProjectId}/store`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });
      expect(storeAfterDebit.json<ProjectStoreResponse>().stock[0]?.quantity).toBe('20.000');

      // Company store manager records receipt
      const recordRes = await app.inject({
        method: 'POST',
        url: `/company-store/deliveries/${String(deliveryId)}/record`,
        headers: { authorization: `Bearer ${actors.managerToken}` },
      });
      expect(recordRes.statusCode).toBe(200);

      // Company stock credited with 30.000
      const compStock = await app.inject({
        method: 'GET',
        url: '/company-store/stock',
        headers: { authorization: `Bearer ${actors.managerToken}` },
      });
      expect(compStock.json<CompanyStockListResponse>().stock[0]?.quantity).toBe('30.000');
    });
  });

  describe('Reject and Cancel deliveries', () => {
    it('rejects delivery: receiver rejects in_transit delivery and credits sender stock back', async () => {
      const matId = await createMaterial('Bricks Type B');
      await addCompanyStock(matId, '100.000');

      const delivRes = await app.inject({
        method: 'POST',
        url: '/company-store/deliveries',
        headers: { authorization: `Bearer ${actors.managerToken}` },
        payload: {
          projectId: actors.formattedProjectId,
          lines: [{ materialId: matId, quantity: '40.000' }],
        },
      });
      const deliveryId = delivRes.json<SingleDeliveryResponse>().delivery.id;

      // Project receiver rejects delivery
      const rejectRes = await app.inject({
        method: 'POST',
        url: `/projects/${actors.formattedProjectId}/deliveries/${String(deliveryId)}/reject`,
        headers: { authorization: `Bearer ${actors.memberToken}` },
      });
      expect(rejectRes.statusCode).toBe(200);
      expect(rejectRes.json<SingleDeliveryResponse>().delivery.status).toBe('rejected');

      // Sender company stock is refunded back to 100.000
      const compStock = await app.inject({
        method: 'GET',
        url: '/company-store/stock',
        headers: { authorization: `Bearer ${actors.managerToken}` },
      });
      expect(compStock.json<CompanyStockListResponse>().stock[0]?.quantity).toBe('100.000');
      expect(compStock.json<CompanyStockListResponse>().stock[0]?.inTransitToProjects).toBe('0.000');
    });

    it('cancels delivery: sender cancels in_transit delivery and credits sender stock back', async () => {
      const matId = await createMaterial('Timber Beams');
      await addCompanyStock(matId, '50.000');

      const delivRes = await app.inject({
        method: 'POST',
        url: '/company-store/deliveries',
        headers: { authorization: `Bearer ${actors.managerToken}` },
        payload: {
          projectId: actors.formattedProjectId,
          lines: [{ materialId: matId, quantity: '25.000' }],
        },
      });
      const deliveryId = delivRes.json<SingleDeliveryResponse>().delivery.id;

      // Company sender cancels delivery
      const cancelRes = await app.inject({
        method: 'POST',
        url: `/company-store/deliveries/${String(deliveryId)}/cancel`,
        headers: { authorization: `Bearer ${actors.managerToken}` },
      });
      expect(cancelRes.statusCode).toBe(200);
      expect(cancelRes.json<SingleDeliveryResponse>().delivery.status).toBe('cancelled');

      // Refunded back to 50.000
      const compStock = await app.inject({
        method: 'GET',
        url: '/company-store/stock',
        headers: { authorization: `Bearer ${actors.managerToken}` },
      });
      expect(compStock.json<CompanyStockListResponse>().stock[0]?.quantity).toBe('50.000');
    });
  });

  describe('Atomicity', () => {
    it('rolls back completely when one item in a multi-item delivery fails stock debit', async () => {
      const matA = await createMaterial('Material A Sufficient');
      const matB = await createMaterial('Material B Insufficient');

      await addCompanyStock(matA, '100.000');
      await addCompanyStock(matB, '5.000');

      const res = await app.inject({
        method: 'POST',
        url: '/company-store/deliveries',
        headers: { authorization: `Bearer ${actors.managerToken}` },
        payload: {
          projectId: actors.formattedProjectId,
          lines: [
            { materialId: matA, quantity: '50.000' }, // Would succeed
            { materialId: matB, quantity: '20.000' }, // Exceeds available stock (5.000)
          ],
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('INSUFFICIENT_STOCK');

      // Ensure Material A was NOT decremented (transaction rolled back!)
      const compStock = await app.inject({
        method: 'GET',
        url: '/company-store/stock',
        headers: { authorization: `Bearer ${actors.managerToken}` },
      });
      const stockList = compStock.json<CompanyStockListResponse>().stock;
      const stockA = stockList.find((s) => s.materialId === matA);
      const stockB = stockList.find((s) => s.materialId === matB);
      expect(stockA?.quantity).toBe('100.000');
      expect(stockB?.quantity).toBe('5.000');
    });
  });

  describe('Concurrency (Rule 165, 166)', () => {
    it('parallel deliveries never drive stock negative', async () => {
      const matId = await createMaterial('High Demand Copper');
      // Start with exactly 100.000
      await addCompanyStock(matId, '100.000');

      // 10 concurrent requests of 15.000 each = 150.000 requested
      // Exactly 6 can succeed (6 * 15 = 90.000), leaving 10.000
      // 4 must fail with 409 INSUFFICIENT_STOCK
      const attempts = Array.from({ length: 10 }, () =>
        app.inject({
          method: 'POST',
          url: '/company-store/deliveries',
          headers: { authorization: `Bearer ${actors.managerToken}` },
          payload: {
            projectId: actors.formattedProjectId,
            lines: [{ materialId: matId, quantity: '15.000' }],
          },
        }),
      );

      const results = await Promise.all(attempts);
      const succeeded = results.filter((r) => r.statusCode === 201);
      const failed = results.filter((r) => r.statusCode === 409);

      expect(succeeded.length).toBe(6);
      expect(failed.length).toBe(4);

      // Verify stock in database is exactly 10.000 and never negative
      const stockRes = await pool.query<{ quantity: string }>(
        'SELECT quantity FROM stock WHERE material_id = $1 AND store_id IS NOT NULL AND store_id = (SELECT id FROM stores WHERE project_id IS NULL)',
        [matId],
      );
      expect(Number(stockRes.rows[0]?.quantity)).toBe(10);
    });

    it('double record succeeds exactly once', async () => {
      const matId = await createMaterial('Precast Panels');
      await addCompanyStock(matId, '10.000');

      const delivRes = await app.inject({
        method: 'POST',
        url: '/company-store/deliveries',
        headers: { authorization: `Bearer ${actors.managerToken}` },
        payload: {
          projectId: actors.formattedProjectId,
          lines: [{ materialId: matId, quantity: '10.000' }],
        },
      });
      const deliveryId = delivRes.json<SingleDeliveryResponse>().delivery.id;

      // Two concurrent record calls
      const [res1, res2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/projects/${actors.formattedProjectId}/deliveries/${String(deliveryId)}/record`,
          headers: { authorization: `Bearer ${actors.memberToken}` },
        }),
        app.inject({
          method: 'POST',
          url: `/projects/${actors.formattedProjectId}/deliveries/${String(deliveryId)}/record`,
          headers: { authorization: `Bearer ${actors.adminToken}` },
        }),
      ]);

      const statusCodes = [res1.statusCode, res2.statusCode].sort();
      expect(statusCodes).toEqual([200, 409]);
    });

    it('record vs cancel: exactly one winner', async () => {
      const matId = await createMaterial('Roofing Tiles');
      await addCompanyStock(matId, '20.000');

      const delivRes = await app.inject({
        method: 'POST',
        url: '/company-store/deliveries',
        headers: { authorization: `Bearer ${actors.managerToken}` },
        payload: {
          projectId: actors.formattedProjectId,
          lines: [{ materialId: matId, quantity: '20.000' }],
        },
      });
      const deliveryId = delivRes.json<SingleDeliveryResponse>().delivery.id;

      // Concurrent record by receiver vs cancel by sender
      const [recordRes, cancelRes] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/projects/${actors.formattedProjectId}/deliveries/${String(deliveryId)}/record`,
          headers: { authorization: `Bearer ${actors.memberToken}` },
        }),
        app.inject({
          method: 'POST',
          url: `/company-store/deliveries/${String(deliveryId)}/cancel`,
          headers: { authorization: `Bearer ${actors.managerToken}` },
        }),
      ]);

      const statusCodes = [recordRes.statusCode, cancelRes.statusCode].sort();
      expect(statusCodes).toEqual([200, 409]);
    });
  });

  describe('Permission Matrix: delivery routes', () => {
    it('enforces non-member 404 for project delivery subroutes, 403 for company store delivery subroutes', async () => {
      const matId = await createMaterial('Matrix Sand');
      await addCompanyStock(matId, '100.000');

      const delivRes = await app.inject({
        method: 'POST',
        url: '/company-store/deliveries',
        headers: { authorization: `Bearer ${actors.managerToken}` },
        payload: {
          projectId: actors.formattedProjectId,
          lines: [{ materialId: matId, quantity: '10.000' }],
        },
      });
      const deliveryId = delivRes.json<SingleDeliveryResponse>().delivery.id;

      const matrixRows: MatrixRow[] = [
        // Company store delivery endpoints restricted to managers & super admin (non-managers get 403)
        {
          path: `/company-store/deliveries/${String(deliveryId)}`,
          method: 'GET',
          expected: {
            nonMember: 403,
            member: 403,
            admin: 403,
            manager: 200,
            superAdmin: 200,
          },
        },
        // Project delivery sub-resources: non-members get 404 (Rule 2)
        {
          path: `/projects/:projectId/deliveries/${String(deliveryId)}`,
          method: 'GET',
          expected: {
            nonMember: 404,
            member: 200,
            admin: 200,
            manager: 404,
            superAdmin: 200,
          },
        },
      ];

      await executePermissionMatrix(app, actors, matrixRows);
    });
  });
});

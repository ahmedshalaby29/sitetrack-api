import type { Pool } from 'pg';
import { getPool } from '../../lib/db.js';
import { AppError, ErrorCode } from '../../lib/errors.js';
import type {
  CompanyStockItem,
  ListCompanyStockQuery,
  ListProjectStoreQuery,
  ProjectStockItem,
  StockStatus,
} from './schemas.js';

export interface StockDbRow {
  storeId: string | number;
  materialId: string | number;
  quantity: string;
  reorderPoint: string;
  status: StockStatus;
  lastDeliveryAt: Date | null;
  updatedAt: Date;
}

export class StockRepo {
  constructor(private readonly pool: Pool = getPool()) {}

  /**
   * Returns the company store ID (where project_id IS NULL).
   */
  async getCompanyStoreId(): Promise<number> {
    const res = await this.pool.query<{ id: string | number }>(
      'SELECT id FROM stores WHERE project_id IS NULL LIMIT 1',
    );
    const row = res.rows[0];
    if (!row) {
      throw new AppError(500, ErrorCode.INTERNAL, 'Company store not configured');
    }
    return Number(row.id);
  }

  /**
   * Returns the project store ID (where project_id = $1).
   */
  async getProjectStoreId(projectId: number): Promise<number | null> {
    const res = await this.pool.query<{ id: string | number }>(
      'SELECT id FROM stores WHERE project_id = $1 LIMIT 1',
      [projectId],
    );
    const row = res.rows[0];
    return row ? Number(row.id) : null;
  }

  /**
   * Add stock (managers only): the only way new material enters.
   * Credit via INSERT ... ON CONFLICT DO UPDATE. Positive quantity only (rule 123).
   */
  async addStock(
    materialId: number,
    quantity: string,
  ): Promise<{
    storeId: number;
    materialId: number;
    quantity: string;
    reorderPoint: string;
    status: StockStatus;
    lastDeliveryAt: string | null;
    updatedAt: string;
  }> {
    // 1. Verify material exists
    const matRes = await this.pool.query('SELECT id FROM materials WHERE id = $1', [
      materialId,
    ]);
    if (matRes.rowCount === 0) {
      throw new AppError(404, ErrorCode.MATERIAL_NOT_FOUND, 'Material not found');
    }

    const companyStoreId = await this.getCompanyStoreId();

    // 2. Credit via INSERT ... ON CONFLICT DO UPDATE
    const res = await this.pool.query<StockDbRow>(
      `INSERT INTO stock (store_id, material_id, quantity, reorder_point, updated_at)
       VALUES ($1, $2, $3::numeric(14,3), 0.000, now())
       ON CONFLICT (store_id, material_id)
       DO UPDATE SET
         quantity = stock.quantity + EXCLUDED.quantity,
         updated_at = now()
       RETURNING
         store_id AS "storeId",
         material_id AS "materialId",
         to_char(quantity, 'FM99999999999990.000') AS quantity,
         to_char(reorder_point, 'FM99999999999990.000') AS "reorderPoint",
         status,
         last_delivery_at AS "lastDeliveryAt",
         updated_at AS "updatedAt"`,
      [companyStoreId, materialId, quantity],
    );

    const row = res.rows[0];
    if (!row) {
      throw new AppError(500, ErrorCode.INTERNAL, 'Failed to update stock');
    }

    return {
      storeId: Number(row.storeId),
      materialId: Number(row.materialId),
      quantity: row.quantity,
      reorderPoint: row.reorderPoint,
      status: row.status,
      lastDeliveryAt: row.lastDeliveryAt ? row.lastDeliveryAt.toISOString() : null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Set reorder point for a material in the company store.
   */
  async setReorderPoint(
    materialId: number,
    reorderPoint: string,
  ): Promise<{
    storeId: number;
    materialId: number;
    quantity: string;
    reorderPoint: string;
    status: StockStatus;
    lastDeliveryAt: string | null;
    updatedAt: string;
  }> {
    // 1. Verify material exists
    const matRes = await this.pool.query('SELECT id FROM materials WHERE id = $1', [
      materialId,
    ]);
    if (matRes.rowCount === 0) {
      throw new AppError(404, ErrorCode.MATERIAL_NOT_FOUND, 'Material not found');
    }

    const companyStoreId = await this.getCompanyStoreId();

    // 2. Update reorder point
    const res = await this.pool.query<StockDbRow>(
      `INSERT INTO stock (store_id, material_id, quantity, reorder_point, updated_at)
       VALUES ($1, $2, 0.000, $3::numeric(14,3), now())
       ON CONFLICT (store_id, material_id)
       DO UPDATE SET
         reorder_point = EXCLUDED.reorder_point,
         updated_at = now()
       RETURNING
         store_id AS "storeId",
         material_id AS "materialId",
         to_char(quantity, 'FM99999999999990.000') AS quantity,
         to_char(reorder_point, 'FM99999999999990.000') AS "reorderPoint",
         status,
         last_delivery_at AS "lastDeliveryAt",
         updated_at AS "updatedAt"`,
      [companyStoreId, materialId, reorderPoint],
    );

    const row = res.rows[0];
    if (!row) {
      throw new AppError(500, ErrorCode.INTERNAL, 'Failed to update reorder point');
    }

    return {
      storeId: Number(row.storeId),
      materialId: Number(row.materialId),
      quantity: row.quantity,
      reorderPoint: row.reorderPoint,
      status: row.status,
      lastDeliveryAt: row.lastDeliveryAt ? row.lastDeliveryAt.toISOString() : null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Screen 10: Company stock
   * List materials in the company store with quantity, in-transit-to-projects,
   * reorder point, and status. Filter by status and category, search by name,
   * sort by name / quantity / status.
   */
  async listCompanyStock(
    query: ListCompanyStockQuery,
  ): Promise<{ stock: CompanyStockItem[]; total: number }> {
    const companyStoreId = await this.getCompanyStoreId();

    const conditions: string[] = ['s.store_id = $1'];
    const filterParams: (string | number)[] = [companyStoreId];
    let paramIndex = 2;

    if (query.category) {
      conditions.push(`m.category = $${String(paramIndex++)}`);
      filterParams.push(query.category);
    }

    if (query.status) {
      conditions.push(`s.status = $${String(paramIndex++)}`);
      filterParams.push(query.status);
    }

    if (query.search && query.search.length > 0) {
      conditions.push(`m.name ILIKE '%' || $${String(paramIndex++)} || '%'`);
      filterParams.push(query.search);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Total count
    const countSql = `
      SELECT count(*)::int AS count
      FROM stock s
      JOIN materials m ON m.id = s.material_id
      ${whereClause}
    `;
    const countRes = await this.pool.query<{ count: number }>(countSql, filterParams);
    const total = countRes.rows[0]?.count ?? 0;

    // Sorting
    let sortColumn: string;
    switch (query.sort) {
      case 'quantity':
        sortColumn = 's.quantity';
        break;
      case 'status':
        sortColumn = 's.status';
        break;
      case 'name':
      default:
        sortColumn = 'm.name';
        break;
    }

    const sortOrder = query.order === 'desc' ? 'DESC' : 'ASC';
    const orderBy = `${sortColumn} ${sortOrder}, m.id ASC`;

    const limitIdx = paramIndex++;
    const offsetIdx = paramIndex++;
    const dataParams = [...filterParams, query.limit, query.offset];

    // Check if deliveries table exists (created in Commit 15)
    const delivTableCheck = await this.pool.query<{ exists: string | null }>(
      "SELECT to_regclass('public.deliveries') AS exists",
    );
    const deliveriesExist = Boolean(delivTableCheck.rows[0]?.exists);

    const inTransitSubquery = deliveriesExist
      ? `COALESCE((
           SELECT to_char(COALESCE(sum(dl.quantity), 0), 'FM99999999999990.000')
           FROM deliveries d
           JOIN delivery_lines dl ON dl.delivery_id = d.id
           WHERE d.direction = 'to_project' AND d.status = 'in_transit' AND dl.material_id = m.id
         ), '0.000')`
      : `'0.000'`;

    const dataSql = `
      SELECT
        m.id AS "materialId",
        m.name,
        m.category,
        m.unit,
        to_char(s.quantity, 'FM99999999999990.000') AS quantity,
        to_char(s.reorder_point, 'FM99999999999990.000') AS "reorderPoint",
        s.status,
        ${inTransitSubquery} AS "inTransitToProjects",
        s.last_delivery_at AS "lastDeliveryAt",
        s.updated_at AS "updatedAt"
      FROM stock s
      JOIN materials m ON m.id = s.material_id
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT $${String(limitIdx)} OFFSET $${String(offsetIdx)}
    `;

    const dataRes = await this.pool.query<{
      materialId: string | number;
      name: string;
      category: string;
      unit: string;
      quantity: string;
      reorderPoint: string;
      status: StockStatus;
      inTransitToProjects: string;
      lastDeliveryAt: Date | null;
      updatedAt: Date;
    }>(dataSql, dataParams);

    const stock: CompanyStockItem[] = dataRes.rows.map((r) => ({
      materialId: Number(r.materialId),
      name: r.name,
      category: r.category,
      unit: r.unit,
      quantity: r.quantity,
      reorderPoint: r.reorderPoint,
      status: r.status,
      inTransitToProjects: r.inTransitToProjects,
      lastDeliveryAt: r.lastDeliveryAt ? r.lastDeliveryAt.toISOString() : null,
      updatedAt: r.updatedAt.toISOString(),
    }));

    return { stock, total };
  }

  /**
   * Screen 7: Project store
   * List materials in the project store with quantity, unit, last delivery date.
   * Search, category filter, sort by name / quantity / last delivery.
   * Only shows materials with a stock row there (rule 121).
   */
  async listProjectStore(
    projectId: number,
    query: ListProjectStoreQuery,
  ): Promise<{ stock: ProjectStockItem[]; total: number }> {
    const projectStoreId = await this.getProjectStoreId(projectId);
    if (!projectStoreId) {
      return { stock: [], total: 0 };
    }

    const conditions: string[] = ['s.store_id = $1'];
    const filterParams: (string | number)[] = [projectStoreId];
    let paramIndex = 2;

    if (query.category) {
      conditions.push(`m.category = $${String(paramIndex++)}`);
      filterParams.push(query.category);
    }

    if (query.search && query.search.length > 0) {
      conditions.push(`m.name ILIKE '%' || $${String(paramIndex++)} || '%'`);
      filterParams.push(query.search);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Total count
    const countSql = `
      SELECT count(*)::int AS count
      FROM stock s
      JOIN materials m ON m.id = s.material_id
      ${whereClause}
    `;
    const countRes = await this.pool.query<{ count: number }>(countSql, filterParams);
    const total = countRes.rows[0]?.count ?? 0;

    // Sorting
    let sortColumn: string;
    switch (query.sort) {
      case 'quantity':
        sortColumn = 's.quantity';
        break;
      case 'last_delivery':
        sortColumn = 's.last_delivery_at';
        break;
      case 'name':
      default:
        sortColumn = 'm.name';
        break;
    }

    const sortOrder = query.order === 'desc' ? 'DESC' : 'ASC';
    const orderBy =
      query.sort === 'last_delivery'
        ? `${sortColumn} ${sortOrder} NULLS LAST, m.id ASC`
        : `${sortColumn} ${sortOrder}, m.id ASC`;

    const limitIdx = paramIndex++;
    const offsetIdx = paramIndex++;
    const dataParams = [...filterParams, query.limit, query.offset];

    const dataSql = `
      SELECT
        m.id AS "materialId",
        m.name,
        m.category,
        m.unit,
        to_char(s.quantity, 'FM99999999999990.000') AS quantity,
        s.last_delivery_at AS "lastDeliveryAt"
      FROM stock s
      JOIN materials m ON m.id = s.material_id
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT $${String(limitIdx)} OFFSET $${String(offsetIdx)}
    `;

    const dataRes = await this.pool.query<{
      materialId: string | number;
      name: string;
      category: string;
      unit: string;
      quantity: string;
      lastDeliveryAt: Date | null;
    }>(dataSql, dataParams);

    const stock: ProjectStockItem[] = dataRes.rows.map((r) => ({
      materialId: Number(r.materialId),
      name: r.name,
      category: r.category,
      unit: r.unit,
      quantity: r.quantity,
      lastDeliveryAt: r.lastDeliveryAt ? r.lastDeliveryAt.toISOString() : null,
    }));

    return { stock, total };
  }
}

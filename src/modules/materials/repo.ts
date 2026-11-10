import type { Pool, PoolClient } from 'pg';
import { getPool } from '../../lib/db.js';
import { AppError, ErrorCode } from '../../lib/errors.js';
import type { CreateMaterialBody, ListMaterialsQuery, MaterialResponse } from './schemas.js';

export interface MaterialRow {
  id: number;
  name: string;
  category: string;
  unit: string;
  createdAt: string;
}

export interface ListMaterialsResult {
  materials: MaterialResponse[];
  total: number;
}

export interface CompanyStockRow {
  store_id: string;
  material_id: string;
  quantity: string;
  reorder_point: string;
  status: string;
}

export class MaterialsRepo {
  constructor(private readonly pool: Pool = getPool()) {}

  /**
   * Creates a material and its initial company store stock row (quantity = 0)
   * in a single transaction (context.md rule 121).
   */
  async createMaterial(input: CreateMaterialBody): Promise<MaterialResponse> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Get the company store ID
      const storeRes = await client.query<{ id: string }>(
        'SELECT id FROM stores WHERE project_id IS NULL LIMIT 1',
      );
      const companyStoreId = storeRes.rows[0]?.id;
      if (!companyStoreId) {
        throw new AppError(500, ErrorCode.INTERNAL, 'Company store not found');
      }

      // 2. Insert material
      let materialRes;
      try {
        materialRes = await client.query<{
          id: string;
          name: string;
          category: string;
          unit: string;
          created_at: Date;
        }>(
          `INSERT INTO materials (name, category, unit)
           VALUES ($1, $2, $3)
           RETURNING id, name, category, unit, created_at`,
          [input.name, input.category, input.unit],
        );
      } catch (err: unknown) {
        if (
          typeof err === 'object' &&
          err !== null &&
          'code' in err &&
          err.code === '23505'
        ) {
          throw new AppError(
            409,
            ErrorCode.MATERIAL_EXISTS,
            `Material with name '${input.name}' already exists`,
          );
        }
        throw err;
      }

      const matRow = materialRes.rows[0];
      if (!matRow) {
        throw new AppError(500, ErrorCode.INTERNAL, 'Failed to insert material');
      }
      const materialId = Number(matRow.id);

      // 3. Create company store stock row (rule 121)
      await client.query(
        `INSERT INTO stock (store_id, material_id, quantity, reorder_point)
         VALUES ($1, $2, 0, 0)`,
        [companyStoreId, materialId],
      );

      await client.query('COMMIT');

      return {
        id: materialId,
        name: matRow.name,
        category: matRow.category,
        unit: matRow.unit,
        createdAt: matRow.created_at.toISOString(),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getMaterialById(id: number): Promise<MaterialResponse | null> {
    const res = await this.pool.query<{
      id: string;
      name: string;
      category: string;
      unit: string;
      created_at: Date;
    }>(
      `SELECT id, name, category, unit, created_at
       FROM materials
       WHERE id = $1`,
      [id],
    );

    const row = res.rows[0];
    if (!row) {
      return null;
    }

    return {
      id: Number(row.id),
      name: row.name,
      category: row.category,
      unit: row.unit,
      createdAt: row.created_at.toISOString(),
    };
  }

  /**
   * Lists materials with optional trigram name search and category filter.
   * Utilises GIN trigram index idx_materials_name_trgm for search (rule 152).
   */
  async listMaterials(query: ListMaterialsQuery): Promise<ListMaterialsResult> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let paramIndex = 1;

    if (query.search && query.search.length > 0) {
      conditions.push(`name ILIKE '%' || $${String(paramIndex++)} || '%'`);
      params.push(query.search);
    }

    if (query.category && query.category.length > 0) {
      conditions.push(`category = $${String(paramIndex++)}`);
      params.push(query.category);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count query
    const countSql = `SELECT count(*)::int AS count FROM materials ${whereClause}`;
    const countRes = await this.pool.query<{ count: number }>(countSql, params);
    const total = countRes.rows[0]?.count ?? 0;

    // Data query
    const dataParams = [...params, query.limit, query.offset];
    const limitParamIndex = paramIndex++;
    const offsetParamIndex = paramIndex++;

    const dataSql = `
      SELECT id, name, category, unit, created_at
      FROM materials
      ${whereClause}
      ORDER BY name ASC
      LIMIT $${String(limitParamIndex)} OFFSET $${String(offsetParamIndex)}
    `;

    const dataRes = await this.pool.query<{
      id: string;
      name: string;
      category: string;
      unit: string;
      created_at: Date;
    }>(dataSql, dataParams);

    const materials: MaterialResponse[] = dataRes.rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      category: r.category,
      unit: r.unit,
      createdAt: r.created_at.toISOString(),
    }));

    return { materials, total };
  }

  /**
   * Helper to inspect company stock row for a given material.
   */
  async getCompanyStockRow(
    materialId: number,
    client?: PoolClient,
  ): Promise<CompanyStockRow | null> {
    const db = client ?? this.pool;
    const res = await db.query<CompanyStockRow>(
      `SELECT s.store_id, s.material_id, s.quantity, s.reorder_point, s.status
       FROM stock s
       JOIN stores st ON st.id = s.store_id
       WHERE st.project_id IS NULL AND s.material_id = $1`,
      [materialId],
    );
    return res.rows[0] ?? null;
  }
}

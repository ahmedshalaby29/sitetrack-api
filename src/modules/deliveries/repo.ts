import type { Pool, PoolClient } from 'pg';
import { AppError, ErrorCode } from '../../lib/errors.js';
import { formatProjectId } from '../../lib/ids.js';
import {
  decodeCursor,
  encodeCursor,
  type DeliveryDirection,
  type DeliveryListResponse,
  type DeliveryResponse,
  type ListCompanyDeliveriesQuery,
} from './schemas.js';

interface RawDeliveryRow {
  id: string | number;
  project_id: string | number;
  direction: 'to_project' | 'to_company';
  status: 'in_transit' | 'delivered' | 'rejected' | 'cancelled';
  sender_user_id: string | number;
  sender_name: string;
  receiver_user_id: string | number | null;
  receiver_name: string | null;
  sent_at: Date;
  received_at: Date | null;
  created_at: Date;
}

interface RawLineRow {
  delivery_id: string | number;
  material_id: string | number;
  material_name: string;
  category: string;
  unit: string;
  quantity: string;
}

export class DeliveriesRepo {
  constructor(private readonly pool: Pool) {}

  private mapDelivery(raw: RawDeliveryRow, lines: RawLineRow[]): DeliveryResponse {
    const projId = Number(raw.project_id);
    return {
      id: Number(raw.id),
      projectId: projId,
      formattedProjectId: formatProjectId(projId),
      direction: raw.direction,
      status: raw.status,
      senderUserId: Number(raw.sender_user_id),
      senderName: raw.sender_name,
      receiverUserId: raw.receiver_user_id !== null ? Number(raw.receiver_user_id) : null,
      receiverName: raw.receiver_name,
      sentAt: raw.sent_at.toISOString(),
      receivedAt: raw.received_at ? raw.received_at.toISOString() : null,
      createdAt: raw.created_at.toISOString(),
      lines: lines.map((l) => ({
        materialId: Number(l.material_id),
        materialName: l.material_name,
        category: l.category,
        unit: l.unit,
        quantity: l.quantity,
      })),
    };
  }

  async getCompanyStoreId(client: PoolClient | Pool = this.pool): Promise<number> {
    const res = await client.query<{ id: string | number }>(
      'SELECT id FROM stores WHERE project_id IS NULL LIMIT 1',
    );
    const row = res.rows[0];
    if (!row) {
      throw new AppError(404, ErrorCode.STORE_NOT_FOUND, 'Company store not found');
    }
    return Number(row.id);
  }

  async getProjectStoreId(projectId: number, client: PoolClient | Pool = this.pool): Promise<number> {
    const res = await client.query<{ id: string | number }>(
      'SELECT id FROM stores WHERE project_id = $1 LIMIT 1',
      [projectId],
    );
    const row = res.rows[0];
    if (!row) {
      throw new AppError(404, ErrorCode.STORE_NOT_FOUND, 'Project store not found');
    }
    return Number(row.id);
  }

  async getDeliveryById(
    deliveryId: number,
    client: PoolClient | Pool = this.pool,
  ): Promise<DeliveryResponse | null> {
    const delivRes = await client.query<RawDeliveryRow>(
      `SELECT
         d.id,
         d.project_id,
         d.direction,
         d.status,
         d.sender_user_id,
         u_sender.name AS sender_name,
         d.receiver_user_id,
         u_receiver.name AS receiver_name,
         d.sent_at,
         d.received_at,
         d.created_at
       FROM deliveries d
       JOIN users u_sender ON u_sender.id = d.sender_user_id
       LEFT JOIN users u_receiver ON u_receiver.id = d.receiver_user_id
       WHERE d.id = $1`,
      [deliveryId],
    );

    const raw = delivRes.rows[0];
    if (!raw) return null;

    const linesRes = await client.query<RawLineRow>(
      `SELECT
         dl.delivery_id,
         dl.material_id,
         m.name AS material_name,
         m.category,
         m.unit,
         to_char(dl.quantity, 'FM99999999999990.000') AS quantity
       FROM delivery_lines dl
       JOIN materials m ON m.id = dl.material_id
       WHERE dl.delivery_id = $1
       ORDER BY dl.material_id ASC`,
      [deliveryId],
    );

    return this.mapDelivery(raw, linesRes.rows);
  }

  /**
   * Initiates a delivery inside a single transaction with race-safe stock debits
   * and deadlock avoidance (lines sorted by material_id ASC).
   */
  async initiateDelivery(params: {
    projectId: number;
    direction: DeliveryDirection;
    senderUserId: number;
    lines: { materialId: number; quantity: string }[];
    now?: Date | undefined;
  }): Promise<DeliveryResponse> {
    const client = await this.pool.connect();
    const now = params.now ?? new Date();

    try {
      await client.query('BEGIN');

      // Verify project exists
      const projRes = await client.query<{ id: string | number }>(
        'SELECT id FROM projects WHERE id = $1',
        [params.projectId],
      );
      if (!projRes.rows[0]) {
        throw new AppError(404, ErrorCode.PROJECT_NOT_FOUND, 'Project not found');
      }

      // Check duplicate materials in lines (Rule 128: 422)
      const materialIdsSeen = new Set<number>();
      for (const line of params.lines) {
        if (materialIdsSeen.has(line.materialId)) {
          throw new AppError(
            422,
            ErrorCode.DUPLICATE_DELIVERY_MATERIAL,
            `Duplicate material ${String(line.materialId)} in delivery lines`,
          );
        }
        materialIdsSeen.add(line.materialId);
      }

      // Deadlock avoidance: sort lines strictly by material_id ASC (Rule 128)
      const sortedLines = [...params.lines].sort((a, b) => a.materialId - b.materialId);

      // Determine sender store
      let senderStoreId: number;
      if (params.direction === 'to_project') {
        senderStoreId = await this.getCompanyStoreId(client);
      } else {
        senderStoreId = await this.getProjectStoreId(params.projectId, client);
      }

      // Race-safe debit for each material (Rule 124)
      for (const line of sortedLines) {
        const updateRes = await client.query(
          `UPDATE stock
           SET quantity = quantity - $1
           WHERE store_id = $2
             AND material_id = $3
             AND quantity >= $1
           RETURNING quantity`,
          [line.quantity, senderStoreId, line.materialId],
        );

        if (updateRes.rowCount === 0) {
          // Check if material exists
          const matRes = await client.query<{ id: string | number }>(
            'SELECT id FROM materials WHERE id = $1',
            [line.materialId],
          );
          if (matRes.rowCount === 0) {
            throw new AppError(404, ErrorCode.MATERIAL_NOT_FOUND, `Material ${String(line.materialId)} not found`);
          }
          throw new AppError(
            409,
            ErrorCode.INSUFFICIENT_STOCK,
            `Insufficient stock for material ${String(line.materialId)}`,
          );
        }
      }

      // Insert delivery header
      const delivRes = await client.query<{ id: string | number }>(
        `INSERT INTO deliveries (project_id, direction, status, sender_user_id, sent_at, created_at, updated_at)
         VALUES ($1, $2, 'in_transit', $3, $4, $4, $4)
         RETURNING id`,
        [params.projectId, params.direction, params.senderUserId, now],
      );
      const deliveryId = Number(delivRes.rows[0]?.id);

      // Insert delivery lines
      for (const line of sortedLines) {
        await client.query(
          `INSERT INTO delivery_lines (delivery_id, material_id, quantity, created_at)
           VALUES ($1, $2, $3, $4)`,
          [deliveryId, line.materialId, line.quantity, now],
        );
      }

      await client.query('COMMIT');

      const result = await this.getDeliveryById(deliveryId);
      if (!result) {
        throw new AppError(500, ErrorCode.INTERNAL, 'Failed to retrieve initiated delivery');
      }
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Records a delivery: receiver credits their stock, transitions in_transit -> delivered.
   * Race-safe transition: zero rows affected throws 409 DELIVERY_NOT_IN_TRANSIT.
   */
  async recordDelivery(params: {
    deliveryId: number;
    receiverUserId: number;
    expectedProjectId?: number | undefined;
    isStoreManager: boolean;
    now?: Date | undefined;
  }): Promise<DeliveryResponse> {
    const client = await this.pool.connect();
    const now = params.now ?? new Date();

    try {
      await client.query('BEGIN');

      // 1. Guarded update: in_transit -> delivered
      const updateRes = await client.query<RawDeliveryRow>(
        `UPDATE deliveries
         SET status = 'delivered',
             receiver_user_id = $1,
             received_at = $2,
             updated_at = $2
         WHERE id = $3 AND status = 'in_transit'
         RETURNING id, project_id, direction, status, sender_user_id, receiver_user_id, sent_at, received_at, created_at`,
        [params.receiverUserId, now, params.deliveryId],
      );

      if (updateRes.rowCount === 0) {
        // Find existing delivery to provide exact error
        const existingRes = await client.query<{ id: string | number; project_id: string | number; status: string }>(
          'SELECT id, project_id, status FROM deliveries WHERE id = $1',
          [params.deliveryId],
        );
        const existing = existingRes.rows[0];
        if (!existing) {
          throw new AppError(404, ErrorCode.DELIVERY_NOT_FOUND, 'Delivery not found');
        }
        if (params.expectedProjectId && Number(existing.project_id) !== params.expectedProjectId) {
          throw new AppError(404, ErrorCode.DELIVERY_NOT_FOUND, 'Delivery not found');
        }
        throw new AppError(409, ErrorCode.DELIVERY_NOT_IN_TRANSIT, `Delivery is already ${existing.status}`);
      }

      const raw = updateRes.rows[0];
      if (!raw) {
        throw new AppError(404, ErrorCode.DELIVERY_NOT_FOUND, 'Delivery not found');
      }

      const deliveryProjectId = Number(raw.project_id);
      if (params.expectedProjectId && deliveryProjectId !== params.expectedProjectId) {
        throw new AppError(404, ErrorCode.DELIVERY_NOT_FOUND, 'Delivery not found');
      }

      // Check role authorization for receiver (Rule 129 & 132)
      // to_project: receiver is project store (member acts)
      // to_company: receiver is company store (store manager acts)
      if (raw.direction === 'to_project' && params.isStoreManager && !params.expectedProjectId) {
        // Company store manager cannot record to_project delivery (they are sender, not receiver)
        throw new AppError(403, ErrorCode.FORBIDDEN, 'Company store manager cannot record project receipt');
      }
      if (raw.direction === 'to_company' && params.expectedProjectId && !params.isStoreManager) {
        // Project member cannot record to_company return (they are sender, not receiver)
        throw new AppError(403, ErrorCode.FORBIDDEN, 'Project member cannot record company return receipt');
      }

      // 2. Credit receiver stock
      let receiverStoreId: number;
      if (raw.direction === 'to_project') {
        receiverStoreId = await this.getProjectStoreId(deliveryProjectId, client);
      } else {
        receiverStoreId = await this.getCompanyStoreId(client);
      }

      const linesRes = await client.query<{ material_id: string | number; quantity: string }>(
        'SELECT material_id, quantity FROM delivery_lines WHERE delivery_id = $1 ORDER BY material_id ASC',
        [params.deliveryId],
      );

      for (const line of linesRes.rows) {
        await client.query(
          `INSERT INTO stock (store_id, material_id, quantity, reorder_point, last_delivery_at, updated_at)
           VALUES ($1, $2, $3, 0, $4, $4)
           ON CONFLICT (store_id, material_id)
           DO UPDATE SET
             quantity = stock.quantity + EXCLUDED.quantity,
             last_delivery_at = EXCLUDED.last_delivery_at,
             updated_at = EXCLUDED.updated_at`,
          [receiverStoreId, line.material_id, line.quantity, now],
        );
      }

      await client.query('COMMIT');

      const result = await this.getDeliveryById(params.deliveryId);
      if (!result) {
        throw new AppError(500, ErrorCode.INTERNAL, 'Failed to retrieve delivered delivery');
      }
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Rejects a delivery: receiver transitions in_transit -> rejected and credits the sender's stock back.
   * Zero rows affected throws 409 DELIVERY_NOT_IN_TRANSIT.
   */
  async rejectDelivery(params: {
    deliveryId: number;
    receiverUserId: number;
    expectedProjectId?: number | undefined;
    isStoreManager: boolean;
    now?: Date | undefined;
  }): Promise<DeliveryResponse> {
    const client = await this.pool.connect();
    const now = params.now ?? new Date();

    try {
      await client.query('BEGIN');

      const updateRes = await client.query<RawDeliveryRow>(
        `UPDATE deliveries
         SET status = 'rejected',
             receiver_user_id = $1,
             received_at = $2,
             updated_at = $2
         WHERE id = $3 AND status = 'in_transit'
         RETURNING id, project_id, direction, status, sender_user_id, receiver_user_id, sent_at, received_at, created_at`,
        [params.receiverUserId, now, params.deliveryId],
      );

      if (updateRes.rowCount === 0) {
        const existingRes = await client.query<{ id: string | number; project_id: string | number; status: string }>(
          'SELECT id, project_id, status FROM deliveries WHERE id = $1',
          [params.deliveryId],
        );
        const existing = existingRes.rows[0];
        if (!existing) {
          throw new AppError(404, ErrorCode.DELIVERY_NOT_FOUND, 'Delivery not found');
        }
        if (params.expectedProjectId && Number(existing.project_id) !== params.expectedProjectId) {
          throw new AppError(404, ErrorCode.DELIVERY_NOT_FOUND, 'Delivery not found');
        }
        throw new AppError(409, ErrorCode.DELIVERY_NOT_IN_TRANSIT, `Delivery is already ${existing.status}`);
      }

      const raw = updateRes.rows[0];
      if (!raw) {
        throw new AppError(404, ErrorCode.DELIVERY_NOT_FOUND, 'Delivery not found');
      }

      const deliveryProjectId = Number(raw.project_id);
      if (params.expectedProjectId && deliveryProjectId !== params.expectedProjectId) {
        throw new AppError(404, ErrorCode.DELIVERY_NOT_FOUND, 'Delivery not found');
      }

      // Check receiver role
      if (raw.direction === 'to_project' && params.isStoreManager && !params.expectedProjectId) {
        throw new AppError(403, ErrorCode.FORBIDDEN, 'Company store manager cannot reject on behalf of project');
      }
      if (raw.direction === 'to_company' && params.expectedProjectId && !params.isStoreManager) {
        throw new AppError(403, ErrorCode.FORBIDDEN, 'Project member cannot reject company return receipt');
      }

      // Sender gets their stock back
      let senderStoreId: number;
      if (raw.direction === 'to_project') {
        senderStoreId = await this.getCompanyStoreId(client);
      } else {
        senderStoreId = await this.getProjectStoreId(deliveryProjectId, client);
      }

      const linesRes = await client.query<{ material_id: string | number; quantity: string }>(
        'SELECT material_id, quantity FROM delivery_lines WHERE delivery_id = $1 ORDER BY material_id ASC',
        [params.deliveryId],
      );

      for (const line of linesRes.rows) {
        await client.query(
          `INSERT INTO stock (store_id, material_id, quantity, reorder_point, updated_at)
           VALUES ($1, $2, $3, 0, $4)
           ON CONFLICT (store_id, material_id)
           DO UPDATE SET
             quantity = stock.quantity + EXCLUDED.quantity,
             updated_at = EXCLUDED.updated_at`,
          [senderStoreId, line.material_id, line.quantity, now],
        );
      }

      await client.query('COMMIT');

      const result = await this.getDeliveryById(params.deliveryId);
      if (!result) {
        throw new AppError(500, ErrorCode.INTERNAL, 'Failed to retrieve rejected delivery');
      }
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Cancels a delivery: sender transitions in_transit -> cancelled and credits the sender's stock back.
   * Zero rows affected throws 409 DELIVERY_NOT_IN_TRANSIT.
   */
  async cancelDelivery(params: {
    deliveryId: number;
    senderUserId: number;
    expectedProjectId?: number | undefined;
    isStoreManager: boolean;
    now?: Date | undefined;
  }): Promise<DeliveryResponse> {
    const client = await this.pool.connect();
    const now = params.now ?? new Date();

    try {
      await client.query('BEGIN');

      const updateRes = await client.query<RawDeliveryRow>(
        `UPDATE deliveries
         SET status = 'cancelled',
             received_at = $1,
             updated_at = $1
         WHERE id = $2 AND status = 'in_transit'
         RETURNING id, project_id, direction, status, sender_user_id, receiver_user_id, sent_at, received_at, created_at`,
        [now, params.deliveryId],
      );

      if (updateRes.rowCount === 0) {
        const existingRes = await client.query<{ id: string | number; project_id: string | number; status: string }>(
          'SELECT id, project_id, status FROM deliveries WHERE id = $1',
          [params.deliveryId],
        );
        const existing = existingRes.rows[0];
        if (!existing) {
          throw new AppError(404, ErrorCode.DELIVERY_NOT_FOUND, 'Delivery not found');
        }
        if (params.expectedProjectId && Number(existing.project_id) !== params.expectedProjectId) {
          throw new AppError(404, ErrorCode.DELIVERY_NOT_FOUND, 'Delivery not found');
        }
        throw new AppError(409, ErrorCode.DELIVERY_NOT_IN_TRANSIT, `Delivery is already ${existing.status}`);
      }

      const raw = updateRes.rows[0];
      if (!raw) {
        throw new AppError(404, ErrorCode.DELIVERY_NOT_FOUND, 'Delivery not found');
      }

      const deliveryProjectId = Number(raw.project_id);
      if (params.expectedProjectId && deliveryProjectId !== params.expectedProjectId) {
        throw new AppError(404, ErrorCode.DELIVERY_NOT_FOUND, 'Delivery not found');
      }

      // Check sender role (Rule 131 & 132: sender only)
      if (raw.direction === 'to_project' && !params.isStoreManager) {
        throw new AppError(403, ErrorCode.FORBIDDEN, 'Only company store manager can cancel outward delivery');
      }
      if (raw.direction === 'to_company' && params.isStoreManager && !params.expectedProjectId) {
        throw new AppError(403, ErrorCode.FORBIDDEN, 'Only project members can cancel return delivery');
      }

      // Sender gets stock back
      let senderStoreId: number;
      if (raw.direction === 'to_project') {
        senderStoreId = await this.getCompanyStoreId(client);
      } else {
        senderStoreId = await this.getProjectStoreId(deliveryProjectId, client);
      }

      const linesRes = await client.query<{ material_id: string | number; quantity: string }>(
        'SELECT material_id, quantity FROM delivery_lines WHERE delivery_id = $1 ORDER BY material_id ASC',
        [params.deliveryId],
      );

      for (const line of linesRes.rows) {
        await client.query(
          `INSERT INTO stock (store_id, material_id, quantity, reorder_point, updated_at)
           VALUES ($1, $2, $3, 0, $4)
           ON CONFLICT (store_id, material_id)
           DO UPDATE SET
             quantity = stock.quantity + EXCLUDED.quantity,
             updated_at = EXCLUDED.updated_at`,
          [senderStoreId, line.material_id, line.quantity, now],
        );
      }

      await client.query('COMMIT');

      const result = await this.getDeliveryById(params.deliveryId);
      if (!result) {
        throw new AppError(500, ErrorCode.INTERNAL, 'Failed to retrieve cancelled delivery');
      }
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Lists deliveries with keyset pagination on (created_at DESC, id DESC).
   * Prevents N+1 by batch-fetching all lines for the page in a single query.
   */
  async listDeliveries(opts: {
    projectId?: number | undefined;
    query: ListCompanyDeliveriesQuery;
  }): Promise<DeliveryListResponse> {
    const { query } = opts;
    const limit = query.limit;
    const filterClauses: string[] = [];
    const filterParams: (string | number | Date)[] = [];
    let paramIndex = 1;

    if (opts.projectId !== undefined) {
      filterClauses.push(`d.project_id = $${String(paramIndex++)}`);
      filterParams.push(opts.projectId);
    }

    if (query.direction !== undefined) {
      filterClauses.push(`d.direction = $${String(paramIndex++)}`);
      filterParams.push(query.direction);
    }

    if (query.status !== undefined) {
      filterClauses.push(`d.status = $${String(paramIndex++)}`);
      filterParams.push(query.status);
    }

    if (query.dateFrom !== undefined) {
      const fromDate = new Date(query.dateFrom);
      if (!Number.isNaN(fromDate.getTime())) {
        filterClauses.push(`d.created_at >= $${String(paramIndex++)}`);
        filterParams.push(fromDate);
      }
    }

    if (query.dateTo !== undefined) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(query.dateTo)) {
        const toDate = new Date(`${query.dateTo}T23:59:59.999Z`);
        filterClauses.push(`d.created_at <= $${String(paramIndex++)}`);
        filterParams.push(toDate);
      } else {
        const toDate = new Date(query.dateTo);
        if (!Number.isNaN(toDate.getTime())) {
          filterClauses.push(`d.created_at <= $${String(paramIndex++)}`);
          filterParams.push(toDate);
        }
      }
    }

    // Keyset pagination cursor
    if (query.cursor !== undefined) {
      const decoded = decodeCursor(query.cursor);
      if (decoded) {
        const cDateIdx = paramIndex++;
        const cIdIdx = paramIndex++;
        filterClauses.push(
          `((d.created_at < $${String(cDateIdx)}) OR (d.created_at = $${String(cDateIdx)} AND d.id < $${String(cIdIdx)}))`,
        );
        filterParams.push(decoded.createdAt, decoded.id);
      }
    }

    const whereClause = filterClauses.length > 0 ? `WHERE ${filterClauses.join(' AND ')}` : '';
    const limitIdx = paramIndex++;
    const dataParams = [...filterParams, limit + 1];

    const dataSql = `
      SELECT
        d.id,
        d.project_id,
        d.direction,
        d.status,
        d.sender_user_id,
        u_sender.name AS sender_name,
        d.receiver_user_id,
        u_receiver.name AS receiver_name,
        d.sent_at,
        d.received_at,
        d.created_at
      FROM deliveries d
      JOIN users u_sender ON u_sender.id = d.sender_user_id
      LEFT JOIN users u_receiver ON u_receiver.id = d.receiver_user_id
      ${whereClause}
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $${String(limitIdx)}
    `;

    const delivRes = await this.pool.query<RawDeliveryRow>(dataSql, dataParams);
    const rows = delivRes.rows;

    let hasMore = false;
    let pageRows = rows;
    if (rows.length > limit) {
      hasMore = true;
      pageRows = rows.slice(0, limit);
    }

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      if (last) {
        nextCursor = encodeCursor(last.created_at, Number(last.id));
      }
    }

    if (pageRows.length === 0) {
      return {
        deliveries: [],
        hasMore: false,
        nextCursor: null,
      };
    }

    // Batch-fetch all delivery lines for the page in a single query (Rule 42: No N+1!)
    const deliveryIds = pageRows.map((r) => Number(r.id));
    const linesRes = await this.pool.query<RawLineRow>(
      `SELECT
         dl.delivery_id,
         dl.material_id,
         m.name AS material_name,
         m.category,
         m.unit,
         to_char(dl.quantity, 'FM99999999999990.000') AS quantity
       FROM delivery_lines dl
       JOIN materials m ON m.id = dl.material_id
       WHERE dl.delivery_id = ANY($1::bigint[])
       ORDER BY dl.delivery_id, dl.material_id ASC`,
      [deliveryIds],
    );

    const linesByDeliveryId = new Map<number, RawLineRow[]>();
    for (const line of linesRes.rows) {
      const dId = Number(line.delivery_id);
      const list = linesByDeliveryId.get(dId) ?? [];
      list.push(line);
      linesByDeliveryId.set(dId, list);
    }

    const deliveries: DeliveryResponse[] = pageRows.map((r) =>
      this.mapDelivery(r, linesByDeliveryId.get(Number(r.id)) ?? []),
    );

    return {
      deliveries,
      hasMore,
      nextCursor,
    };
  }
}

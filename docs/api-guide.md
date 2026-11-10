# SiteTrack API Guide & Integration Reference

Welcome to the **SiteTrack API** documentation. SiteTrack is a high-performance, transactional backend designed for construction project management, materials cataloguing, DAG-based task scheduling, and multi-store delivery logistics.

The API is fully documented via OpenAPI v3. Interactive documentation is available via Swagger UI at `/docs`, and raw schema specification at `docs/openapi.json`.

---

## 1. General Principles

### 1.1 Base URL & Content Type
- **Base URL**: `http://localhost:3000` (or configured `HOST:PORT`)
- **Headers**:
  - `Content-Type: application/json`
  - `Accept: application/json`

### 1.2 Authentication & Authorization
- **Access Token**: Short-lived JWT (15 minutes). Send in HTTP header:
  ```http
  Authorization: Bearer <jwt-access-token>
  ```
- **Refresh Token**: Long-lived single-use rotating token (7 days). Exchanged via `/auth/refresh`.
- **Revocation**: Roles and session validity are evaluated on **every request directly against PostgreSQL**. When a user's role is changed or session revoked, the next request is revoked immediately (Rule 1 & Rule 88).
- **Project Isolation**: Accessing a sub-resource of a project you are not a member of returns **404 Not Found** (never 403) to prevent enumeration of project IDs (Rule 2).

### 1.3 Uniform Error Envelope
All error responses (4xx, 5xx) strictly follow the SiteTrack error envelope:
```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "Store does not have sufficient stock for the requested materials",
    "details": {
      "materialId": 42,
      "requested": "100.000",
      "available": "25.000"
    }
  }
}
```

Standard Status Codes:
- `400 Bad Request`: Schema validation error (Zod-validated query, params, or body).
- `401 Unauthorized`: Missing, expired, or invalid authentication token.
- `403 Forbidden`: Authenticated user lacks application-level role (e.g. non-manager trying to add stock).
- `404 Not Found`: Resource does not exist, or project exists but caller is not a member.
- `409 Conflict`: Business invariant conflict (cycle in task graph, last admin removal, delivery status mismatch, insufficient stock).
- `422 Unprocessable Entity`: Semantic validation failure (duplicate material lines in delivery, cyclic dependency).

### 1.4 Numeric Precision & Serialisation
- Quantities are stored in PostgreSQL as `NUMERIC(14,3)` (up to 99,999,999,999.999) to prevent IEEE-754 floating-point drift.
- All quantities in request and response JSON payloads are formatted as strings (e.g. `"50.000"`).

### 1.5 Identifier Conventions
- Projects: Displayed as `PRJ-0001` (numeric integer stored in database).
- Tasks: Per-project sequential number (e.g. `1`, `2`, displayed as `TSK-0001`).
- Keyset pagination cursors: Opaque base64url-encoded strings encoding `(created_at, id)`.

---

## 2. API Endpoints Reference

### 2.1 Health Check
- `GET /health`
  - Returns `200 OK` with database connection latency and memory stats.
  - Returns `503 Service Unavailable` if database health check fails.

### 2.2 Authentication & Profile
- `POST /auth/register`
  - Body: `{ "name": "...", "email": "...", "password": "...", "appRole": "user" | "store_manager" | "super_admin" }`
  - Returns: `{ "user": { ... }, "accessToken": "...", "refreshToken": "..." }`
- `POST /auth/login`
  - Body: `{ "email": "...", "password": "..." }`
  - Returns: `{ "user": { ... }, "accessToken": "...", "refreshToken": "..." }`
- `POST /auth/refresh`
  - Body: `{ "refreshToken": "..." }`
  - Rotates refresh token (single-use token chain with reuse detection and instant family revocation).
- `POST /auth/logout`
  - Revokes current session and marks token chain invalid.
- `GET /me`
  - Returns authenticated user profile, app role, and active notifications.

### 2.3 User Administration
- `PATCH /users/:id/role`
  - Restricted to `super_admin`.
  - Body: `{ "role": "user" | "store_manager" | "super_admin" }`
  - Role takes effect immediately on the target user's next request.

### 2.4 Notifications (Invitations)
- `GET /notifications`
  - List invitations for authenticated user, newest first.
  - Keyset paginated on `(created_at DESC, id DESC)`.
- `POST /notifications/:id/accept`
  - Accepts pending invitation; adds user to project members.
- `POST /notifications/:id/reject`
  - Rejects pending invitation.

### 2.5 Materials Catalogue
- `POST /materials`
  - Restricted to `store_manager` and `super_admin`.
  - Body: `{ "name": "...", "category": "...", "unit": "..." }`
  - Creates material and automatically provisions company store stock row (`quantity = 0.000`).
- `GET /materials`
  - List and search materials with trigram GIN index.
  - Query: `?search=steel&category=Steel&limit=50&offset=0`
- `GET /materials/:id`
  - Fetch material details.
- `PATCH /materials/:id`
  - Update material details.

### 2.6 Projects
- `POST /projects`
  - Body: `{ "name": "...", "description": "...", "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD" }`
  - Creates project, allocates sequential ID `PRJ-xxxx`, assigns creator as `is_admin = true`, and creates project store.
- `GET /projects`
  - List projects accessible to caller (all projects for `super_admin`; only member projects for regular users).
  - Includes real-time task counts (`notStarted`, `inProgress`, `blocked`, `done`), `percentDone`, `lateCount`, `blockedCount`, and member count.
  - Query parameters:
    - `search`: Trigram search on name or exact integer ID (e.g. `PRJ-0005` or `5`).
    - `hasLate`: Boolean filter (`true` to show only projects with overdue tasks).
    - `sort`: `name` | `start_date` | `percent_done` | `late_tasks` | `id`.
    - `order`: `asc` | `desc`.
    - `limit`, `offset`.
- `GET /projects/:projectId`
  - Detailed project aggregates and metadata.
- `PATCH /projects/:projectId`
  - Restricted to project admins.
- `DELETE /projects/:projectId`
  - Soft deletes project (`is_deleted = true`, `deleted_at = now()`).

### 2.7 Project Members & Invitations
- `GET /projects/:projectId/members`
  - List project members and their admin status.
- `POST /projects/:projectId/members/:userId/promote`
  - Promote member to project admin.
- `DELETE /projects/:projectId/members/:userId`
  - Remove member. Protected by **Last Admin Guard** (409 conflict if attempting to remove the last admin).
- `POST /projects/:projectId/invitations`
  - Invite user to project by email or user ID.
- `DELETE /projects/:projectId/invitations/:invitationId`
  - Withdraw pending invitation.

### 2.8 Project Tasks & Dependency Graph
- `POST /projects/:projectId/tasks`
  - Body: `{ "name": "...", "description": "...", "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD" }`
  - Concurrency-safe per-project task numbering (`1, 2, 3...`).
- `GET /projects/:projectId/tasks`
  - List tasks with status, late flag, blocked flag, and direct dependencies count.
  - Query filters: `status`, `late`, `blocked`, `dateFrom`, `dateTo`, `search`, `sort`, `order`.
- `GET /projects/:projectId/tasks/:taskNumber`
  - Task details with upstream prerequisites and downstream dependents.
- `PATCH /projects/:projectId/tasks/:taskNumber`
  - Updates task. Transitions strictly governed by status machine:
    - Cannot transition `not_started` $\to$ `in_progress` or `done` if any prerequisite is not `done`.
- `DELETE /projects/:projectId/tasks/:taskNumber`
  - Deletes task and cascades dependency removal.
- `POST /projects/:projectId/tasks/:taskNumber/dependencies`
  - Body: `{ "dependsOnNumber": 5 }`
  - Adds dependency edge. Protected by **Cycle Detection** (recursive traversal under project-level lock; returns 409 `DEPENDENCY_CYCLE` if edge would form a cycle).
- `DELETE /projects/:projectId/tasks/:taskNumber/dependencies/:dependsOnNumber`
  - Removes dependency edge and recomputes downstream blocked flags.
- `GET /projects/:projectId/tasks/:taskNumber/graph`
  - Returns ancestor graph (prerequisites) and descendant graph (impact analysis) with topological depths.

### 2.9 Stock & Stores
- `GET /company-store/stock`
  - Company warehouse stock.
  - Computed live `inTransitToProjects` via LATERAL subquery on partial index.
  - Query: `?status=available|low_stock|out_of_stock&category=...&search=...`
- `POST /company-store/stock`
  - Restricted to `store_manager` and `super_admin`.
  - Body: `{ "materialId": 1, "quantity": "500.000" }`
  - Race-safe stock increment via `INSERT ... ON CONFLICT DO UPDATE`.
- `PATCH /company-store/stock/:materialId/reorder-point`
  - Sets stock reorder point threshold.
- `GET /projects/:projectId/store`
  - Project site inventory. Shows materials with quantity and last delivery date.

### 2.10 Deliveries (Logistics Ledger)
- `POST /projects/:projectId/deliveries`
  - Body:
    ```json
    {
      "direction": "to_project",
      "lines": [
        { "materialId": 1, "quantity": "25.000" },
        { "materialId": 4, "quantity": "10.000" }
      ]
    }
    ```
  - **Deadlock Avoidance**: Lines sorted by `material_id ASC` before acquiring row locks.
  - **Race-Safe Debit**: Atomically debits sender stock with `quantity >= requested`. Fails with 409 `INSUFFICIENT_STOCK` if stock is unavailable.
- `GET /projects/:projectId/deliveries`
  - Project delivery ledger with keyset pagination.
  - Query: `?cursor=...&limit=20&direction=...&status=...`
- `GET /company-store/deliveries`
  - Company-wide deliveries across all projects with keyset pagination.
- `POST /projects/:projectId/deliveries/:deliveryId/record`
  - Receiver records receipt. Guarded transition `in_transit` $\to$ `delivered`. Credits receiver store stock.
- `POST /projects/:projectId/deliveries/:deliveryId/reject`
  - Receiver rejects delivery. Guarded transition `in_transit` $\to$ `rejected`. Refunds debited stock back to sender store.
- `POST /projects/:projectId/deliveries/:deliveryId/cancel`
  - Sender cancels delivery before receipt. Guarded transition `in_transit` $\to$ `cancelled`. Refunds stock back to sender store.

---

## 3. Keyset Pagination Specification

Deliveries and notifications implement deterministic keyset pagination on `(created_at DESC, id DESC)`:
1. First request: `GET /projects/PRJ-0001/deliveries?limit=20`
2. Response includes `nextCursor`:
   ```json
   {
     "deliveries": [...],
     "hasMore": true,
     "nextCursor": "eyJjIjoiMjAyNi0xMS0xMFQxODozMDowMC4wMDBaIiwiaWQiOjEyM30"
   }
   ```
3. Subsequent request: `GET /projects/PRJ-0001/deliveries?cursor=eyJjIjoiMjAyNi0xMS0xMFQxODozMDowMC4wMDBaIiwiaWQiOjEyM30&limit=20`
4. The cursor decodes to `{ "c": "2026-11-10T18:30:00.000Z", "id": 123 }` and evaluates via:
   ```sql
   WHERE (d.created_at < $cursorDate OR (d.created_at = $cursorDate AND d.id < $cursorId))
   ```
   yielding consistent $O(\log N)$ seeks without offset degradation.

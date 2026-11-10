# SiteTrack: project context

Backend take-home for a construction project and materials tracker.
Read this fully before doing anything. If a request conflicts with this file, say so instead of silently deviating.

## Stack (fixed)

- TypeScript on Node 22, Fastify, Zod (`fastify-type-provider-zod`), `@fastify/swagger` for OpenAPI
- PostgreSQL 16, accessed via Kysely or plain `pg` with hand-written SQL. **No ORM** (no Prisma, TypeORM, Sequelize)
- Migrations: plain numbered `.sql` files in `/migrations`, applied at API startup under `pg_advisory_lock`. One migration per feature
- Passwords: `@node-rs/argon2`. JWT: `jose`
- Tests: Vitest against a **real Postgres**. **Never mock the database**
- Docker: multi-stage `node:22-slim`. Postgres healthcheck, API `depends_on: condition: service_healthy`
- `docker compose up` on a clean machine must yield a ready API with zero other steps

## Non-negotiable rules

1. **Role and membership are never read from the JWT.** The JWT carries only `sub` (user id) and `sid` (session id). On every request, load session + user (+ membership where relevant) from the DB. This is what makes logout and role/membership changes effective on the very next request.
2. **Non-member access returns 404, never 403.** For a project or any sub-resource (tasks, store, deliveries, members, invitations), a non-member gets the exact same response as for a nonexistent project. SuperAdmin passes the guard.
3. **Every sub-resource query is scoped by the path's `project_id`.** Never fetch a task, delivery, invitation or stock row by its own id alone. A valid id under the wrong project returns 404.
4. **Every list, count, search result and report is scoped to what the caller may see.** No unscoped aggregates.
5. **Atomicity and races are solved by the database**: single transactions, row locks (`FOR UPDATE`), conditional `UPDATE ... WHERE`, unique indexes, CHECK constraints. Never check-then-act in app code without a lock.
6. **Quantities are `NUMERIC(14,3)`, serialized as strings.** Never JS `number` for quantities.
7. **IDs are stored as integers and formatted at the API edge** (`PRJ-0042`, `PRJ-0042-T-0137`). Counters only go up and are never reused.
8. **`blocked` is a stored column**, recomputed per project in the same transaction as any change that could affect it. **`late` is derived live in SQL** from an injected clock (UTC).
9. **Never select `password_hash` or `refresh_token_hash` in any query that feeds a response.** No `SELECT *`. List columns explicitly.
10. **Error envelope everywhere:** `{ "error": { "code": "...", "message": "..." } }`. No stack traces, no SQL errors, no internals in messages.
11. **Everything must hold at the scale below.** Check `EXPLAIN ANALYZE`, do not assume an index is used.

## Scale targets

| Data | Volume |
|---|---|
| Users | 5,000 |
| Projects | 2,000 (up to 50 members each) |
| Invitations | 50,000 |
| Tasks | 500,000 (up to 3,000 in one project) |
| Task dependencies | 1,000,000 |
| Materials | 20,000 |
| Deliveries | 400,000 (3,000,000 lines) |

Single small server running API and DB. Every screen must stay fast. No exact `COUNT(*)` over huge filtered sets (use `hasMore` or only cheap totals). Keyset pagination for deliveries and notifications. N+1 queries are forbidden (batch-fetch delivery lines for a page's ids).

## Roles and access

App roles (one per account, chosen at registration): `user`, `store_manager`, `super_admin`.

| Capability | user | store_manager | super_admin |
|---|---|---|---|
| Projects they are a member of | yes | yes | yes |
| Any project, member or not | no | no | yes |
| Company store and its deliveries | no | yes | yes |
| Read materials catalogue | yes | yes | yes |
| Write materials catalogue | no | yes | yes |
| Change another user's app role | no | no | yes |

Project-level: each member is or is not a project admin. Only project admins invite, withdraw invitations, promote, and remove members. Non-admin members work with tasks, store and deliveries.

## Decisions on ambiguities (already made, do not re-litigate)

1. **SuperAdmin is not automatically a project admin.** They can read and work in every project, but changing members, invitations and admin status requires being an actual member who is a project admin.
2. **Self-chosen app role at registration** is allowed because the brief says so, including `super_admin`. Document it in the README as a production risk, and offer an env flag (`ALLOW_PRIVILEGED_SELF_REGISTRATION`, default true for the take-home) that restricts it.
3. **Changing an app role:** SuperAdmin-only endpoint `PATCH /users/:id/role`. Takes effect on the target's next request.
4. **Materials catalogue writes:** store managers and SuperAdmin only. Everyone authenticated reads and uses it.
5. **Last project admin:** removing or demoting the last admin is rejected with 409. Checked while holding `FOR UPDATE` on the project row so concurrent removals cannot both succeed. A project admin may leave only if another admin exists.
6. **Deleting a task others depend on:** allowed. Cascade its edges, then recompute blocked flags for the project. Task numbers are never reissued.
7. **Deleting a project with stock or in-transit deliveries:** rejected with 409. Otherwise soft delete (row kept, hidden from everything, number never reused).
8. **`last_delivery_at`** is set when stock leaves on initiate and when stock joins on record. Returns (reject, cancel) do not touch it.
9. **Notifications:** list all invitations for the user newest first. Answered and withdrawn ones appear without actions. Unread count is returned in `/me` and as an `X-Unread-Notifications` header on every authenticated response. Answering marks it read. There is also an explicit mark-read endpoint.
10. **Invite by email.** Unknown email returns the same generic error as other unprocessable invites. Duplicate pending invite is blocked by a partial unique index. Inviting an existing member returns 409.
11. **Adding a dependency edge is rejected** if it would make a task that is already `in_progress` or `done` wait on a task that is not done. This preserves the invariant "started implies all prerequisites done".
12. **Dates:** all "today" logic is UTC date. The clock is injected so tests control it.
13. **Soft vs hard delete:** projects soft-deleted. Tasks hard-deleted. Materials with any stock rows or delivery lines referencing them cannot be deleted (409), otherwise hard delete.
14. **Percentage done** = done tasks / total tasks (0 when no tasks), as a number with one decimal.

## Auth and sessions

- Register: name, email, password, role. Email unique case-insensitively (`citext` or unique index on `lower(email)`).
- Login: email + password. One generic error for unknown email and wrong password. For unknown email, still run a dummy argon2 verify so timing matches.
- Access token: JWT, 15 minutes, claims `sub`, `sid`. Refresh token: opaque random string, stored hashed in `sessions`, rotated on every use. Reusing an already-rotated refresh token revokes the whole session.
- Every authenticated request: one indexed query loads the session (must not be revoked or expired) and the user. Logout revokes the session, so its access token stops working immediately.
- Passwords never returned or logged. Rate limiting on login is a bonus, document it if skipped.

## Authorization implementation

- Request-context plugin: resolves `request.auth = { userId, sessionId, appRole }` from the DB.
- Project guard (preHandler on `/projects/:projectId/*`): parse the `PRJ-` id, load the project (not soft-deleted), check membership. If missing or not a member (and not SuperAdmin), return 404 `PROJECT_NOT_FOUND`. Attach `request.project = { id, isAdmin, isMember }`.
- Helpers: `requireProjectAdmin` (must be a member AND admin, otherwise 404 for non-members and 403 for non-admin members), `requireStoreManager` (store_manager or super_admin, otherwise 403 on company-store routes).
- Company store routes: users who are not managers or SuperAdmin get 403. (The 404 rule applies to project resources, where existence must not leak.)
- A permission-matrix test harness is table-driven: rows of `{ method, path, member, nonMember, admin, manager, superAdmin }` expectations. Every new endpoint adds a row.

## IDs

- `counters` table (`name` PK, `value` bigint). Project number: `UPDATE counters SET value = value + 1 WHERE name = 'project' RETURNING value`, in the same transaction as the project insert.
- Task number: `UPDATE projects SET task_seq = task_seq + 1 WHERE id = $1 RETURNING task_seq`. Composite PK on tasks `(project_id, number)`.
- Rolled-back transactions may leave gaps. That is acceptable and documented ("never duplicated, never reused" is the guarantee; gapless under normal operation).
- Format: `PRJ-` + 4-digit zero-padded (grows past 4 digits naturally). Task: `PRJ-0042-T-0137`.

## Task dependencies

- `task_dependencies(project_id, task_number, depends_on_number)`. Composite FKs to `tasks (project_id, number)` on both sides enforce same-project at schema level. `CHECK (task_number <> depends_on_number)`. PK on all three columns. Index on `(project_id, depends_on_number)` for reverse lookups.
- "B depends on A" means B waits for A.
- Add and remove edges inside a transaction holding `SELECT ... FROM projects WHERE id = $1 FOR UPDATE`. Load the whole project's nodes and edges in one query, run graph logic **in memory** (max 3,000 nodes), reject cycles (including self via other tasks) with 409 `DEPENDENCY_CYCLE`.
- Graph logic lives in a pure module with unit tests: cycle detection, transitive ancestors and descendants with minimum step distance (BFS), diamond cases. Do **not** use recursive CTEs for this (they explode on diamonds).
- After any edge or status change, or task create/delete, recompute `blocked` for the whole project in the same transaction: blocked = status is not done AND at least one transitive prerequisite is not done.

## Task status

- Statuses: `not_started`, `in_progress`, `done`. Derived flags: `late`, `blocked`.
- Actions: `start` (not_started to in_progress, only if every transitive prerequisite is done), `complete` (in_progress to done), `reopen` (done to in_progress, only if no transitive dependent has started, i.e. all are `not_started`). Anything else is rejected with 409.
- Late (derived live): `status <> 'done' AND ((status = 'not_started' AND start_date < today) OR end_date < today)`. Done is never late.
- Both flags can be true at once.
- Pure function `allowedActions(status, prereqs, dependents)` drives the task-details response, which lists only currently allowed actions.
- Task details also return: every prerequisite (direct and indirect) with step distance, and every dependent (direct and indirect) with step distance.
- Status change endpoints lock the project row (same lock as edges), so status and graph changes serialize per project.

## Stores, stock and deliveries

- `stores`: one company store row, plus one row per project, created in the project's creation transaction.
- `stock(store_id, material_id, quantity NUMERIC(14,3) CHECK (quantity >= 0), reorder_point NUMERIC(14,3), last_delivery_at timestamptz)`. PK `(store_id, material_id)`.
- Company store stock row is created when a material is created, so "every material" needs no outer join. Project store lists show only materials with a stock row there.
- Company stock `status` is a generated stored column: `out_of_stock` when quantity = 0, `low_stock` when quantity > 0 and quantity <= reorder_point, otherwise `available`. Reorder point defaults to 0 (so any positive quantity is `available` until a manager sets one).
- **Add stock** (managers only): the only way new material enters. Credit via `INSERT ... ON CONFLICT DO UPDATE`. Positive quantity only.
- **Debit** is race-safe: `UPDATE stock SET quantity = quantity - $q WHERE store_id=$s AND material_id=$m AND quantity >= $q`. Zero rows affected means insufficient stock, so roll back the whole transaction and return 409.
- **Deliveries:** `deliveries(id, project_id, direction, status, sender_user_id, receiver_user_id, sent_at, received_at, created_at)` and `delivery_lines(delivery_id, material_id, quantity)`.
  - Direction: `to_project` (company store to project store) or `to_company` (project store to company store). Project-to-project is impossible by construction (one side is always the company store, enforced by schema).
  - Statuses: `in_transit`, `delivered`, `rejected`, `cancelled`.
  - Initiate: sender is a store manager/SuperAdmin (company store) or a project member (project store). Debits sender stock immediately. Lines sorted by `material_id` before touching stock (deadlock avoidance). Duplicate materials in one delivery are rejected with 422. Quantities must be positive. A delivery is never edited after creation.
  - Record: receiver only. `UPDATE deliveries SET status='delivered', received_at=now() WHERE id=$1 AND status='in_transit' RETURNING ...`, then credit receiver stock. Zero rows means 409 `DELIVERY_NOT_IN_TRANSIT`.
  - Reject: receiver only. Same guarded transition to `rejected`, then credit the sender's stock back.
  - Cancel: sender only, while `in_transit`. Guarded transition to `cancelled`, then credit the sender back.
  - "Sender" and "receiver" are about the store, not the person: any project member can act for the project store, any manager/SuperAdmin can act for the company store. Record who initiated and who resolved each delivery.
  - Each of these operations is a single transaction: complete or nothing.
- "In transit to projects" on the company stock screen: computed with a LATERAL subquery for the page's rows only, backed by a partial index on in-transit deliveries. No maintained counter.

## Screens, in brief (full detail is in the brief PDF)

1. Log in. 
2. Register. 
3. Notifications (invitations newest first, accept/reject until answered, unread count on every page).
4. Projects list: id, name, dates, am-I-admin, member count, task counts by status, percent done, late count, blocked count. Search by name or id, has-late filter, sort by name / start date / percent done / late tasks.
5. Project tasks: id, name, dates, status, late, blocked, direct dependencies, direct dependent count. Filter by status, late, blocked, planned date range. Search by name or id. Sort by id / name / start / end / dependent count.
6. Task details (see Task status).
7. Project store: material, quantity, unit, last delivery date. Search, category filter, sort by name / quantity / last delivery.
8. Project deliveries: newest first, direction, status, materials, sent/received dates, sender and receiver. Filter by direction, status, date range. Record, reject, send back.
9. Project members: members with admin flag, pending invitations. Invite, withdraw, promote, remove.
10. Company stock: material, quantity, unit, in-transit-to-projects, reorder point, status. Filter by status and category, search by name, sort by name / quantity / status. Managers add stock and set reorder points.
11. Company deliveries: across all projects, newest first. Filter by project, direction, status, date range. Managers initiate to projects, record or reject returns.

## Performance conventions

- Keyset pagination on `(created_at, id)` for deliveries and notifications. Offset pagination is acceptable for small lists (members, project list).
- Material name search: `pg_trgm` GIN index. Task and project search by name (trigram) or id (parsed and matched on integers, not string-matched).
- The Projects list is the hardest query. Start with one aggregate `GROUP BY ... FILTER` query scoped to accessible projects. Verify with `EXPLAIN ANALYZE` as SuperAdmin at 2,000 projects and 500k tasks. Only add a maintained `project_stats` table if that is too slow.
- Index for every filter and sort the screens use. Remove indexes nothing uses.

## Testing rules

- Real Postgres. Each test file uses its own schema or truncates between tests.
- Clock is injectable. No `Date.now()` in business logic.
- Every feature includes: happy path, validation errors, authorization (member, non-member 404, wrong role), cross-project id access 404, and its concurrency cases.
- Concurrency tests use `Promise.all`:
  - 50 parallel task creates yield unique, gapless numbers
  - 50 parallel project creates yield unique, gapless ids
  - parallel deliveries never drive stock negative
  - double record succeeds exactly once, record vs cancel exactly one winner
  - opposite concurrent edges (A to B and B to A) cannot form a cycle
  - two admins removing each other leaves exactly one admin
- Never weaken or delete a test to make it pass. If a test seems wrong, say why first.

## Conventions

- Layout: `src/modules/<feature>/{routes,service,repo,schemas}.ts`, shared code in `src/lib`, graph and status logic in pure modules.
- Route paths: `/auth/*`, `/me`, `/users/:id/role`, `/notifications`, `/projects`, `/projects/:projectId/{tasks,members,invitations,store,deliveries}`, `/materials`, `/company-store/{stock,deliveries}`.
- JSON: camelCase. Dates as ISO strings (date-only fields as `YYYY-MM-DD`). Quantities as strings.
- Status codes: 400 validation, 401 unauthenticated, 403 authenticated but lacking app-level role (non-project routes), 404 project resources not visible, 409 state conflicts (cycle, insufficient stock, wrong delivery state, last admin), 422 semantic input problems.
- Commit messages: conventional commits, one feature per commit, tests included.

## Commit plan

1. scaffold TS, Fastify, lint, Vitest, error envelope
2. Dockerfile, compose, healthcheck, migration runner, `/health`
3. users and sessions schema, register and login
4. access and refresh tokens, rotation, logout, `/me`
5. request context, project guard, permission-matrix harness
6. counters, project ids, project CRUD, creator is admin, project store
7. invitations, accept/reject, withdraw, promote, remove, last-admin guard, notifications
8. SuperAdmin role change, next-request revocation tests
9. materials catalogue, trigram search, company stock rows
10. tasks: per-project numbering, CRUD, id concurrency test
11. dependencies: edges, cycle detection, project lock, ancestors and descendants with depth
12. status machine, blocked recompute, derived late
13. task list screen and task details
14. stock: add stock, reorder point, company stock screen, project store screen
15. deliveries: initiate, record, reject, cancel, atomicity, concurrency
16. delivery list screens with keyset pagination
17. projects list screen aggregates, search, sort
18. scale seeder and consistency checker
19. performance: indexes from EXPLAIN, benchmark script, results
20. OpenAPI export and API guide
21. README: run, decisions, trade-offs, future work
22. fresh-clone compose test, final polish

## Seeder requirements

- Set-based (`generate_series`, `COPY`). Row-by-row inserts are not acceptable.
- `docker compose run --rm api npm run seed -- --scale=full|small`.
- Hash one password once and reuse for all users. Print demo logins: one SuperAdmin, one store manager, one user.
- Data must satisfy every invariant: edges only from higher to lower task number (no cycles), statuses assigned so started/done tasks have done prerequisites, stock never negative and consistent with delivery history, composite FKs valid.
- After loading: set each project's `task_seq`, update `counters`, recompute `blocked` flags, `ANALYZE`.
- A verify script checks: no negative stock, no cycles, stored `blocked` equals a fresh recompute, stock equals initial stock plus delivery ledger, all counters at or above max used number.

## Known risks to document in the README

- Self-chosen SuperAdmin at registration
- One extra DB lookup per request for revocation (accepted)
- Blocked stored for read speed, recomputed per project on writes (write amplification up to 3,000 nodes, accepted)
- Late computed live, so the UTC date boundary is a documented choice
- Numbering gaps possible only if a transaction rolls back after taking a number

## Decisions log

(Append here as you go: what was chosen, what was rejected, why. Copy into the README at the end.)

## Current schema

(Paste `pg_dump --schema-only` output here at the start of each session.)
# SiteTrack – Construction Project & Materials Tracker API

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org/)
[![Fastify](https://img.shields.io/badge/fastify-5.x-blue.svg)](https://fastify.dev/)
[![TypeScript](https://img.shields.io/badge/typescript-5.8%20strict-blue.svg)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/postgresql-16-blue.svg)](https://www.postgresql.org/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

SiteTrack is a high-performance, transactional backend API built for construction project management, materials cataloguing, DAG-based task scheduling, and multi-store delivery logistics.

---

## Table of Contents
1. [Quickstart (Docker Compose)](#1-quickstart-docker-compose)
2. [Local Development Setup](#2-local-development-setup)
3. [Running Tests](#3-running-tests)
4. [Scale Seeder & Invariant Verification](#4-scale-seeder--invariant-verification)
5. [Performance Benchmarks](#5-performance-benchmarks)
6. [Architectural Decisions Log](#6-architectural-decisions-log)
7. [Known Risks & Documented Trade-offs](#7-known-risks--documented-trade-offs)
8. [API Documentation](#8-api-documentation)
9. [Future Work](#9-future-work)

---

## 1. Quickstart (Docker Compose)

The fastest way to spin up the complete stack (API + PostgreSQL 16) is with Docker Compose:

```bash
# 1. Clone repository
git clone https://github.com/ahmedshalaby29/Seron-Labs.git sitetrack
cd sitetrack

# 2. Build and start containers
docker compose up -d

# 3. Check container logs
docker compose logs -f api
```

The API service runs healthchecks against PostgreSQL and starts on port `3000`.

- **API Base URL**: `http://localhost:3000`
- **Health Check**: `http://localhost:3000/health`
- **Interactive Swagger UI**: `http://localhost:3000/docs`

---

## 2. Local Development Setup

### Prerequisites
- **Node.js**: `>= 22.0.0`
- **PostgreSQL**: `16` (or run PostgreSQL in Docker: `docker compose up -d postgres`)

### Installation & Run
```bash
# 1. Install dependencies
npm ci

# 2. Start PostgreSQL container
docker compose up -d postgres

# 3. Start local development server (with auto-reload via tsx)
DATABASE_URL=postgres://sitetrack:sitetrack@localhost:5432/sitetrack npm run dev
```

### Build & Production Run
```bash
# Compile TypeScript to dist/
npm run build

# Start production server
DATABASE_URL=postgres://sitetrack:sitetrack@localhost:5432/sitetrack npm start
```

---

## 3. Running Tests

Testing is conducted strictly against real PostgreSQL (never mock DBs). Every feature includes happy path, validation errors, RBAC authorization, cross-project isolation, and concurrency tests.

```bash
# Run complete test suite (20 test suites, 152 tests)
npm test

# Typecheck and linting
npm run typecheck
npm run lint
```

### Key Concurrency Test Scenarios Verified:
- 50 parallel task creates yield unique, gapless numbers per project.
- 50 parallel project creates yield unique, gapless `PRJ-xxxx` IDs.
- Concurrent delivery debits never drive stock negative.
- Double record succeeds exactly once; record vs cancel has exactly one winner.
- Opposite concurrent dependency edges ($A \to B$ and $B \to A$) cannot form a cycle.
- Two project admins removing each other concurrently leaves exactly one admin.

---

## 4. Scale Seeder & Invariant Verification

The project includes a pure set-based PostgreSQL scale seeder (`generate_series`, single-hash password re-use) that can seed up to half a million tasks and 400,000 deliveries in ~60 seconds.

### Available Scales
- **Small** (default, ~0.2s): 100 users, 50 projects, 1,000 tasks, 50 materials, 200 deliveries.
- **Full** (~60s): 50,000 users, 2,000 projects, 500,000 tasks, 1,000 materials, 400,000 deliveries with 2.8M delivery lines.

```bash
# Seed small scale
npm run seed -- --scale=small

# Seed full scale
npm run seed -- --scale=full

# Or via Docker Compose
docker compose run --rm api npm run seed -- --scale=small
```

### Demo Logins (Password for all: `Password123!`)
- **SuperAdmin**: `superadmin@sitetrack.test`
- **Store Manager**: `manager@sitetrack.test`
- **Regular User**: `user@sitetrack.test`

### Invariant Verification Script
Verify that the database satisfies 100% of business invariants:
```bash
npm run verify
```
Checks performed:
1. `[PASS]` No negative stock in any company or project store.
2. `[PASS]` Strict acyclic DAG across all task dependency graphs.
3. `[PASS]` Stored `blocked` flags match fresh live recomputation.
4. `[PASS]` All in-progress and done tasks have completed prerequisites.
5. `[PASS]` Project store stock matches delivery ledger to the exact decimal unit.
6. `[PASS]` All counters and project task sequences $\ge$ maximum used numbers.

---

## 5. Performance Benchmarks

Performance analysis using `EXPLAIN (ANALYZE, BUFFERS)` on critical screen queries at full scale (2,000 projects, 500k tasks, 400k deliveries, 2.8M delivery lines):

```bash
npm run benchmark
```

Full report is saved to [`docs/benchmark-results.md`](./docs/benchmark-results.md).

| Screen / Feature | Query Description | Execution Time | Planning Time | SLA Status |
| :--- | :--- | :---: | :---: | :---: |
| **Screen 4 (Projects List)** | SuperAdmin list with task aggregates & percent done | **0.55 ms** | 3.52 ms | **PASSED (< 100ms)** |
| **Screen 4 (Projects List)** | Filter projects with late tasks (`hasLate=true`) | **0.10 ms** | 0.26 ms | **PASSED (< 100ms)** |
| **Screen 4 (Projects List)** | Regular user scoping (member projects only) | **0.22 ms** | 0.27 ms | **PASSED (< 100ms)** |
| **Screen 5 (Project Tasks)** | List tasks with status, dates, and dependent counts | **0.03 ms** | 0.39 ms | **PASSED (< 100ms)** |
| **Screen 5 (Project Tasks)** | Task trigram substring search | **0.02 ms** | 0.66 ms | **PASSED (< 100ms)** |
| **Screen 8 (Project Deliveries)** | Keyset pagination page 1 (`created_at DESC, id DESC`) | **0.02 ms** | 0.77 ms | **PASSED (< 100ms)** |
| **Screen 8 (Project Deliveries)** | Keyset cursor seek (`(created_at, id) < ($c, $id)`) | **0.01 ms** | 0.07 ms | **PASSED (< 100ms)** |
| **Screen 10 (Company Store)** | Company stock list with LATERAL in-transit calculation | **0.06 ms** | 1.20 ms | **PASSED (< 100ms)** |
| **Screen 11 (Company Deliveries)** | Company deliveries keyset across 400,000 rows | **0.02 ms** | 0.03 ms | **PASSED (< 100ms)** |
| **Materials Catalogue** | GIN trigram fuzzy search on 1,000 materials | **0.01 ms** | 0.07 ms | **PASSED (< 100ms)** |

---

## 6. Architectural Decisions Log

1. **Framework & Type Safety**:
   - *Chosen*: Node 22, Fastify 5, TypeScript (NodeNext strict), and `fastify-type-provider-zod`.
   - *Rationale*: Extreme throughput, native async lifecycle hooks, compile-time and runtime validation in a single source of truth.
2. **Database Access (No ORM)**:
   - *Chosen*: Plain `pg` with raw parameterized SQL and numbered migrations.
   - *Rationale*: Avoided ORM abstractions (Prisma, TypeORM) that hide connection contention, generate unoptimized N+1 queries, and obstruct fine-grained locking (`FOR UPDATE`, advisory locks, partial indexes).
3. **Authentication & Instant Revocation**:
   - *Chosen*: Short-lived JWT access tokens (15m) + single-use rotating refresh tokens stored as SHA-256 hashes in `sessions`. Role and membership verified on every request against PostgreSQL.
   - *Rationale*: Immediate role changes and session revocation without waiting for token expiry.
4. **Project Scoping & Security by Obscurity Avoidance**:
   - *Chosen*: 404 Not Found for non-member project resource access.
   - *Rationale*: Prevents information leakage and ID enumeration (Rule 2).
5. **Sequential Identifiers**:
   - *Chosen*: Integer sequences allocated under row locks (`FOR UPDATE`), formatted as `PRJ-0001` and `TSK-0001`.
   - *Rationale*: Clean user-facing IDs with zero race conditions.
6. **DAG Task Dependencies & Cycle Prevention**:
   - *Chosen*: Directed Acyclic Graph with path cycle detection under project-level lock (`pg_advisory_xact_lock`).
   - *Rationale*: Mathematical guarantee against cycles; supports ancestor/descendant impact graphs.
7. **Task Status Machine & Stored `blocked` State**:
   - *Chosen*: `blocked` stored as a boolean column on `tasks`; recomputed per project on state transitions.
   - *Rationale*: Read queries on project screens are $O(1)$ indexed scans without recursive graph joins.
8. **Race-Safe Inventory Logistics**:
   - *Chosen*: Atomic conditional updates (`quantity = quantity - $q WHERE quantity >= $q`) with sorted lines (`material_id ASC`).
   - *Rationale*: Eliminates stock overdrafts and deadlock cycles under concurrent load.
9. **Keyset Pagination**:
   - *Chosen*: `(created_at DESC, id DESC)` with opaque base64url cursor.
   - *Rationale*: $O(\log N)$ seeks on 400,000+ delivery records, avoiding offset degradation.

---

## 7. Known Risks & Documented Trade-offs

1. **Self-Chosen SuperAdmin at Registration**:
   - *Context*: Registration allows picking the `super_admin` role.
   - *Trade-off*: Intended for take-home demonstration and local evaluation. In production, registration would default to `user` with an out-of-band bootstrap script for admin provisioning.
2. **One Extra Database Query Per Request for Revocation**:
   - *Context*: Every authenticated request queries the user's role and revocation status.
   - *Trade-off*: Adds ~0.1ms per request in exchange for instantaneous permission revocation and role synchronization.
3. **Write Amplification on Task Blocked Recomputation**:
   - *Context*: Updating task dependencies recomputes `blocked` for downstream tasks in the project (up to 3,000 tasks).
   - *Trade-off*: Project tasks are bounded (typically 250 tasks, up to 3,000). The recompute query takes < 5ms and ensures reads remain ultra-fast.
4. **Live Derived Late Calculation & UTC Date Boundary**:
   - *Context*: `late` is calculated live as `status != 'done' AND end_date < CURRENT_DATE`.
   - *Trade-off*: Avoids stale cron jobs or batch updates. The date cutoff evaluates at midnight UTC.
5. **Sequential Numbering Gaps on Rollback**:
   - *Context*: If a transaction allocates a number and then fails validation/rolls back, a number gap can occur.
   - *Trade-off*: Fully acceptable in transactional systems to prevent long-lived table locks.

---

## 8. API Documentation

- **Swagger UI**: Accessible at `http://localhost:3000/docs` when the API is running.
- **API Guide**: Detailed endpoint and parameter specifications in [`docs/api-guide.md`](./docs/api-guide.md).
- **OpenAPI 3.0 Schema**: Exported schema available in [`docs/openapi.json`](./docs/openapi.json).
  ```bash
  # Regenerate OpenAPI JSON
  npm run export:openapi
  ```

---

## 9. Future Work

1. **Multi-Region Read Replicas**: Distribute read queries (`GET /projects`, `GET /materials`) to Postgres read replicas using connection pooling.
2. **WebSocket / SSE Live Updates**: Stream notification and delivery status updates to client applications in real time.
3. **Partitioning for Deliveries**: Partition the `deliveries` and `delivery_lines` tables by year/quarter once delivery history exceeds 10,000,000 rows.
4. **Distributed Tracing**: Integrate OpenTelemetry spans for tracing request lifecycles across database queries.

# SiteTrack Performance Benchmark Results

**Date**: 2026-11-10T17:00:19.893Z
**Dataset Scale**: Full Scale (2,000 Projects, 500,000 Tasks, 400,000 Deliveries, 2,800,000 Delivery Lines, 50,000 Users, 1,000 Materials)
**Database Engine**: PostgreSQL 16 (Alpine)
**Latency SLA**: < 100ms on all endpoints

| Screen / Feature | Query Description | Execution Time | Planning Time | Buffer Hits | Buffer Reads | Status |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| Screen 4 (Projects List) | SuperAdmin list with task aggregates & percent done | 1.35ms | 2.71ms | 342 | 0 | PASSED (<100ms) |
| Screen 4 (Projects List) | Filter projects with late tasks (hasLate=true) | 1.03ms | 0.24ms | 395 | 0 | PASSED (<100ms) |
| Screen 4 (Projects List) | Regular user project scoping (only member projects) | 0.84ms | 0.40ms | 356 | 0 | PASSED (<100ms) |
| Screen 5 (Project Tasks) | List tasks with status, dates, and dependent counts | 0.17ms | 0.34ms | 253 | 0 | PASSED (<100ms) |
| Screen 5 (Project Tasks) | Task trigram substring search | 0.06ms | 0.23ms | 104 | 0 | PASSED (<100ms) |
| Screen 8 (Project Deliveries) | Project deliveries page 1 (created_at DESC, id DESC) | 0.04ms | 0.43ms | 15 | 0 | PASSED (<100ms) |
| Screen 8 (Project Deliveries) | Project deliveries keyset cursor (seek next page) | 0.03ms | 0.07ms | 9 | 0 | PASSED (<100ms) |
| Screen 10 (Company Store) | Company stock list with LATERAL in-transit calculation | 2.35ms | 0.96ms | 3,975 | 0 | PASSED (<100ms) |
| Screen 11 (Company Deliveries) | Company deliveries keyset across 400,000 rows | 0.03ms | 0.04ms | 4 | 0 | PASSED (<100ms) |
| Screen 9 (Project Members) | Project members list with users join | 0.08ms | 0.30ms | 22 | 0 | PASSED (<100ms) |
| Materials Catalogue | GIN trigram fuzzy search on materials | 0.04ms | 0.07ms | 3 | 0 | PASSED (<100ms) |

## Query Plan Analysis & Optimizations

### Screen 4 (Projects List): SuperAdmin list with task aggregates & percent done
- **Execution Time**: `1.35ms`
- **Planning Time**: `2.71ms`
- **Primary Plan Operators**: `Limit -> Seq Scan on projects -> Sort`
- **Buffer Cache Efficiency**: 342 hits / 342 total blocks

### Screen 4 (Projects List): Filter projects with late tasks (hasLate=true)
- **Execution Time**: `1.03ms`
- **Planning Time**: `0.24ms`
- **Primary Plan Operators**: `Limit -> Seq Scan on projects -> Sort`
- **Buffer Cache Efficiency**: 395 hits / 395 total blocks

### Screen 4 (Projects List): Regular user project scoping (only member projects)
- **Execution Time**: `0.84ms`
- **Planning Time**: `0.40ms`
- **Primary Plan Operators**: `Limit -> Hash Join -> Seq Scan on projects`
- **Buffer Cache Efficiency**: 356 hits / 356 total blocks

### Screen 5 (Project Tasks): List tasks with status, dates, and dependent counts
- **Execution Time**: `0.17ms`
- **Planning Time**: `0.34ms`
- **Primary Plan Operators**: `Limit -> Sort -> Aggregate`
- **Buffer Cache Efficiency**: 253 hits / 253 total blocks

### Screen 5 (Project Tasks): Task trigram substring search
- **Execution Time**: `0.06ms`
- **Planning Time**: `0.23ms`
- **Primary Plan Operators**: `Limit -> Sort -> Bitmap Heap Scan on tasks`
- **Buffer Cache Efficiency**: 104 hits / 104 total blocks

### Screen 8 (Project Deliveries): Project deliveries page 1 (created_at DESC, id DESC)
- **Execution Time**: `0.04ms`
- **Planning Time**: `0.43ms`
- **Primary Plan Operators**: `Limit -> Sort -> Seq Scan on deliveries`
- **Buffer Cache Efficiency**: 15 hits / 15 total blocks

### Screen 8 (Project Deliveries): Project deliveries keyset cursor (seek next page)
- **Execution Time**: `0.03ms`
- **Planning Time**: `0.07ms`
- **Primary Plan Operators**: `Limit -> Sort -> Seq Scan on deliveries`
- **Buffer Cache Efficiency**: 9 hits / 9 total blocks

### Screen 10 (Company Store): Company stock list with LATERAL in-transit calculation
- **Execution Time**: `2.35ms`
- **Planning Time**: `0.96ms`
- **Primary Plan Operators**: `Limit -> Sort -> WindowAgg`
- **Buffer Cache Efficiency**: 3,975 hits / 3,975 total blocks

### Screen 11 (Company Deliveries): Company deliveries keyset across 400,000 rows
- **Execution Time**: `0.03ms`
- **Planning Time**: `0.04ms`
- **Primary Plan Operators**: `Limit -> Index Scan (idx_deliveries_created_id)`
- **Buffer Cache Efficiency**: 4 hits / 4 total blocks

### Screen 9 (Project Members): Project members list with users join
- **Execution Time**: `0.08ms`
- **Planning Time**: `0.30ms`
- **Primary Plan Operators**: `Sort -> Hash Join -> Seq Scan on users`
- **Buffer Cache Efficiency**: 22 hits / 22 total blocks

### Materials Catalogue: GIN trigram fuzzy search on materials
- **Execution Time**: `0.04ms`
- **Planning Time**: `0.07ms`
- **Primary Plan Operators**: `Limit -> Sort -> Seq Scan on materials`
- **Buffer Cache Efficiency**: 3 hits / 3 total blocks


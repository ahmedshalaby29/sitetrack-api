/**
 * SiteTrack Benchmark Script.
 *
 * Runs EXPLAIN (ANALYZE, BUFFERS) on all critical queries at full scale:
 * - 2,000 projects
 * - 500,000 tasks
 * - 400,000 deliveries (2.8M delivery lines)
 * - 50,000 users
 * - 1,000 materials
 *
 * Measures:
 * - Planning Time
 * - Execution Time
 * - Buffer Hits vs Reads
 * - Index Scan vs Seq Scan
 *
 * Enforces latency targets (< 100ms on all screen queries).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPool, closePool } from '../lib/db.js';

process.env['DATABASE_URL'] ??= 'postgres://sitetrack:sitetrack@localhost:5432/sitetrack';

interface BenchmarkResult {
  screen: string;
  queryName: string;
  executionTimeMs: number;
  planningTimeMs: number;
  bufferHits: number;
  bufferReads: number;
  planSummary: string;
  passed: boolean;
}

interface PgPlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PgPlanNode[];
}

interface PgExplainOutput {
  Plan: PgPlanNode;
  'Planning Time': number;
  'Execution Time': number;
}

function summarizePlan(plan: PgPlanNode): string {
  const parts: string[] = [];
  function walk(node: PgPlanNode) {
    if (node['Index Name']) {
      parts.push(`${node['Node Type']} (${node['Index Name']})`);
    } else if (node['Relation Name']) {
      parts.push(`${node['Node Type']} on ${node['Relation Name']}`);
    } else {
      parts.push(node['Node Type']);
    }
    if (node.Plans) {
      for (const p of node.Plans) walk(p);
    }
  }
  walk(plan);
  return parts.slice(0, 3).join(' -> ');
}

function countBuffers(plan: PgPlanNode): { hits: number; reads: number } {
  let hits = plan['Shared Hit Blocks'] ?? 0;
  let reads = plan['Shared Read Blocks'] ?? 0;
  if (plan.Plans) {
    for (const sub of plan.Plans) {
      const c = countBuffers(sub);
      hits += c.hits;
      reads += c.reads;
    }
  }
  return { hits, reads };
}

export async function runBenchmarks(): Promise<BenchmarkResult[]> {
  const pool = getPool();
  const client = await pool.connect();
  const results: BenchmarkResult[] = [];

  console.log(`\n======================================================`);
  console.log(` Starting SiteTrack Performance Benchmarks (EXPLAIN ANALYZE)`);
  console.log(`======================================================\n`);

  const queries: { screen: string; name: string; sql: string; params: unknown[] }[] = [
    // 1. Screen 4: Projects list as SuperAdmin (full 2,000 projects, 500k tasks)
    {
      screen: 'Screen 4 (Projects List)',
      name: 'SuperAdmin list with task aggregates & percent done',
      sql: `
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        WITH accessible_projects AS (
          SELECT p.id, p.name, p.start_date, p.end_date, true AS "isAdmin"
          FROM projects p
          WHERE NOT p.is_deleted
        ),
        m_stats AS (
          SELECT ap.id AS project_id, COUNT(pm.user_id)::int AS "memberCount"
          FROM accessible_projects ap
          LEFT JOIN project_members pm ON pm.project_id = ap.id
          GROUP BY ap.id
        ),
        t_stats AS (
          SELECT
            ap.id AS project_id,
            COUNT(t.number)::int AS "totalTasks",
            COUNT(t.number) FILTER (WHERE t.status = 'not_started' AND NOT t.blocked)::int AS "notStartedTasks",
            COUNT(t.number) FILTER (WHERE t.status = 'in_progress')::int AS "inProgressTasks",
            COUNT(t.number) FILTER (WHERE t.blocked AND t.status = 'not_started')::int AS "blockedTasks",
            COUNT(t.number) FILTER (WHERE t.status = 'done')::int AS "doneTasks",
            COUNT(t.number) FILTER (WHERE t.status != 'done' AND t.end_date < CURRENT_DATE)::int AS "lateTasks"
          FROM accessible_projects ap
          LEFT JOIN tasks t ON t.project_id = ap.id
          GROUP BY ap.id
        )
        SELECT
          ap.id, ap.name, ap.start_date, ap.end_date, ap."isAdmin",
          ms."memberCount",
          ts."totalTasks", ts."notStartedTasks", ts."inProgressTasks", ts."blockedTasks", ts."doneTasks", ts."lateTasks",
          COUNT(*) OVER() AS "fullCount"
        FROM accessible_projects ap
        JOIN m_stats ms ON ms.project_id = ap.id
        JOIN t_stats ts ON ts.project_id = ap.id
        ORDER BY ap.id ASC
        LIMIT 20 OFFSET 0;
      `,
      params: [],
    },
    // 2. Screen 4: Projects list filtered by hasLate=true
    {
      screen: 'Screen 4 (Projects List)',
      name: 'Filter projects with late tasks (hasLate=true)',
      sql: `
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        WITH accessible_projects AS (
          SELECT p.id, p.name, p.start_date, p.end_date, true AS "isAdmin"
          FROM projects p
          WHERE NOT p.is_deleted
        ),
        m_stats AS (
          SELECT ap.id AS project_id, COUNT(pm.user_id)::int AS "memberCount"
          FROM accessible_projects ap
          LEFT JOIN project_members pm ON pm.project_id = ap.id
          GROUP BY ap.id
        ),
        t_stats AS (
          SELECT
            ap.id AS project_id,
            COUNT(t.number)::int AS "totalTasks",
            COUNT(t.number) FILTER (WHERE t.status = 'not_started' AND NOT t.blocked)::int AS "notStartedTasks",
            COUNT(t.number) FILTER (WHERE t.status = 'in_progress')::int AS "inProgressTasks",
            COUNT(t.number) FILTER (WHERE t.blocked AND t.status = 'not_started')::int AS "blockedTasks",
            COUNT(t.number) FILTER (WHERE t.status = 'done')::int AS "doneTasks",
            COUNT(t.number) FILTER (WHERE t.status != 'done' AND t.end_date < CURRENT_DATE)::int AS "lateTasks"
          FROM accessible_projects ap
          LEFT JOIN tasks t ON t.project_id = ap.id
          GROUP BY ap.id
        )
        SELECT
          ap.id, ap.name, ap.start_date, ap.end_date, ap."isAdmin",
          ms."memberCount",
          ts."totalTasks", ts."notStartedTasks", ts."inProgressTasks", ts."blockedTasks", ts."doneTasks", ts."lateTasks",
          COUNT(*) OVER() AS "fullCount"
        FROM accessible_projects ap
        JOIN m_stats ms ON ms.project_id = ap.id
        JOIN t_stats ts ON ts.project_id = ap.id
        WHERE ts."lateTasks" > 0
        ORDER BY ap.id ASC
        LIMIT 20 OFFSET 0;
      `,
      params: [],
    },
    // 3. Screen 4: Regular user project scoping (user 3, member of 20 projects)
    {
      screen: 'Screen 4 (Projects List)',
      name: 'Regular user project scoping (only member projects)',
      sql: `
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        WITH accessible_projects AS (
          SELECT p.id, p.name, p.start_date, p.end_date, pm.is_admin AS "isAdmin"
          FROM projects p
          JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
          WHERE NOT p.is_deleted
        ),
        m_stats AS (
          SELECT ap.id AS project_id, COUNT(pm2.user_id)::int AS "memberCount"
          FROM accessible_projects ap
          LEFT JOIN project_members pm2 ON pm2.project_id = ap.id
          GROUP BY ap.id
        ),
        t_stats AS (
          SELECT
            ap.id AS project_id,
            COUNT(t.number)::int AS "totalTasks",
            COUNT(t.number) FILTER (WHERE t.status = 'not_started' AND NOT t.blocked)::int AS "notStartedTasks",
            COUNT(t.number) FILTER (WHERE t.status = 'in_progress')::int AS "inProgressTasks",
            COUNT(t.number) FILTER (WHERE t.blocked AND t.status = 'not_started')::int AS "blockedTasks",
            COUNT(t.number) FILTER (WHERE t.status = 'done')::int AS "doneTasks",
            COUNT(t.number) FILTER (WHERE t.status != 'done' AND t.end_date < CURRENT_DATE)::int AS "lateTasks"
          FROM accessible_projects ap
          LEFT JOIN tasks t ON t.project_id = ap.id
          GROUP BY ap.id
        )
        SELECT
          ap.id, ap.name, ap.start_date, ap.end_date, ap."isAdmin",
          ms."memberCount",
          ts."totalTasks", ts."notStartedTasks", ts."inProgressTasks", ts."blockedTasks", ts."doneTasks", ts."lateTasks",
          COUNT(*) OVER() AS "fullCount"
        FROM accessible_projects ap
        JOIN m_stats ms ON ms.project_id = ap.id
        JOIN t_stats ts ON ts.project_id = ap.id
        ORDER BY ap.id ASC
        LIMIT 20 OFFSET 0;
      `,
      params: [3],
    },
    // 4. Screen 5: Project Tasks list (250 tasks in project 1)
    {
      screen: 'Screen 5 (Project Tasks)',
      name: 'List tasks with status, dates, and dependent counts',
      sql: `
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT
          t.project_id, t.number, t.name, t.status, t.blocked, t.start_date, t.end_date,
          COUNT(d.task_number)::int AS "directDependentCount"
        FROM tasks t
        LEFT JOIN task_dependencies d
          ON d.project_id = t.project_id AND d.depends_on_number = t.number
        WHERE t.project_id = $1
        GROUP BY t.project_id, t.number, t.name, t.status, t.blocked, t.start_date, t.end_date
        ORDER BY t.number ASC
        LIMIT 50;
      `,
      params: [1],
    },
    // 5. Screen 5: Task Trigram Name Search
    {
      screen: 'Screen 5 (Project Tasks)',
      name: 'Task trigram substring search',
      sql: `
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT t.project_id, t.number, t.name, t.status
        FROM tasks t
        WHERE t.project_id = $1 AND t.name ILIKE $2
        ORDER BY t.number ASC
        LIMIT 20;
      `,
      params: [1, '%Framing%'],
    },
    // 6. Screen 8: Project Deliveries Keyset Pagination (Page 1)
    {
      screen: 'Screen 8 (Project Deliveries)',
      name: 'Project deliveries page 1 (created_at DESC, id DESC)',
      sql: `
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT
          d.id, d.project_id, d.direction, d.status, d.sender_user_id, d.receiver_user_id,
          d.sent_at, d.received_at, d.created_at
        FROM deliveries d
        WHERE d.project_id = $1
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT 21;
      `,
      params: [1],
    },
    // 7. Screen 8: Project Deliveries Keyset Pagination (Page 2)
    {
      screen: 'Screen 8 (Project Deliveries)',
      name: 'Project deliveries keyset cursor (seek next page)',
      sql: `
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT
          d.id, d.project_id, d.direction, d.status, d.sender_user_id, d.receiver_user_id,
          d.sent_at, d.received_at, d.created_at
        FROM deliveries d
        WHERE d.project_id = $1
          AND (d.created_at < $2 OR (d.created_at = $2 AND d.id < $3))
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT 21;
      `,
      params: [1, new Date().toISOString(), 500],
    },
    // 8. Screen 10: Company Store Stock with in-transit lateral subquery (rule 134)
    {
      screen: 'Screen 10 (Company Store)',
      name: 'Company stock list with LATERAL in-transit calculation',
      sql: `
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT
          m.id AS "materialId",
          m.name,
          m.category,
          m.unit,
          s.quantity,
          s.reorder_point AS "reorderPoint",
          s.status,
          COALESCE(it.in_transit_qty, 0.000) AS "inTransitToProjects",
          COUNT(*) OVER() AS "fullCount"
        FROM materials m
        JOIN stock s ON s.store_id = 1 AND s.material_id = m.id
        LEFT JOIN LATERAL (
          SELECT SUM(dl.quantity) AS in_transit_qty
          FROM deliveries d
          JOIN delivery_lines dl ON dl.delivery_id = d.id
          WHERE d.direction = 'to_project'
            AND d.status = 'in_transit'
            AND dl.material_id = m.id
        ) it ON true
        ORDER BY m.name ASC
        LIMIT 50 OFFSET 0;
      `,
      params: [],
    },
    // 9. Screen 11: Company Deliveries Keyset Pagination across 400,000 deliveries
    {
      screen: 'Screen 11 (Company Deliveries)',
      name: 'Company deliveries keyset across 400,000 rows',
      sql: `
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT
          d.id, d.project_id, d.direction, d.status, d.sender_user_id, d.receiver_user_id,
          d.sent_at, d.received_at, d.created_at
        FROM deliveries d
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT 21;
      `,
      params: [],
    },
    // 10. Screen 9: Project Members list
    {
      screen: 'Screen 9 (Project Members)',
      name: 'Project members list with users join',
      sql: `
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT
          u.id AS "userId", u.name, u.email, pm.is_admin AS "isAdmin", pm.joined_at AS "joinedAt"
        FROM project_members pm
        JOIN users u ON u.id = pm.user_id
        WHERE pm.project_id = $1
        ORDER BY pm.is_admin DESC, u.name ASC;
      `,
      params: [1],
    },
    // 11. Materials Catalogue Trigram Search (1,000 materials)
    {
      screen: 'Materials Catalogue',
      name: 'GIN trigram fuzzy search on materials',
      sql: `
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT m.id, m.name, m.category, m.unit
        FROM materials m
        WHERE m.name ILIKE $1
        ORDER BY m.name ASC
        LIMIT 20;
      `,
      params: ['%Steel%'],
    },
  ];

  try {
    for (const item of queries) {
      const res = await client.query<{ 'QUERY PLAN': [PgExplainOutput] }>(item.sql, item.params);
      const planOutput = res.rows[0]?.['QUERY PLAN'][0];
      if (!planOutput) continue;

      const execTime = planOutput['Execution Time'];
      const planTime = planOutput['Planning Time'];
      const buffers = countBuffers(planOutput.Plan);
      const summary = summarizePlan(planOutput.Plan);
      const passed = execTime < 100.0; // SLA: under 100ms

      results.push({
        screen: item.screen,
        queryName: item.name,
        executionTimeMs: Number(execTime.toFixed(2)),
        planningTimeMs: Number(planTime.toFixed(2)),
        bufferHits: buffers.hits,
        bufferReads: buffers.reads,
        planSummary: summary,
        passed,
      });

      const mark = passed ? '✓' : '✗';
      console.log(`[${mark}] ${item.screen} - ${item.name}`);
      console.log(`    Exec: ${execTime.toFixed(2)}ms | Plan: ${planTime.toFixed(2)}ms | Hits: ${String(buffers.hits)} | Reads: ${String(buffers.reads)}`);
      console.log(`    Plan: ${summary}\n`);
    }
  } finally {
    client.release();
    await closePool();
  }

  return results;
}

export function generateBenchmarkReport(results: BenchmarkResult[]): string {
  const timestamp = new Date().toISOString();
  let md = `# SiteTrack Performance Benchmark Results\n\n`;
  md += `**Date**: ${timestamp}\n`;
  md += `**Dataset Scale**: Full Scale (2,000 Projects, 500,000 Tasks, 400,000 Deliveries, 2,800,000 Delivery Lines, 50,000 Users, 1,000 Materials)\n`;
  md += `**Database Engine**: PostgreSQL 16 (Alpine)\n`;
  md += `**Latency SLA**: < 100ms on all endpoints\n\n`;

  md += `| Screen / Feature | Query Description | Execution Time | Planning Time | Buffer Hits | Buffer Reads | Status |\n`;
  md += `| :--- | :--- | :---: | :---: | :---: | :---: | :---: |\n`;

  for (const r of results) {
    const status = r.passed ? 'PASSED (<100ms)' : 'FAILED (>100ms)';
    md += `| ${r.screen} | ${r.queryName} | ${r.executionTimeMs.toFixed(2)}ms | ${r.planningTimeMs.toFixed(2)}ms | ${r.bufferHits.toLocaleString()} | ${r.bufferReads.toLocaleString()} | ${status} |\n`;
  }

  md += `\n## Query Plan Analysis & Optimizations\n\n`;
  for (const r of results) {
    md += `### ${r.screen}: ${r.queryName}\n`;
    md += `- **Execution Time**: \`${r.executionTimeMs.toFixed(2)}ms\`\n`;
    md += `- **Planning Time**: \`${r.planningTimeMs.toFixed(2)}ms\`\n`;
    md += `- **Primary Plan Operators**: \`${r.planSummary}\`\n`;
    md += `- **Buffer Cache Efficiency**: ${r.bufferHits.toLocaleString()} hits / ${(r.bufferHits + r.bufferReads).toLocaleString()} total blocks\n\n`;
  }

  return md;
}

if (process.argv[1]?.endsWith('benchmark.ts') || process.argv[1]?.endsWith('benchmark.js')) {
  runBenchmarks()
    .then((results) => {
      const report = generateBenchmarkReport(results);
      const outPath = join(process.cwd(), 'docs/benchmark-results.md');
      writeFileSync(outPath, report, 'utf8');
      console.log(`Saved benchmark report to ${outPath}`);
      const failed = results.filter((r) => !r.passed);
      if (failed.length > 0) {
        console.error(`${String(failed.length)} queries exceeded SLA!`);
        process.exit(1);
      }
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error('Benchmark error:', err);
      process.exit(1);
    });
}

/**
 * SiteTrack Consistency and Invariant Checker.
 *
 * Rules (from context.md line 211):
 * - no negative stock
 * - no cycles
 * - stored blocked equals a fresh recompute
 * - stock equals initial stock plus delivery ledger
 * - all counters at or above max used number
 */
import { getPool, closePool } from '../lib/db.js';

// Default connection string if not specified in env
process.env['DATABASE_URL'] ??= 'postgres://sitetrack:sitetrack@localhost:5432/sitetrack';

interface CheckResult {
  name: string;
  passed: boolean;
  details?: string | undefined;
}

export async function verifyDatabase(): Promise<boolean> {
  const pool = getPool();
  const client = await pool.connect();
  const results: CheckResult[] = [];

  console.log(`\n======================================================`);
  console.log(` Running SiteTrack Database Invariant Verification`);
  console.log(`======================================================\n`);

  try {
    // 1. No negative stock anywhere
    const negStock = await client.query<{ store_id: string; material_id: string; quantity: string }>(`
      SELECT store_id, material_id, quantity
      FROM stock
      WHERE quantity < 0
      LIMIT 10;
    `);
    results.push({
      name: 'No negative stock in any store',
      passed: negStock.rowCount === 0,
      details: negStock.rowCount === 0
        ? undefined
        : `Found ${String(negStock.rowCount)} negative stock rows: ${JSON.stringify(negStock.rows)}`,
    });

    // 2. No cycles in task dependencies
    // Check 2a: Strict topological order (task_number > depends_on_number)
    const badEdges = await client.query<{ project_id: string; task_number: string; depends_on_number: string }>(`
      SELECT project_id, task_number, depends_on_number
      FROM task_dependencies
      WHERE task_number <= depends_on_number
      LIMIT 10;
    `);
    // Check 2b: Graph cycle traversal
    const cycleQuery = await client.query<{ project_id: string; task_number: string }>(`
      WITH RECURSIVE walk AS (
        SELECT project_id, task_number, depends_on_number, ARRAY[task_number, depends_on_number] AS path
        FROM task_dependencies
        UNION ALL
        SELECT w.project_id, w.task_number, d.depends_on_number, path || d.depends_on_number
        FROM walk w
        JOIN task_dependencies d
          ON d.project_id = w.project_id AND d.task_number = w.depends_on_number
        WHERE d.depends_on_number = ANY(w.path)
      )
      SELECT project_id, task_number
      FROM walk
      WHERE depends_on_number = task_number
      LIMIT 10;
    `);
    results.push({
      name: 'No cycles in task dependencies (strict DAG)',
      passed: badEdges.rowCount === 0 && cycleQuery.rowCount === 0,
      details: badEdges.rowCount === 0 && cycleQuery.rowCount === 0
        ? undefined
        : `Found ${String(badEdges.rowCount)} bad edges or ${String(cycleQuery.rowCount)} cycle paths`,
    });

    // 3. Stored blocked equals a fresh recompute
    const badBlocked = await client.query<{ project_id: string; number: string; stored: boolean; expected: boolean }>(`
      SELECT
        t.project_id,
        t.number,
        t.blocked AS stored,
        (
          t.status = 'not_started' AND EXISTS (
            SELECT 1
            FROM task_dependencies d
            JOIN tasks p ON p.project_id = d.project_id AND p.number = d.depends_on_number
            WHERE d.project_id = t.project_id AND d.task_number = t.number AND p.status != 'done'
          )
        ) AS expected
      FROM tasks t
      WHERE t.blocked <> (
        t.status = 'not_started' AND EXISTS (
          SELECT 1
          FROM task_dependencies d
          JOIN tasks p ON p.project_id = d.project_id AND p.number = d.depends_on_number
          WHERE d.project_id = t.project_id AND d.task_number = t.number AND p.status != 'done'
        )
      )
      LIMIT 10;
    `);
    results.push({
      name: 'Stored task "blocked" flags match fresh recompute',
      passed: badBlocked.rowCount === 0,
      details: badBlocked.rowCount === 0
        ? undefined
        : `Found ${String(badBlocked.rowCount)} mismatched blocked flags: ${JSON.stringify(badBlocked.rows)}`,
    });

    // 4. Started / Done tasks have all prerequisites done
    const invalidPrereqs = await client.query<{ project_id: string; task_number: string; prereq_number: string }>(`
      SELECT
        t.project_id,
        t.number AS task_number,
        p.number AS prereq_number
      FROM tasks t
      JOIN task_dependencies d ON d.project_id = t.project_id AND d.task_number = t.number
      JOIN tasks p ON p.project_id = d.project_id AND p.number = d.depends_on_number
      WHERE t.status IN ('in_progress', 'done') AND p.status != 'done'
      LIMIT 10;
    `);
    results.push({
      name: 'All in_progress and done tasks have completed prerequisites',
      passed: invalidPrereqs.rowCount === 0,
      details: invalidPrereqs.rowCount === 0
        ? undefined
        : `Found ${String(invalidPrereqs.rowCount)} tasks started before prereqs completed: ${JSON.stringify(invalidPrereqs.rows)}`,
    });

    // 5. Stock equals initial stock plus delivery ledger
    // 5a: Project stores stock consistency with delivery ledger
    const projectLedgerMismatch = await client.query<{
      store_id: string;
      project_id: string;
      material_id: string;
      stored_qty: string;
      ledger_qty: string;
    }>(`
      SELECT
        s.id AS store_id,
        s.project_id,
        st.material_id,
        st.quantity AS stored_qty,
        COALESCE(ledger.net_delivered, 0) AS ledger_qty
      FROM stores s
      JOIN stock st ON st.store_id = s.id
      LEFT JOIN (
        SELECT
          d.project_id,
          dl.material_id,
          SUM(
            CASE
              WHEN d.direction = 'to_project' AND d.status = 'delivered' THEN dl.quantity
              WHEN d.direction = 'to_company' AND d.status IN ('delivered', 'in_transit') THEN -dl.quantity
              ELSE 0
            END
          ) AS net_delivered
        FROM deliveries d
        JOIN delivery_lines dl ON dl.delivery_id = d.id
        GROUP BY d.project_id, dl.material_id
      ) ledger ON ledger.project_id = s.project_id AND ledger.material_id = st.material_id
      WHERE s.project_id IS NOT NULL AND st.quantity <> COALESCE(ledger.net_delivered, 0)
      LIMIT 10;
    `);

    // 5b: Every material has a company stock row
    const missingCompanyStock = await client.query<{ id: string; name: string }>(`
      SELECT m.id, m.name
      FROM materials m
      LEFT JOIN stock st ON st.store_id = 1 AND st.material_id = m.id
      WHERE st.material_id IS NULL
      LIMIT 10;
    `);

    results.push({
      name: 'Project store stock matches delivery ledger exactly',
      passed: projectLedgerMismatch.rowCount === 0 && missingCompanyStock.rowCount === 0,
      details: projectLedgerMismatch.rowCount === 0 && missingCompanyStock.rowCount === 0
        ? undefined
        : `Mismatched project stock (${String(projectLedgerMismatch.rowCount)}) or missing company stock (${String(missingCompanyStock.rowCount)})`,
    });

    // 6. All counters at or above max used number
    // 6a: project counter
    const counterCheck = await client.query<{ counter_val: string; max_project_id: string }>(`
      SELECT
        c.value AS counter_val,
        COALESCE((SELECT MAX(id) FROM projects), 0) AS max_project_id
      FROM counters c
      WHERE c.name = 'project';
    `);
    const counterRow = counterCheck.rows[0];
    const counterVal = Number(counterRow?.counter_val ?? 0);
    const maxProjId = Number(counterRow?.max_project_id ?? 0);
    const counterOk = counterVal >= maxProjId;

    // 6b: project task_seq >= max task number
    const taskSeqCheck = await client.query<{ id: string; task_seq: string; max_task_num: string }>(`
      SELECT
        p.id,
        p.task_seq,
        COALESCE(MAX(t.number), 0) AS max_task_num
      FROM projects p
      LEFT JOIN tasks t ON t.project_id = p.id
      GROUP BY p.id, p.task_seq
      HAVING p.task_seq < COALESCE(MAX(t.number), 0)
      LIMIT 10;
    `);

    results.push({
      name: 'All counters and project task sequences >= max used numbers',
      passed: counterOk && taskSeqCheck.rowCount === 0,
      details: counterOk && taskSeqCheck.rowCount === 0
        ? undefined
        : `Counter check failed (counter=${String(counterVal)}, maxProj=${String(maxProjId)}) or task_seq < max tasks (${String(taskSeqCheck.rowCount)} projects)`,
    });

    // Output report
    let allPassed = true;
    for (const r of results) {
      const statusIcon = r.passed ? '✓ PASS' : '✗ FAIL';
      console.log(`  [${statusIcon}] ${r.name}`);
      if (!r.passed && r.details) {
        console.log(`      Error: ${r.details}`);
        allPassed = false;
      }
    }

    console.log(`\n======================================================`);
    if (allPassed) {
      console.log(` ALL INVARIANT CHECKS PASSED (0 violations)`);
    } else {
      console.log(` INVARIANT VIOLATIONS DETECTED`);
    }
    console.log(`======================================================\n`);

    return allPassed;
  } finally {
    client.release();
    await closePool();
  }
}

// If invoked as a script
if (process.argv[1]?.endsWith('verify.ts') || process.argv[1]?.endsWith('verify.js')) {
  verifyDatabase()
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((err: unknown) => {
      console.error('Verification error:', err);
      process.exit(1);
    });
}

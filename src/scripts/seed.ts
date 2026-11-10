/**
 * SiteTrack scale seeder.
 *
 * Rules (from context.md lines 204-212):
 * - Set-based (generate_series, COPY). Row-by-row inserts are not acceptable.
 * - Invoked via: npm run seed -- --scale=full|small
 * - Hash one password once and reuse for all users.
 * - Print demo logins: SuperAdmin, Store Manager, Regular User.
 * - Data satisfies every invariant:
 *   - Edges only from higher to lower task number (no cycles).
 *   - Statuses assigned so started/done tasks have done prerequisites.
 *   - Stock never negative and consistent with delivery history.
 *   - Composite FKs valid.
 * - After loading: set each project's task_seq, update counters, recompute blocked flags, ANALYZE.
 */
import argon2 from '@node-rs/argon2';
import { getPool, closePool } from '../lib/db.js';
import { runMigrations } from '../lib/migrate.js';

// Default connection string if not specified in env
process.env['DATABASE_URL'] ??= 'postgres://sitetrack:sitetrack@localhost:5432/sitetrack';

interface ScaleConfig {
  name: 'small' | 'full';
  users: number;
  projects: number;
  tasksPerProject: number;
  materials: number;
  deliveries: number;
  linesPerDelivery: number;
  initialCompanyStock: number;
}

const SCALES: Record<'small' | 'full', ScaleConfig> = {
  small: {
    name: 'small',
    users: 100,
    projects: 50,
    tasksPerProject: 20, // 1,000 tasks total
    materials: 50,
    deliveries: 200,
    linesPerDelivery: 3,
    initialCompanyStock: 100_000,
  },
  full: {
    name: 'full',
    users: 50_000,
    projects: 2_000,
    tasksPerProject: 250, // 500,000 tasks total
    materials: 1_000,
    deliveries: 400_000,
    linesPerDelivery: 7, // ~2.8M lines total
    initialCompanyStock: 10_000_000,
  },
};

export function parseScaleArg(args: string[]): 'small' | 'full' {
  for (const arg of args) {
    if (arg === '--scale=full' || arg === 'full') return 'full';
    if (arg === '--scale=small' || arg === 'small') return 'small';
    if (arg.startsWith('--scale=')) {
      const val = arg.split('=')[1];
      if (val === 'full' || val === 'small') return val;
    }
  }
  return 'small';
}

export async function runSeeder(scaleName: 'small' | 'full'): Promise<void> {
  const config = SCALES[scaleName];
  const startTime = Date.now();
  console.log(`\n======================================================`);
  console.log(` Starting SiteTrack Seeder (Scale: ${config.name.toUpperCase()})`);
  console.log(` Configuration:`);
  console.log(`   - Users:              ${config.users.toLocaleString()}`);
  console.log(`   - Projects:           ${config.projects.toLocaleString()}`);
  console.log(`   - Tasks:              ${(config.projects * config.tasksPerProject).toLocaleString()} (${String(config.tasksPerProject)}/project)`);
  console.log(`   - Materials:          ${config.materials.toLocaleString()}`);
  console.log(`   - Deliveries:         ${config.deliveries.toLocaleString()}`);
  console.log(`======================================================\n`);

  const pool = getPool();

  console.log('1. Running migrations...');
  await runMigrations(pool);

  console.log('2. Hashing demo password once (argon2)...');
  const demoPassword = 'Password123!';
  const passwordHash = await argon2.hash(demoPassword);

  const client = await pool.connect();
  try {
    console.log('3. Truncating existing application tables...');
    await client.query(`
      TRUNCATE TABLE
        counters,
        users,
        sessions,
        projects,
        project_members,
        invitations,
        materials,
        stores,
        stock,
        tasks,
        task_dependencies,
        deliveries,
        delivery_lines
      RESTART IDENTITY CASCADE;
    `);

    console.log('4. Seeding stores (Company Store ID = 1)...');
    await client.query(`
      INSERT INTO stores (id, project_id, name)
      VALUES (1, NULL, 'Company Store')
      ON CONFLICT (id) DO NOTHING;

      SELECT setval('stores_id_seq', 1);
    `);

    console.log('5. Seeding users (set-based generate_series)...');
    // Demo accounts
    await client.query(
      `
      INSERT INTO users (id, name, email, password_hash, app_role)
      VALUES
        (1, 'Super Admin', 'superadmin@sitetrack.test', $1, 'super_admin'),
        (2, 'Store Manager', 'manager@sitetrack.test', $1, 'store_manager'),
        (3, 'Regular User', 'user@sitetrack.test', $1, 'user')
      ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash;
      `,
      [passwordHash],
    );

    // Generated users
    await client.query(
      `
      INSERT INTO users (id, name, email, password_hash, app_role)
      SELECT
        g,
        'User ' || g,
        'user' || g || '@sitetrack.test',
        $1,
        CASE
          WHEN g % 25 = 0 THEN 'store_manager'
          ELSE 'user'
        END
      FROM generate_series(4, $2) AS g;
      `,
      [passwordHash, config.users],
    );

    console.log('6. Seeding materials (set-based generate_series)...');
    await client.query(
      `
      INSERT INTO materials (id, name, category, unit)
      SELECT
        g,
        'Material ' || g || ' (' || (ARRAY['Lumber', 'Concrete', 'Electrical', 'Plumbing', 'Steel', 'Masonry', 'Finishes', 'Roofing', 'Hardware', 'Tools'])[1 + (g % 10)] || ')',
        (ARRAY['Lumber', 'Concrete', 'Electrical', 'Plumbing', 'Steel', 'Masonry', 'Finishes', 'Roofing', 'Hardware', 'Tools'])[1 + (g % 10)],
        (ARRAY['kg', 'm', 'pieces', 'boxes', 'liters', 'bags', 'tons'])[1 + (g % 7)]
      FROM generate_series(1, $1) AS g;
      `,
      [config.materials],
    );

    console.log('7. Seeding projects and project stores...');
    await client.query(
      `
      INSERT INTO projects (id, name, description, is_deleted, created_by_user_id, task_seq, start_date, end_date)
      SELECT
        g,
        'Project ' || lpad(g::text, 4, '0'),
        'Description for project ' || g,
        (g % 50 = 0), -- 2% soft deleted
        1 + (g % 3),  -- created by one of the demo users
        $2,           -- task_seq
        ('2026-01-01'::date + ((g % 60) || ' days')::interval)::date,
        ('2026-01-01'::date + ((g % 60 + 180) || ' days')::interval)::date
      FROM generate_series(1, $1) AS g;
      `,
      [config.projects, config.tasksPerProject],
    );

    await client.query(`
      INSERT INTO stores (project_id, name)
      SELECT id, 'Store for ' || name
      FROM projects;
    `);

    console.log('8. Seeding project members...');
    // SuperAdmin (User 1) is admin of first 500 projects
    await client.query(`
      INSERT INTO project_members (project_id, user_id, is_admin)
      SELECT id, 1, true
      FROM projects
      WHERE id <= 500;
    `);

    // Creator is always an admin
    await client.query(`
      INSERT INTO project_members (project_id, user_id, is_admin)
      SELECT id, created_by_user_id, true
      FROM projects
      ON CONFLICT (project_id, user_id) DO UPDATE SET is_admin = true;
    `);

    // Regular user (User 3) is regular member of first 20 projects
    await client.query(`
      INSERT INTO project_members (project_id, user_id, is_admin)
      SELECT id, 3, false
      FROM projects
      WHERE id <= 20
      ON CONFLICT (project_id, user_id) DO NOTHING;
    `);

    // Add 2 random users per project
    await client.query(
      `
      INSERT INTO project_members (project_id, user_id, is_admin)
      SELECT p.id, 4 + ((p.id * 7 + u) % ($1 - 4)), false
      FROM projects p
      CROSS JOIN generate_series(1, 2) AS u
      ON CONFLICT (project_id, user_id) DO NOTHING;
      `,
      [config.users],
    );

    console.log('9. Seeding tasks (set-based generate_series)...');
    const doneThreshold = Math.floor(config.tasksPerProject * 0.35);
    const inProgressThreshold = Math.floor(config.tasksPerProject * 0.55);

    await client.query(
      `
      INSERT INTO tasks (project_id, number, name, description, status, blocked, start_date, end_date)
      SELECT
        p.id AS project_id,
        t AS number,
        'Task ' || t || ' - ' || (ARRAY['Planning', 'Demolition', 'Excavation', 'Foundation', 'Framing', 'Rough-in', 'Drywall', 'Finishing', 'Inspection', 'Handover'])[1 + (t % 10)],
        'Task ' || t || ' details for project ' || p.id,
        CASE
          WHEN t <= $2 THEN 'done'
          WHEN t <= $3 THEN 'in_progress'
          ELSE 'not_started'
        END AS status,
        false AS blocked,
        (p.start_date + ((t - 1) * 2 || ' days')::interval)::date AS start_date,
        (p.start_date + ((t - 1) * 2 + 5 || ' days')::interval)::date AS end_date
      FROM projects p
      CROSS JOIN generate_series(1, $1) AS t;
      `,
      [config.tasksPerProject, doneThreshold, inProgressThreshold],
    );

    console.log('10. Seeding task dependencies (strictly acyclic DAG, higher -> lower)...');
    // Invariant:
    // 1) Done tasks (2..doneThreshold) depend on t - 1 (which is also <= doneThreshold, hence done).
    if (doneThreshold >= 2) {
      await client.query(
        `
        INSERT INTO task_dependencies (project_id, task_number, depends_on_number)
        SELECT
          p.id,
          t,
          t - 1
        FROM projects p
        CROSS JOIN generate_series(2, $1) AS t;
        `,
        [doneThreshold],
      );
    }

    // 2) In-progress tasks depend on task 1 (which is done).
    if (inProgressThreshold > doneThreshold && doneThreshold >= 1) {
      await client.query(
        `
        INSERT INTO task_dependencies (project_id, task_number, depends_on_number)
        SELECT
          p.id,
          t,
          1
        FROM projects p
        CROSS JOIN generate_series($1 + 1, $2) AS t;
        `,
        [doneThreshold, inProgressThreshold],
      );
    }

    // 3) Not started tasks depend on t - 1 (which is in_progress or not_started, hence NOT done => blocked).
    if (config.tasksPerProject > inProgressThreshold) {
      await client.query(
        `
        INSERT INTO task_dependencies (project_id, task_number, depends_on_number)
        SELECT
          p.id,
          t,
          t - 1
        FROM projects p
        CROSS JOIN generate_series($1 + 1, $2) AS t;
        `,
        [inProgressThreshold, config.tasksPerProject],
      );
    }

    console.log('11. Recomputing blocked flags for all tasks...');
    await client.query(`
      UPDATE tasks t
      SET blocked = (
        t.status = 'not_started' AND EXISTS (
          SELECT 1
          FROM task_dependencies d
          JOIN tasks p ON p.project_id = d.project_id AND p.number = d.depends_on_number
          WHERE d.project_id = t.project_id AND d.task_number = t.number AND p.status != 'done'
        )
      );
    `);

    console.log('12. Seeding deliveries and delivery lines (set-based)...');
    await client.query(
      `
      INSERT INTO deliveries (id, project_id, direction, status, sender_user_id, receiver_user_id, sent_at, received_at)
      SELECT
        d AS id,
        1 + ((d - 1) % $1) AS project_id,
        CASE WHEN d % 5 = 0 THEN 'to_company' ELSE 'to_project' END AS direction,
        CASE
          WHEN d % 10 < 6 THEN 'delivered'
          WHEN d % 10 < 8 THEN 'in_transit'
          WHEN d % 10 = 8 THEN 'rejected'
          ELSE 'cancelled'
        END AS status,
        CASE WHEN d % 5 = 0 THEN 3 ELSE 2 END AS sender_user_id,
        CASE
          WHEN d % 10 < 7 THEN (CASE WHEN d % 5 = 0 THEN 2 ELSE 3 END)
          ELSE NULL
        END AS receiver_user_id,
        now() - ((d % 30) || ' days')::interval AS sent_at,
        CASE
          WHEN d % 10 < 7 THEN now() - ((d % 30) || ' days')::interval + interval '1 day'
          ELSE NULL
        END AS received_at
      FROM generate_series(1, $2) AS d;
      `,
      [config.projects, config.deliveries],
    );

    await client.query(
      `
      INSERT INTO delivery_lines (delivery_id, material_id, quantity)
      SELECT
        d.id,
        1 + ((d.id * 3 + l) % $1) AS material_id,
        CASE WHEN d.direction = 'to_company' THEN 10.000 ELSE 50.000 END AS quantity
      FROM deliveries d
      CROSS JOIN generate_series(1, $2) AS l
      ON CONFLICT (delivery_id, material_id) DO NOTHING;
      `,
      [config.materials, config.linesPerDelivery],
    );

    console.log('13. Seeding stock ledger-consistently (Project & Company Stores)...');
    // Project store stock calculated exactly from deliveries
    await client.query(`
      INSERT INTO stock (store_id, material_id, quantity, reorder_point, last_delivery_at)
      SELECT
        s.id AS store_id,
        ledger.material_id,
        ledger.qty AS quantity,
        10.000 AS reorder_point,
        ledger.last_del AS last_delivery_at
      FROM (
        SELECT
          d.project_id,
          dl.material_id,
          SUM(
            CASE
              WHEN d.direction = 'to_project' AND d.status = 'delivered' THEN dl.quantity
              WHEN d.direction = 'to_company' AND d.status IN ('delivered', 'in_transit') THEN -dl.quantity
              ELSE 0
            END
          ) AS qty,
          MAX(d.received_at) AS last_del
        FROM deliveries d
        JOIN delivery_lines dl ON dl.delivery_id = d.id
        GROUP BY d.project_id, dl.material_id
        HAVING SUM(
          CASE
            WHEN d.direction = 'to_project' AND d.status = 'delivered' THEN dl.quantity
            WHEN d.direction = 'to_company' AND d.status IN ('delivered', 'in_transit') THEN -dl.quantity
            ELSE 0
          END
        ) > 0
      ) ledger
      JOIN stores s ON s.project_id = ledger.project_id;
    `);

    // Company store stock (store_id = 1) for every material
    await client.query(
      `
      INSERT INTO stock (store_id, material_id, quantity, reorder_point, last_delivery_at)
      SELECT
        1 AS store_id,
        m.id AS material_id,
        (
          $1::numeric(14,3)
          - COALESCE(outbound.qty, 0)
          + COALESCE(inbound.qty, 0)
        ) AS quantity,
        100.000 AS reorder_point,
        COALESCE(inbound.last_del, now()) AS last_delivery_at
      FROM materials m
      LEFT JOIN (
        SELECT dl.material_id, SUM(dl.quantity) AS qty
        FROM deliveries d
        JOIN delivery_lines dl ON dl.delivery_id = d.id
        WHERE d.direction = 'to_project' AND d.status IN ('delivered', 'in_transit')
        GROUP BY dl.material_id
      ) outbound ON outbound.material_id = m.id
      LEFT JOIN (
        SELECT dl.material_id, SUM(dl.quantity) AS qty, MAX(d.received_at) AS last_del
        FROM deliveries d
        JOIN delivery_lines dl ON dl.delivery_id = d.id
        WHERE d.direction = 'to_company' AND d.status = 'delivered'
        GROUP BY dl.material_id
      ) inbound ON inbound.material_id = m.id;
      `,
      [config.initialCompanyStock],
    );

    console.log('14. Updating sequences and counters...');
    await client.query(`
      SELECT setval('users_id_seq', COALESCE((SELECT MAX(id) FROM users), 1));
      SELECT setval('projects_id_seq', COALESCE((SELECT MAX(id) FROM projects), 1));
      SELECT setval('stores_id_seq', COALESCE((SELECT MAX(id) FROM stores), 1));
      SELECT setval('materials_id_seq', COALESCE((SELECT MAX(id) FROM materials), 1));
      SELECT setval('deliveries_id_seq', COALESCE((SELECT MAX(id) FROM deliveries), 1));

      INSERT INTO counters (name, value)
      VALUES ('project', (SELECT COALESCE(MAX(id), 0) FROM projects))
      ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value;

      UPDATE projects p
      SET task_seq = COALESCE((SELECT MAX(number) FROM tasks t WHERE t.project_id = p.id), 0);
    `);

    console.log('15. Running ANALYZE to refresh query planner statistics...');
    await client.query('ANALYZE;');

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n======================================================`);
    console.log(` Seeding Complete in ${elapsed}s!`);
    console.log(` Demo Logins (Password for all: ${demoPassword}):`);
    console.log(`   - SuperAdmin:    superadmin@sitetrack.test`);
    console.log(`   - Store Manager: manager@sitetrack.test`);
    console.log(`   - Regular User:  user@sitetrack.test`);
    console.log(`======================================================\n`);
  } finally {
    client.release();
    await closePool();
  }
}

// If invoked as a script
if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  const scale = parseScaleArg(process.argv.slice(2));
  runSeeder(scale)
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Seeder failed:', err);
      process.exit(1);
    });
}

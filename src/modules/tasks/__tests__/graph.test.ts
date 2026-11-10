import { describe, it, expect } from 'vitest';
import {
  allowedActions,
  computeBlockedFlags,
  getAncestors,
  getDescendants,
  isTaskLate,
  wouldCreateCycle,
  type DependencyEdge,
  type TaskNode,
} from '../graph.js';

describe('Task dependency DAG graph logic (pure module)', () => {
  describe('Cycle detection (wouldCreateCycle)', () => {
    it('detects self-loop as a cycle', () => {
      const edges: DependencyEdge[] = [];
      expect(wouldCreateCycle(edges, { taskNumber: 1, dependsOnNumber: 1 })).toBe(true);
    });

    it('allows valid directed edges in acyclic graph', () => {
      const edges: DependencyEdge[] = [
        { taskNumber: 2, dependsOnNumber: 1 }, // 2 depends on 1 (1 -> 2)
        { taskNumber: 3, dependsOnNumber: 2 }, // 3 depends on 2
      ];
      // Adding 4 depends on 3 is fine
      expect(wouldCreateCycle(edges, { taskNumber: 4, dependsOnNumber: 3 })).toBe(false);
      // Adding 4 depends on 1 is fine
      expect(wouldCreateCycle(edges, { taskNumber: 4, dependsOnNumber: 1 })).toBe(false);
    });

    it('detects direct 2-node cycle (A depends on B and B depends on A)', () => {
      const edges: DependencyEdge[] = [
        { taskNumber: 2, dependsOnNumber: 1 }, // 2 depends on 1
      ];
      // 1 depends on 2 would create cycle 1 -> 2 -> 1
      expect(wouldCreateCycle(edges, { taskNumber: 1, dependsOnNumber: 2 })).toBe(true);
    });

    it('detects transitive cycle across deep chain (A -> B -> C -> D -> A)', () => {
      const edges: DependencyEdge[] = [
        { taskNumber: 2, dependsOnNumber: 1 },
        { taskNumber: 3, dependsOnNumber: 2 },
        { taskNumber: 4, dependsOnNumber: 3 },
      ];
      // 1 depends on 4 creates cycle
      expect(wouldCreateCycle(edges, { taskNumber: 1, dependsOnNumber: 4 })).toBe(true);
    });

    it('handles diamond dependencies without false positives or recursion explosions', () => {
      // 2 depends on 1
      // 3 depends on 1
      // 4 depends on 2 and 3
      const edges: DependencyEdge[] = [
        { taskNumber: 2, dependsOnNumber: 1 },
        { taskNumber: 3, dependsOnNumber: 1 },
        { taskNumber: 4, dependsOnNumber: 2 },
      ];
      // Adding 4 depends on 3 completes diamond (valid, no cycle)
      expect(wouldCreateCycle(edges, { taskNumber: 4, dependsOnNumber: 3 })).toBe(false);

      const diamondEdges: DependencyEdge[] = [
        ...edges,
        { taskNumber: 4, dependsOnNumber: 3 },
      ];
      // 1 depends on 4 would cycle through either path of diamond
      expect(wouldCreateCycle(diamondEdges, { taskNumber: 1, dependsOnNumber: 4 })).toBe(true);
    });
  });

  describe('Transitive ancestors with minimum step distance (BFS)', () => {
    it('returns empty list when task has no dependencies', () => {
      const ancestors = getAncestors(1, []);
      expect(ancestors).toEqual([]);
    });

    it('returns direct and indirect prerequisites with correct minimum depth on diamonds', () => {
      // 4 depends on 2 (step 1) and 3 (step 1)
      // 2 depends on 1 (step 2 from 4)
      // 3 depends on 1 (step 2 from 4)
      const edges: DependencyEdge[] = [
        { taskNumber: 2, dependsOnNumber: 1 },
        { taskNumber: 3, dependsOnNumber: 1 },
        { taskNumber: 4, dependsOnNumber: 2 },
        { taskNumber: 4, dependsOnNumber: 3 },
      ];

      const ancestors = getAncestors(4, edges);
      // Sort for deterministic assertion
      ancestors.sort((a, b) => a.taskNumber - b.taskNumber);

      expect(ancestors).toEqual([
        { taskNumber: 1, depth: 2 },
        { taskNumber: 2, depth: 1 },
        { taskNumber: 3, depth: 1 },
      ]);
    });

    it('prefers shorter path when multiple paths exist (BFS shortest distance guarantee)', () => {
      // 3 depends directly on 1 (depth 1) AND on 2 (depth 1)
      // 2 depends on 1 (depth 2 from 3)
      const edges: DependencyEdge[] = [
        { taskNumber: 2, dependsOnNumber: 1 },
        { taskNumber: 3, dependsOnNumber: 2 },
        { taskNumber: 3, dependsOnNumber: 1 },
      ];

      const ancestors = getAncestors(3, edges);
      ancestors.sort((a, b) => a.taskNumber - b.taskNumber);

      expect(ancestors).toEqual([
        { taskNumber: 1, depth: 1 }, // shortest distance is 1
        { taskNumber: 2, depth: 1 },
      ]);
    });
  });

  describe('Transitive descendants with minimum step distance (BFS)', () => {
    it('returns all tasks that depend on the given task', () => {
      // 1 has dependents 2 and 3; 2 has dependent 4; 3 has dependent 4
      const edges: DependencyEdge[] = [
        { taskNumber: 2, dependsOnNumber: 1 },
        { taskNumber: 3, dependsOnNumber: 1 },
        { taskNumber: 4, dependsOnNumber: 2 },
        { taskNumber: 4, dependsOnNumber: 3 },
      ];

      const descendants = getDescendants(1, edges);
      descendants.sort((a, b) => a.taskNumber - b.taskNumber);

      expect(descendants).toEqual([
        { taskNumber: 2, depth: 1 },
        { taskNumber: 3, depth: 1 },
        { taskNumber: 4, depth: 2 },
      ]);
    });
  });

  describe('Blocked flag recomputation (computeBlockedFlags)', () => {
    it('computes blocked flags accurately across complex DAGs', () => {
      const tasks: TaskNode[] = [
        { number: 1, status: 'done' },
        { number: 2, status: 'in_progress' },
        { number: 3, status: 'not_started' },
        { number: 4, status: 'not_started' },
      ];

      // 2 depends on 1 (1 is done -> 2 is not blocked)
      // 3 depends on 2 (2 is in_progress -> 3 is blocked!)
      // 4 depends on 3 (3 is not_started -> 4 is blocked!)
      const edges: DependencyEdge[] = [
        { taskNumber: 2, dependsOnNumber: 1 },
        { taskNumber: 3, dependsOnNumber: 2 },
        { taskNumber: 4, dependsOnNumber: 3 },
      ];

      const blockedMap = computeBlockedFlags(tasks, edges);

      expect(blockedMap.get(1)).toBe(false); // Done
      expect(blockedMap.get(2)).toBe(false); // 1 is done
      expect(blockedMap.get(3)).toBe(true);  // 2 is in_progress (not done)
      expect(blockedMap.get(4)).toBe(true);  // 3 and 2 are not done
    });

    it('unblocks task when all prerequisites become done', () => {
      const tasks: TaskNode[] = [
        { number: 1, status: 'done' },
        { number: 2, status: 'done' },
        { number: 3, status: 'not_started' },
      ];

      // 3 depends on 1 and 2 (both done -> 3 is unblocked)
      const edges: DependencyEdge[] = [
        { taskNumber: 3, dependsOnNumber: 1 },
        { taskNumber: 3, dependsOnNumber: 2 },
      ];

      const blockedMap = computeBlockedFlags(tasks, edges);
      expect(blockedMap.get(3)).toBe(false);
    });
  });

  describe('Allowed actions pure function (allowedActions)', () => {
    it('allows "start" for not_started task with no prerequisites', () => {
      expect(allowedActions('not_started', [], [])).toEqual(['start']);
    });

    it('allows "start" for not_started task when all prerequisites are done', () => {
      const prereqs = [{ status: 'done' }, { status: 'done' }];
      expect(allowedActions('not_started', prereqs, [])).toEqual(['start']);
    });

    it('disallows "start" for not_started task if any prerequisite is not done', () => {
      expect(
        allowedActions(
          'not_started',
          [{ status: 'done' }, { status: 'in_progress' }],
          [],
        ),
      ).toEqual([]);
      expect(
        allowedActions('not_started', [{ status: 'not_started' }], []),
      ).toEqual([]);
    });

    it('allows "complete" for in_progress task regardless of prerequisites or dependents', () => {
      expect(allowedActions('in_progress', [], [])).toEqual(['complete']);
      expect(
        allowedActions(
          'in_progress',
          [{ status: 'not_started' }],
          [{ status: 'done' }],
        ),
      ).toEqual(['complete']);
    });

    it('allows "reopen" for done task when all dependents are not_started', () => {
      expect(allowedActions('done', [], [])).toEqual(['reopen']);
      expect(
        allowedActions(
          'done',
          [],
          [{ status: 'not_started' }, { status: 'not_started' }],
        ),
      ).toEqual(['reopen']);
    });

    it('disallows "reopen" for done task if any dependent has started', () => {
      expect(
        allowedActions('done', [], [{ status: 'in_progress' }]),
      ).toEqual([]);
      expect(
        allowedActions(
          'done',
          [],
          [{ status: 'not_started' }, { status: 'done' }],
        ),
      ).toEqual([]);
    });

    it('returns empty array for invalid/unknown status', () => {
      expect(allowedActions('unknown', [], [])).toEqual([]);
    });
  });

  describe('Derived late pure function (isTaskLate)', () => {
    const today = '2026-11-10';

    it('done tasks are NEVER late even if dates are in the past', () => {
      expect(
        isTaskLate(
          { status: 'done', startDate: '2020-01-01', endDate: '2020-01-02' },
          today,
        ),
      ).toBe(false);
    });

    it('not_started task is late if start_date < today', () => {
      expect(
        isTaskLate(
          { status: 'not_started', startDate: '2026-11-09', endDate: '2026-11-15' },
          today,
        ),
      ).toBe(true);
    });

    it('not_started task is not late if start_date >= today', () => {
      expect(
        isTaskLate(
          { status: 'not_started', startDate: '2026-11-10', endDate: '2026-11-15' },
          today,
        ),
      ).toBe(false);
      expect(
        isTaskLate(
          { status: 'not_started', startDate: '2026-11-11', endDate: '2026-11-15' },
          today,
        ),
      ).toBe(false);
    });

    it('in_progress task is late only if end_date < today', () => {
      expect(
        isTaskLate(
          { status: 'in_progress', startDate: '2026-11-01', endDate: '2026-11-09' },
          today,
        ),
      ).toBe(true);
      expect(
        isTaskLate(
          { status: 'in_progress', startDate: '2026-11-01', endDate: '2026-11-10' },
          today,
        ),
      ).toBe(false);
      expect(
        isTaskLate(
          { status: 'in_progress', startDate: '2026-11-01', endDate: '2026-11-20' },
          today,
        ),
      ).toBe(false);
    });
  });
});

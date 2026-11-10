/**
 * Pure graph algorithms for task dependencies.
 *
 * Rules:
 * - "B depends on A" means B waits for A (A is prerequisite, B is dependent).
 * - Max 3,000 nodes per project, executed in memory (rule 103).
 * - No recursive CTEs (they explode on diamonds) (rule 104).
 * - BFS for minimum step distance.
 */

export interface DependencyEdge {
  taskNumber: number;
  dependsOnNumber: number;
}

export interface RelatedTaskDistance {
  taskNumber: number;
  depth: number;
}

export interface TaskNode {
  number: number;
  status: string; // 'not_started' | 'in_progress' | 'done'
}

/**
 * Builds adjacency maps from a list of edges.
 * - prereqMap: taskNumber -> Set of prerequisites (dependsOnNumber)
 * - dependentMap: dependsOnNumber -> Set of dependents (taskNumber)
 */
export function buildAdjacencyMaps(edges: DependencyEdge[]): {
  prereqMap: Map<number, Set<number>>;
  dependentMap: Map<number, Set<number>>;
} {
  const prereqMap = new Map<number, Set<number>>();
  const dependentMap = new Map<number, Set<number>>();

  for (const edge of edges) {
    let pSet = prereqMap.get(edge.taskNumber);
    if (!pSet) {
      pSet = new Set();
      prereqMap.set(edge.taskNumber, pSet);
    }
    pSet.add(edge.dependsOnNumber);

    let dSet = dependentMap.get(edge.dependsOnNumber);
    if (!dSet) {
      dSet = new Set();
      dependentMap.set(edge.dependsOnNumber, dSet);
    }
    dSet.add(edge.taskNumber);
  }

  return { prereqMap, dependentMap };
}

/**
 * Returns true if adding `newEdge` (taskNumber depends on dependsOnNumber)
 * would create a directed cycle.
 *
 * A cycle is formed if:
 * 1. taskNumber === dependsOnNumber (self-dependency)
 * 2. taskNumber is already an ancestor of dependsOnNumber (i.e. dependsOnNumber already depends on taskNumber)
 */
export function wouldCreateCycle(
  existingEdges: DependencyEdge[],
  newEdge: DependencyEdge,
): boolean {
  if (newEdge.taskNumber === newEdge.dependsOnNumber) {
    return true;
  }

  const { prereqMap } = buildAdjacencyMaps(existingEdges);

  // BFS from newEdge.dependsOnNumber following prerequisites.
  // If we can reach newEdge.taskNumber, adding taskNumber -> dependsOnNumber forms a cycle.
  const queue: number[] = [newEdge.dependsOnNumber];
  const visited = new Set<number>([newEdge.dependsOnNumber]);

  while (queue.length > 0) {
    const curr = queue.shift();
    if (curr === undefined) {
      break;
    }
    if (curr === newEdge.taskNumber) {
      return true;
    }

    const prereqs = prereqMap.get(curr);
    if (prereqs) {
      for (const next of prereqs) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
  }

  return false;
}

/**
 * Returns all transitive prerequisites (ancestors) of a task with their minimum step distance.
 * BFS guarantees shortest path / minimum step distance, handling diamond cases correctly.
 */
export function getAncestors(
  taskNumber: number,
  edges: DependencyEdge[],
): RelatedTaskDistance[] {
  const { prereqMap } = buildAdjacencyMaps(edges);
  const distances = new Map<number, number>();
  const queue: { num: number; depth: number }[] = [];

  const directPrereqs = prereqMap.get(taskNumber);
  if (directPrereqs) {
    for (const p of directPrereqs) {
      distances.set(p, 1);
      queue.push({ num: p, depth: 1 });
    }
  }

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) {
      break;
    }
    const { num, depth } = item;
    const nextPrereqs = prereqMap.get(num);
    if (nextPrereqs) {
      for (const p of nextPrereqs) {
        if (!distances.has(p)) {
          distances.set(p, depth + 1);
          queue.push({ num: p, depth: depth + 1 });
        }
      }
    }
  }

  return Array.from(distances.entries()).map(([num, depth]) => ({
    taskNumber: num,
    depth,
  }));
}

/**
 * Returns all transitive dependents (descendants) of a task with their minimum step distance.
 * A dependent is a task that depends on `taskNumber`.
 */
export function getDescendants(
  taskNumber: number,
  edges: DependencyEdge[],
): RelatedTaskDistance[] {
  const { dependentMap } = buildAdjacencyMaps(edges);
  const distances = new Map<number, number>();
  const queue: { num: number; depth: number }[] = [];

  const directDependents = dependentMap.get(taskNumber);
  if (directDependents) {
    for (const d of directDependents) {
      distances.set(d, 1);
      queue.push({ num: d, depth: 1 });
    }
  }

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) {
      break;
    }
    const { num, depth } = item;
    const nextDependents = dependentMap.get(num);
    if (nextDependents) {
      for (const d of nextDependents) {
        if (!distances.has(d)) {
          distances.set(d, depth + 1);
          queue.push({ num: d, depth: depth + 1 });
        }
      }
    }
  }

  return Array.from(distances.entries()).map(([num, depth]) => ({
    taskNumber: num,
    depth,
  }));
}

/**
 * Recomputes the `blocked` status for all tasks in a project.
 * Rule: blocked = status is not done AND at least one transitive prerequisite is not done (rule 105).
 */
export function computeBlockedFlags(
  tasks: TaskNode[],
  edges: DependencyEdge[],
): Map<number, boolean> {
  const { prereqMap } = buildAdjacencyMaps(edges);
  const statusMap = new Map<number, string>(tasks.map((t) => [t.number, t.status]));
  const blockedMap = new Map<number, boolean>();

  // Helper to check if any transitive prerequisite is not 'done'
  function isTaskBlocked(taskNum: number): boolean {
    const status = statusMap.get(taskNum);
    if (status === 'done') {
      return false; // Done tasks are never blocked
    }

    const queue: number[] = [];
    const visited = new Set<number>();
    const direct = prereqMap.get(taskNum);
    if (!direct || direct.size === 0) {
      return false;
    }

    for (const p of direct) {
      visited.add(p);
      queue.push(p);
    }

    while (queue.length > 0) {
      const curr = queue.shift();
      if (curr === undefined) {
        break;
      }
      const currStatus = statusMap.get(curr);
      // If prerequisite is not done (e.g. not_started or in_progress or not found), this task is blocked
      if (currStatus !== 'done') {
        return true;
      }

      const nextPrereqs = prereqMap.get(curr);
      if (nextPrereqs) {
        for (const p of nextPrereqs) {
          if (!visited.has(p)) {
            visited.add(p);
            queue.push(p);
          }
        }
      }
    }

    return false;
  }

  for (const t of tasks) {
    blockedMap.set(t.number, isTaskBlocked(t.number));
  }

  return blockedMap;
}

export type TaskAction = 'start' | 'complete' | 'reopen';

/**
 * Pure function allowedActions(status, prereqs, dependents)
 * Drives the task-details response, which lists only currently allowed actions (rule 110, 113).
 *
 * Rules:
 * - 'start': (not_started to in_progress, only if every transitive prerequisite is done)
 * - 'complete': (in_progress to done)
 * - 'reopen': (done to in_progress, only if no transitive dependent has started, i.e. all are not_started)
 * Anything else returns [].
 */
export function allowedActions(
  status: string,
  prereqs: { status: string }[],
  dependents: { status: string }[],
): TaskAction[] {
  if (status === 'not_started') {
    const allPrereqsDone = prereqs.every((p) => p.status === 'done');
    return allPrereqsDone ? ['start'] : [];
  }
  if (status === 'in_progress') {
    return ['complete'];
  }
  if (status === 'done') {
    const noDependentStarted = dependents.every(
      (d) => d.status === 'not_started',
    );
    return noDependentStarted ? ['reopen'] : [];
  }
  return [];
}

/**
 * Pure function to derive whether a task is late (rule 111).
 * Late: status <> 'done' AND ((status = 'not_started' AND start_date < today) OR end_date < today).
 * Done is never late.
 */
export function isTaskLate(
  task: { status: string; startDate: string; endDate: string },
  todayUtc: string,
): boolean {
  if (task.status === 'done') {
    return false;
  }
  if (task.status === 'not_started' && task.startDate < todayUtc) {
    return true;
  }
  if (task.endDate < todayUtc) {
    return true;
  }
  return false;
}


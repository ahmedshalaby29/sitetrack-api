/**
 * ID formatting and parsing helpers.
 *
 * Rules (from context.md rules 7 & 97):
 * - IDs are stored as integers in the database.
 * - Formatted at the API edge as PRJ-XXXX (grows past 4 digits naturally).
 * - Tasks are formatted as PRJ-XXXX-T-YYYY.
 */

const PROJECT_ID_REGEX = /^PRJ-(\d+)$/;
const TASK_ID_REGEX = /^PRJ-(\d+)-T-(\d+)$/;

/**
 * Formats an integer project ID as PRJ-0042 (zero-padded to at least 4 digits).
 */
export function formatProjectId(id: number | bigint): string {
  const num = typeof id === 'bigint' ? id.toString() : String(id);
  return `PRJ-${num.padStart(4, '0')}`;
}

/**
 * Parses a formatted project ID (e.g. "PRJ-0042" or "PRJ-42") into its integer value.
 * Returns null if the format is invalid.
 */
export function parseProjectId(formatted: string): number | null {
  const match = PROJECT_ID_REGEX.exec(formatted);
  if (!match?.[1]) return null;
  const val = Number.parseInt(match[1], 10);
  return Number.isNaN(val) || val <= 0 ? null : val;
}

/**
 * Formats a project and task sequence number as PRJ-0042-T-0137.
 */
export function formatTaskId(
  projectId: number | bigint,
  taskNumber: number | bigint,
): string {
  const p = formatProjectId(projectId);
  const t = typeof taskNumber === 'bigint' ? taskNumber.toString() : String(taskNumber);
  return `${p}-T-${t.padStart(4, '0')}`;
}

/**
 * Parses a formatted task ID (e.g. "PRJ-0042-T-0137") into its project and task numbers.
 * Returns null if the format is invalid.
 */
export function parseTaskId(
  formatted: string,
): { projectId: number; taskNumber: number } | null {
  const match = TASK_ID_REGEX.exec(formatted);
  if (!match?.[1] || !match[2]) return null;
  const projectId = Number.parseInt(match[1], 10);
  const taskNumber = Number.parseInt(match[2], 10);
  if (
    Number.isNaN(projectId) ||
    projectId <= 0 ||
    Number.isNaN(taskNumber) ||
    taskNumber <= 0
  ) {
    return null;
  }
  return { projectId, taskNumber };
}

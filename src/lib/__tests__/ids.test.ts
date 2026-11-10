import { describe, it, expect } from 'vitest';
import {
  formatProjectId,
  formatTaskId,
  parseProjectId,
  parseTaskId,
} from '../ids.js';

describe('ID formatting and parsing (PRJ-XXXX, PRJ-XXXX-T-YYYY)', () => {
  describe('formatProjectId', () => {
    it('formats numbers with zero-padding to at least 4 digits', () => {
      expect(formatProjectId(1)).toBe('PRJ-0001');
      expect(formatProjectId(42)).toBe('PRJ-0042');
      expect(formatProjectId(9999)).toBe('PRJ-9999');
    });

    it('grows naturally beyond 4 digits', () => {
      expect(formatProjectId(10000)).toBe('PRJ-10000');
      expect(formatProjectId(123456)).toBe('PRJ-123456');
    });

    it('handles BigInts', () => {
      expect(formatProjectId(42n)).toBe('PRJ-0042');
    });
  });

  describe('parseProjectId', () => {
    it('parses formatted project IDs to integer numbers', () => {
      expect(parseProjectId('PRJ-0042')).toBe(42);
      expect(parseProjectId('PRJ-42')).toBe(42);
      expect(parseProjectId('PRJ-10000')).toBe(10000);
    });

    it('returns null for invalid inputs', () => {
      expect(parseProjectId('42')).toBeNull();
      expect(parseProjectId('prj-0042')).toBeNull();
      expect(parseProjectId('PRJ-')).toBeNull();
      expect(parseProjectId('PRJ-0')).toBeNull();
      expect(parseProjectId('PRJ-ABC')).toBeNull();
      expect(parseProjectId('')).toBeNull();
    });
  });

  describe('formatTaskId', () => {
    it('formats project and task number with zero-padding', () => {
      expect(formatTaskId(42, 137)).toBe('PRJ-0042-T-0137');
      expect(formatTaskId(1, 1)).toBe('PRJ-0001-T-0001');
      expect(formatTaskId(12345, 99999)).toBe('PRJ-12345-T-99999');
    });
  });

  describe('parseTaskId', () => {
    it('parses valid task IDs into project and task numbers', () => {
      expect(parseTaskId('PRJ-0042-T-0137')).toEqual({
        projectId: 42,
        taskNumber: 137,
      });
    });

    it('returns null for invalid task ID formats', () => {
      expect(parseTaskId('PRJ-0042')).toBeNull();
      expect(parseTaskId('PRJ-0042-T')).toBeNull();
      expect(parseTaskId('PRJ-0042-T-0')).toBeNull();
      expect(parseTaskId('T-0137')).toBeNull();
      expect(parseTaskId('invalid')).toBeNull();
    });
  });
});

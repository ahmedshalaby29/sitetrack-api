/**
 * Integration and unit tests for scale seeder and consistency checker.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { parseScaleArg, runSeeder } from '../seed.js';
import { verifyDatabase } from '../verify.js';

describe('Scale Seeder & Consistency Checker', () => {
  describe('CLI arguments parser', () => {
    it('defaults to small if scale is not specified', () => {
      expect(parseScaleArg([])).toBe('small');
      expect(parseScaleArg(['--foo', 'bar'])).toBe('small');
    });

    it('parses --scale=full and --scale=small', () => {
      expect(parseScaleArg(['--scale=full'])).toBe('full');
      expect(parseScaleArg(['--scale=small'])).toBe('small');
      expect(parseScaleArg(['full'])).toBe('full');
      expect(parseScaleArg(['small'])).toBe('small');
    });
  });

  describe('Database consistency verification', () => {
    beforeAll(async () => {
      await runSeeder('small');
    });

    it('passes all business invariants on the database', async () => {
      const ok = await verifyDatabase();
      expect(ok).toBe(true);
    });
  });
});

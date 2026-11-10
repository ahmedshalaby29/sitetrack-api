/**
 * Injectable UTC clock for date and time calculations.
 *
 * Rules:
 * - Decision 12: all "today" logic is UTC date.
 * - Clock is injected so tests control it.
 */

export interface Clock {
  now(): Date;
  today(): string; // YYYY-MM-DD
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  today(): string {
    return this.now().toISOString().slice(0, 10);
  }
}

export class FixedClock implements Clock {
  constructor(private currentDate: Date = new Date()) {}

  setDate(d: Date): void {
    this.currentDate = d;
  }

  now(): Date {
    return this.currentDate;
  }

  today(): string {
    return this.currentDate.toISOString().slice(0, 10);
  }
}

export const defaultClock: Clock = new SystemClock();

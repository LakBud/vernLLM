import type { BudgetWindow } from '../../types/index.js';

export interface WindowInfo {
  /** e.g. `day:2026-10-20`. A new window has a new id, so its spend starts from zero. */
  id: string;
  /** The next boundary, as epoch milliseconds. */
  resetsAtMs: number;
}

export const DEFAULT_TIME_ZONE = 'UTC';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Whether `timeZone` is an IANA zone this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall clock in `timeZone` at `ms`, as the UTC milliseconds that read the same. */
function wallClockMs(ms: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(ms)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
}

/** Milliseconds `timeZone` is ahead of UTC at `ms`. */
function offsetMs(ms: number, timeZone: string): number {
  return wallClockMs(ms, timeZone) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a wall clock reads `wallMs` in `timeZone`. A time that falls in a skipped hour
 * resolves to just after the gap, and a repeated one to its first occurrence.
 */
function instantOf(wallMs: number, timeZone: string): number {
  const first = wallMs - offsetMs(wallMs, timeZone);
  const second = wallMs - offsetMs(first, timeZone);
  return second;
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/**
 * The calendar window `nowMs` falls in, in `timeZone` (UTC by default). UTC is the same on every
 * server; another zone follows its own calendar, daylight saving included. Wall clock on purpose,
 * since budgets follow the calendar.
 */
export function windowFor(
  per: BudgetWindow,
  nowMs: number,
  timeZone: string = DEFAULT_TIME_ZONE,
): WindowInfo {
  if (timeZone === DEFAULT_TIME_ZONE) return utcWindowFor(per, nowMs);

  const wall = new Date(wallClockMs(nowMs, timeZone));
  const year = wall.getUTCFullYear();
  const month = wall.getUTCMonth();
  const day = wall.getUTCDate();
  const hour = wall.getUTCHours();
  const date = `${pad(year, 4)}-${pad(month + 1)}-${pad(day)}`;

  switch (per) {
    case 'hour': {
      // A repeated hour in autumn is two windows, told apart by the offset.
      const offset = offsetMs(nowMs, timeZone) / 60_000;
      const msIntoHour = (wall.getTime() % 3_600_000) + (nowMs % 1000);
      return {
        id: `hour:${date}T${pad(hour)}@${offset}`,
        resetsAtMs: nowMs - msIntoHour + 3_600_000,
      };
    }
    case 'day':
      return {
        id: `day:${date}`,
        resetsAtMs: instantOf(Date.UTC(year, month, day + 1), timeZone),
      };
    case 'month':
      return {
        id: `month:${pad(year, 4)}-${pad(month + 1)}`,
        resetsAtMs: instantOf(Date.UTC(year, month + 1, 1), timeZone),
      };
  }
}

function utcWindowFor(per: BudgetWindow, nowMs: number): WindowInfo {
  const date = new Date(nowMs);
  const iso = date.toISOString();
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const hour = date.getUTCHours();

  // `Date.UTC` carries an overflowing field into the next unit, so hour 24 is the next day.
  switch (per) {
    case 'hour':
      return { id: `hour:${iso.slice(0, 13)}`, resetsAtMs: Date.UTC(year, month, day, hour + 1) };
    case 'day':
      return { id: `day:${iso.slice(0, 10)}`, resetsAtMs: Date.UTC(year, month, day + 1) };
    case 'month':
      return { id: `month:${iso.slice(0, 7)}`, resetsAtMs: Date.UTC(year, month + 1, 1) };
  }
}

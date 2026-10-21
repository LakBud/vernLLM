import { describe, expect, it } from 'vitest';

import { windowFor } from '../../../../src/internal/budgets/windows.utils.js';

const at = (iso: string) => Date.parse(iso);

describe('windowFor', () => {
  it('names the UTC hour, day and month a time falls in', () => {
    const now = at('2026-10-20T13:45:10Z');

    expect(windowFor('hour', now)).toEqual({
      id: 'hour:2026-10-20T13',
      resetsAtMs: at('2026-10-20T14:00:00Z'),
    });
    expect(windowFor('day', now)).toEqual({
      id: 'day:2026-10-20',
      resetsAtMs: at('2026-10-21T00:00:00Z'),
    });
    expect(windowFor('month', now)).toEqual({
      id: 'month:2026-10',
      resetsAtMs: at('2026-11-01T00:00:00Z'),
    });
  });

  it('rolls over into the next day, month and year', () => {
    expect(windowFor('hour', at('2026-10-31T23:30:00Z')).resetsAtMs).toBe(
      at('2026-11-01T00:00:00Z'),
    );
    expect(windowFor('day', at('2026-02-28T12:00:00Z')).resetsAtMs).toBe(
      at('2026-03-01T00:00:00Z'),
    );
    expect(windowFor('day', at('2028-02-28T12:00:00Z')).resetsAtMs).toBe(
      at('2028-02-29T00:00:00Z'),
    );
    expect(windowFor('month', at('2026-12-15T00:00:00Z')).resetsAtMs).toBe(
      at('2027-01-01T00:00:00Z'),
    );
  });

  it('gives a new id at the boundary and the same id just before it', () => {
    expect(windowFor('day', at('2026-10-20T23:59:59.999Z')).id).toBe('day:2026-10-20');
    expect(windowFor('day', at('2026-10-21T00:00:00Z')).id).toBe('day:2026-10-21');
  });

  describe('in a time zone', () => {
    const ny = 'America/New_York';

    it("starts the day on that zone's midnight", () => {
      // 02:30 UTC on 21 Oct is 22:30 on 20 Oct in New York (UTC-4).
      expect(windowFor('day', at('2026-10-21T02:30:00Z'), ny)).toEqual({
        id: 'day:2026-10-20',
        resetsAtMs: at('2026-10-21T04:00:00Z'),
      });
      expect(windowFor('month', at('2026-11-01T02:00:00Z'), ny)).toEqual({
        id: 'month:2026-10',
        // 1 Nov 00:00 is still daylight time, then the clocks fall back that night.
        resetsAtMs: at('2026-11-01T04:00:00Z'),
      });
    });

    it('follows the offset through the autumn change, when a day is 25 hours', () => {
      // Clocks fall back at 06:00 UTC on 1 Nov 2026. That day runs 04:00Z to 05:00Z the next day.
      const info = windowFor('day', at('2026-11-01T12:00:00Z'), ny);
      expect(info).toEqual({ id: 'day:2026-11-01', resetsAtMs: at('2026-11-02T05:00:00Z') });
    });

    it('follows the offset through the spring change, when a day is 23 hours', () => {
      // Clocks spring forward at 07:00 UTC on 8 Mar 2026. That day runs 05:00Z to 04:00Z.
      const info = windowFor('day', at('2026-03-08T12:00:00Z'), ny);
      expect(info).toEqual({ id: 'day:2026-03-08', resetsAtMs: at('2026-03-09T04:00:00Z') });
    });

    it('keeps a repeated autumn hour as two windows', () => {
      const first = windowFor('hour', at('2026-11-01T05:30:00Z'), ny);
      const second = windowFor('hour', at('2026-11-01T06:30:00Z'), ny);

      expect(first.id).not.toBe(second.id);
      expect(first.resetsAtMs).toBe(at('2026-11-01T06:00:00Z'));
      expect(second.resetsAtMs).toBe(at('2026-11-01T07:00:00Z'));
    });

    it('handles a zone with a half hour offset', () => {
      // Kolkata is UTC+5:30, so 19:00Z is 00:30 the next day there.
      expect(windowFor('hour', at('2026-10-20T19:10:00Z'), 'Asia/Kolkata')).toMatchObject({
        id: 'hour:2026-10-21T00@330',
        resetsAtMs: at('2026-10-20T19:30:00Z'),
      });
      expect(windowFor('day', at('2026-10-20T19:10:00Z'), 'Asia/Kolkata').resetsAtMs).toBe(
        at('2026-10-21T18:30:00Z'),
      );
    });

    it('is the same as UTC for UTC and for a zone at zero offset', () => {
      const now = at('2026-10-20T13:45:10Z');
      expect(windowFor('day', now, 'UTC')).toEqual(windowFor('day', now));
      expect(windowFor('day', now, 'Etc/GMT').resetsAtMs).toBe(windowFor('day', now).resetsAtMs);
    });
  });
});

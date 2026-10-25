/** A date, or a date and time with an offset: a bare time would depend on the host. */
const UNTIL_FORMAT =
  /^(\d{4})-(\d{2})-(\d{2})(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d))?$/;

/** A date that exists. `Date.parse` rolls `2026-02-31` over to March. */
export function isRealUntil(until: string): boolean {
  const match = UNTIL_FORMAT.exec(until);
  if (match === null || Number.isNaN(Date.parse(until))) return false;

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

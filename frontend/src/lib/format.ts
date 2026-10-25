const IST = "Asia/Kolkata";

const dateFmt = new Intl.DateTimeFormat("en-IN", { timeZone: IST, day: "numeric", month: "short", year: "numeric" });
const shortDateFmt = new Intl.DateTimeFormat("en-IN", { timeZone: IST, day: "numeric", month: "short" });
const timeFmt = new Intl.DateTimeFormat("en-IN", { timeZone: IST, hour: "numeric", minute: "2-digit" });
const weekdayFmt = new Intl.DateTimeFormat("en-IN", { timeZone: IST, weekday: "short" });
const monthFmt = new Intl.DateTimeFormat("en-IN", { timeZone: IST, month: "short", year: "2-digit" });
const isoFmt = new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" });
const longDateFmt = new Intl.DateTimeFormat("en-IN", { timeZone: IST, weekday: "long", day: "numeric", month: "long" });

/** For the lock screen clock: "2:35 pm" and "Saturday, 25 October". */
export const fmtClock = (moment: Date) => timeFmt.format(moment);
export const fmtLongDate = (moment: Date) => longDateFmt.format(moment);

function parse(value: string): Date {
  // "2026-10-26" is a calendar date: read it as noon IST so it never shifts a day.
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00+05:30`) : new Date(value);
}

export const fmtDate = (value?: string | null) => (value ? dateFmt.format(parse(value)) : "—");
export const fmtShortDate = (value?: string | null) => (value ? shortDateFmt.format(parse(value)) : "—");
export const fmtTime = (value?: string | null) => (value ? timeFmt.format(parse(value)) : "—");
export const fmtWeekday = (value: string) => weekdayFmt.format(parse(value));
export const fmtMonth = (value: string) => monthFmt.format(parse(value));
export const fmtDateTime = (value?: string | null) =>
  value ? `${shortDateFmt.format(parse(value))}, ${timeFmt.format(parse(value))}` : "—";

/** Today's date in IST as "YYYY-MM-DD". */
export function todayIso(): string {
  return isoFmt.format(new Date());
}

export function addDays(iso: string, days: number): string {
  const date = parse(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return isoFmt.format(date);
}

export function isToday(value?: string | null): boolean {
  return !!value && isoFmt.format(parse(value)) === todayIso();
}

/** Does `text` state the time `iso` as seen in `tz` (e.g. "1:00 PM", "1 PM", "13:00")? */
export function mentionsTime(text: string, iso: string, tz: string): boolean {
  const z = Temporal.Instant.from(iso).toZonedDateTimeISO(tz);
  const h12 = z.hour % 12 || 12;
  const ampm = z.hour < 12 ? "am" : "pm";
  const mm = String(z.minute).padStart(2, "0");
  const variants = [`${h12}:${mm}${ampm}`, `${String(z.hour).padStart(2, "0")}:${mm}`, `${z.hour}:${mm}`];
  if (z.minute === 0) variants.push(`${h12}${ampm}`);
  const norm = text.toLowerCase().replace(/\s+(am|pm)\b/g, "$1").replace(/\./g, "");
  return variants.some((v) => norm.includes(v));
}

export const local = (iso: string, tz: string) => Temporal.Instant.from(iso).toZonedDateTimeISO(tz);

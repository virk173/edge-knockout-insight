// Shared match date/time formatting. All kickoff times are displayed in
// Vancouver, Canada time (America/Vancouver) using the IANA timezone identifier
// so daylight saving (PDT in summer, PST in winter) is handled automatically.
//
// Output format: "Tuesday, July 1 · 6:00 PM PDT"

const VANCOUVER_TZ = "America/Vancouver";

// Formats a UTC kickoff datetime string (ISO) into the canonical match-time
// string shown everywhere in the UI. Returns null for missing/invalid input.
export function formatMatchTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  const datePart = new Intl.DateTimeFormat("en-US", {
    timeZone: VANCOUVER_TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date);

  const timePart = new Intl.DateTimeFormat("en-US", {
    timeZone: VANCOUVER_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(date);

  return `${datePart} · ${timePart}`;
}

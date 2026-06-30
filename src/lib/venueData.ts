/**
 * venueData.ts — static lookup table for World Cup 2026 venues.
 *
 * Used to derive contextual adjustments (altitude, travel timezone burden)
 * with ZERO additional API calls. Altitude in metres, timezone_offset_hours
 * is the venue's UTC offset (standard summer offset during the tournament).
 */

export const VENUE_DATA: Record<
  string,
  {
    altitude_m: number;
    timezone_offset_hours: number;
    city: string;
  }
> = {
  "Estadio Azteca": {
    altitude_m: 2240,
    timezone_offset_hours: -6,
    city: "Mexico City",
  },
  "Estadio Akron": {
    altitude_m: 1566,
    timezone_offset_hours: -6,
    city: "Guadalajara",
  },
  "Estadio BBVA": {
    altitude_m: 538,
    timezone_offset_hours: -6,
    city: "Monterrey",
  },
  "MetLife Stadium": {
    altitude_m: 8,
    timezone_offset_hours: -4,
    city: "East Rutherford",
  },
  "Mercedes-Benz Stadium": {
    altitude_m: 320,
    timezone_offset_hours: -4,
    city: "Atlanta",
  },
  "Hard Rock Stadium": {
    altitude_m: 2,
    timezone_offset_hours: -4,
    city: "Miami",
  },
  "AT&T Stadium": {
    altitude_m: 180,
    timezone_offset_hours: -5,
    city: "Arlington",
  },
  "NRG Stadium": {
    altitude_m: 12,
    timezone_offset_hours: -5,
    city: "Houston",
  },
  "Arrowhead Stadium": {
    altitude_m: 256,
    timezone_offset_hours: -5,
    city: "Kansas City",
  },
  "Levi's Stadium": {
    altitude_m: 9,
    timezone_offset_hours: -7,
    city: "Santa Clara",
  },
  "SoFi Stadium": {
    altitude_m: 29,
    timezone_offset_hours: -7,
    city: "Inglewood",
  },
  "Lincoln Financial Field": {
    altitude_m: 12,
    timezone_offset_hours: -4,
    city: "Philadelphia",
  },
  "Gillette Stadium": {
    altitude_m: 91,
    timezone_offset_hours: -4,
    city: "Foxborough",
  },
  "Lumen Field": {
    altitude_m: 4,
    timezone_offset_hours: -7,
    city: "Seattle",
  },
  "BC Place": {
    altitude_m: 1,
    timezone_offset_hours: -7,
    city: "Vancouver",
  },
  "BMO Field": {
    altitude_m: 76,
    timezone_offset_hours: -4,
    city: "Toronto",
  },
};

export type VenueInfo = (typeof VENUE_DATA)[string];

/**
 * Resolve venue static data by name. Exact match first, then a fuzzy
 * contains-match in either direction to tolerate API naming differences.
 */
export const getVenueData = (venueName: string): VenueInfo | null => {
  if (!venueName) return null;
  // exact match first
  if (VENUE_DATA[venueName]) return VENUE_DATA[venueName];
  // fuzzy match fallback
  const needle = venueName.toLowerCase();
  const key = Object.keys(VENUE_DATA).find(
    (k) =>
      k.toLowerCase().includes(needle) || needle.includes(k.toLowerCase()),
  );
  return key ? VENUE_DATA[key] : null;
};

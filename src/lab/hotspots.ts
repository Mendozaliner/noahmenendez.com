/* Clickable props. `id` matches the per-vertex hotspot ids written by pack_v10.py (HOT table) into rt/room.json. */
export type Hotspot = { id: number; label: string; url: string };

export const HOTSPOTS: Hotspot[] = [
  { id: 1, label: 'Golf · 18Birdies', url: 'https://18birdies.onelink.me/IdkR/tz9xrv0l' },                 // golf bag, clubs, head covers
  { id: 2, label: 'LinkedIn', url: 'https://www.linkedin.com/in/noahmenendez/' },                           // monitor
  { id: 3, label: 'ninejobs.ca', url: 'https://ninejobs.ca' },                                              // laptop
  { id: 4, label: 'Quo on the App Store', url: 'https://apps.apple.com/ca/app/quo-daily-motivational-quotes/id6756632974' }, // phone + stand
  { id: 5, label: 'Strava', url: 'https://strava.app.link/qo1nD0CZc8b' },                                   // skis
  { id: 6, label: 'Strava', url: 'https://strava.app.link/qo1nD0CZc8b' },                                   // bike
  { id: 7, label: 'Goodreads', url: 'https://www.goodreads.com/user/show/205976545' },                      // the four standing books
];

export const HOT_BY_ID: Record<number, Hotspot> = Object.fromEntries(HOTSPOTS.map((h) => [h.id, h]));

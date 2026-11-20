/* Clickable props. `id` matches the per-vertex hotspot ids written by pack_v10.py (HOT table) into rt/room.json. */
export type Hotspot = { id: number; label: string; url: string };

export const HOTSPOTS: Hotspot[] = [
  { id: 1, label: 'Golf · 18Birdies', url: 'https://18birdies.onelink.me/IdkR/tz9xrv0l' },                 // golf bag, clubs, head covers
  { id: 2, label: 'LinkedIn', url: 'https://www.linkedin.com/in/noahmenendez/' },                           // monitor
  { id: 3, label: 'ninejobs.ca', url: 'https://ninejobs.ca' },                                              // laptop
  { id: 4, label: 'Quo on the App Store', url: 'https://apps.apple.com/ca/app/quo-daily-motivational-quotes/id6756632974' }, // phone + stand
  { id: 5, label: 'Strava', url: 'https://strava.app.link/qo1nD0CZc8b' },                                   // skis
  { id: 6, label: 'Strava', url: 'https://strava.app.link/qo1nD0CZc8b' },                                   // bike
  { id: 7, label: 'Goodreads', url: 'https://www.goodreads.com/user/show/205976545' },
  // framed jerseys (hot zones only, not baked into room.json): Price 31, Menendez 10 (baseball), Crosby 87, Menendez 90 (beer-league stats).
  { id: 8, label: 'Carey Price · Hockey Hall of Fame', url: 'https://www.hhof.com/induction/induction2026/about_Price.html' },
  { id: 9, label: 'Baseball', url: 'https://www.youtube.com/watch?v=-UdsVO7HaJg' },
  { id: 10, label: 'Sidney Crosby', url: 'https://www.youtube.com/watch?v=ofDvet0KUkU' },
  { id: 11, label: 'ASHL stats', url: 'https://www.ashl.ca/stats-and-schedules/ashl/etobicoke-summer/#/player/wQC7HNe7hyHO8Mwh' },                      // the four standing books
];

export const HOT_BY_ID: Record<number, Hotspot> = Object.fromEntries(HOTSPOTS.map((h) => [h.id, h]));

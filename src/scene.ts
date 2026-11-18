// Scene constants exported from office_iso (Blender, metres).
// Blender is Z-up, three.js is Y-up: (x, y, z)_blender -> (x, z, -y)_three.

export const FRAME_ANGLES = [-35, -30, -25, -20, -15, -10, -5, 0, 5, 10, 15, 20, 25, 30, 35];
export const MAX_SWING = 35; // degrees either side of the hero view

export type Mode = 'day' | 'night';

export const frameUrl = (mode: Mode, deg: number) => {
  const tag = (deg >= 0 ? '+' : '-') + String(Math.abs(deg)).padStart(2, '0');
  return `${import.meta.env.BASE_URL}img/${mode}/swing_${tag}.webp`;
};

// Page backdrop behind the room (sampled from the renders so the edges disappear)
export const BACKDROP: Record<Mode, string> = { day: '#9499a0', night: '#43474d' };

// Filled in by tools/export_scene.py from the .blend
export { CAMERA, CLOCK } from './scene.generated';

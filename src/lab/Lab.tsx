import MaskViewer from './MaskViewer';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber';
import { suspend } from 'suspend-react';
import * as THREE from 'three';
import { HOT_BY_ID } from './hotspots';
import { LINKS, NAME, type LinkIcon } from './links';

/* Camera: orthographic, matched to Blender's iso_camera (ortho_scale 6.62, pointing at (0,0,1.35)) */
const ORTHO = 6.618519;
const PIVOT = new THREE.Vector3(0, 1.35, 0); // blender (0,0,1.35) -> three (x, z, -y)
const YAW0 = Math.atan2(11.55, -11.55); // 135 deg
const PITCH0 = Math.asin(1 / Math.sqrt(3)); // 35.26 deg
const DIST = 20;
const D2R = Math.PI / 180;
const ZOOM_MAX = 4;

/* ---- look-around + snapback: how far people may turn the room, and how fast it pulls back. All tunable. ---- */
const SNAP = {
  yawMin: -45 * D2R,    // turn all the way to either side (one wall face-on, the other edge-on)
  yawMax: 45 * D2R,
  pitchMin: 0,          // ground level: eye at floor height, never below it (no underside of the floor)
  pitchMax: 90 * D2R,   // straight down (bird's eye)
  band: 7 * D2R,        // the last few degrees of every range turn into a soft rubber stop instead of a hard wall
  dragYaw: 2.6,         // drag sensitivity (radians per screen-height of drag)
  dragPitch: 2.4,
  wheelIdle: 0.1,       // seconds without a scroll event that count as "done zooming" (wheel ticks arrive ~16-60 ms apart)
  returnTime: 0.15,     // spring time of the snapback in seconds (smaller = snappier); starts the instant you let go
  followTime: 0.045,    // how tightly the view follows your finger / the wheel
};
/** Linear inside [lo, hi], easing into a rubber stop over the last `b` at each end (never passes lo / hi). */
const soft = (x: number, lo: number, hi: number, b: number) =>
  x > hi - b ? hi - b + b * Math.tanh((x - hi + b) / b) : x < lo + b ? lo + b - b * Math.tanh((lo + b - x) / b) : x;
const unsoft = (y: number, lo: number, hi: number, b: number) => {   // inverse of soft(), for grabbing the view mid-return
  const at = (u: number) => 0.5 * Math.log((1 + u) / (1 - u)), c = (u: number) => Math.max(-0.995, Math.min(0.995, u));
  return y > hi - b ? hi - b + b * at(c((y - hi + b) / b)) : y < lo + b ? lo + b - b * at(c((lo + b - y) / b)) : y;
};

/* ---- light switch: where it sits on the wall (three coords, metres) and how big the click target is ---- */
const SWITCH_POS = new THREE.Vector3(-2.246, 1.2, -2.1); // Blender (-2.246, 2.1, 1.2): the wall switch by the fridge (flush on the wall since v08)
const SWITCH_HIT = 0.2;      // metres; the click target is at least SWITCH_MIN_PX in radius on screen
const SWITCH_MIN_PX = 20;
/* hot zones: a quiet ring floating at a point in the room; the ring's area is the click target (not the prop's shape).
   hot = id in hotspots.ts (0 = the light switch, which toggles day / night). pos in three coords (x, z_blender, -y_blender), r in metres. */
const frame = (y0: number, y1: number) =>   // a jersey frame's front face (Blender y range; z 1.62..2.60, x -2.19) as four corners in three coords
  [[1.62, y0], [1.62, y1], [2.6, y1], [2.6, y0]].map(([z, y]) => new THREE.Vector3(-2.19, z, -y));
const ZONES: { key: string; pos: THREE.Vector3; r: number; hot: number; quad?: THREE.Vector3[]; action?: 'mask' }[] = [
  { key: 'switch', pos: SWITCH_POS, r: SWITCH_HIT, hot: 0 },
  // props: generous circles around the whole prop
  { key: 'golf', pos: new THREE.Vector3(1.876, 0.7, 1.999), r: 0.6, hot: 1 },
  { key: 'skis', pos: new THREE.Vector3(-1.298, 1.05, 2.167), r: 0.62, hot: 5 },
  { key: 'bike', pos: new THREE.Vector3(-1.907, 0.92, 1.76), r: 0.62, hot: 6 },
  { key: 'books', pos: new THREE.Vector3(1.946, 0.67, -0.842), r: 0.32, hot: 7 },
  // goalie mask: opens the turntable inspector on the page (no link)
  { key: 'mask', pos: new THREE.Vector3(1.909, 0.58, -1.803), r: 0.24, hot: 0, action: 'mask' },
  // jerseys: the clickable area is exactly the frame
  { key: 'jersey-price', pos: new THREE.Vector3(-2.19, 2.11, 1.25), r: 0, hot: 8, quad: frame(-1.68, -0.82) },
  { key: 'jersey-ninety', pos: new THREE.Vector3(-2.19, 2.11, 0.33), r: 0, hot: 11, quad: frame(-0.76, 0.1) },
  { key: 'jersey-ten', pos: new THREE.Vector3(-2.19, 2.11, -0.59), r: 0, hot: 9, quad: frame(0.16, 1.02) },
  { key: 'jersey-crosby', pos: new THREE.Vector3(-2.19, 2.11, -1.51), r: 0, hot: 10, quad: frame(1.08, 1.94) },
];
/* screens stay directly clickable (GPU pick on the prop itself): monitor, laptop, phone. Only the cursor changes over them. */
const SCREEN_IDS = new Set([2, 3, 4]);

const FADE_S = 0.7;          // day <-> night crossfade seconds
const DAY_BG = new THREE.Color('#9499a1'), NIGHT_BG = new THREE.Color('#08090b'); // page backdrop = Cycles world colour per state
const WIN_DAY = new THREE.Color('#b7b9b7'), WIN_NIGHT = new THREE.Color('#12161a');
const SUB_DAY = new THREE.Color('#130e0a'), SUB_NIGHT = new THREE.Color('#030202');

const BASE = import.meta.env.BASE_URL;
const ASSETS = `${BASE}rt/`;
const ATLASES = ['rt_P1', 'rt_J', 'rt_P2', 'rt_P3', 'rt_P4', 'rt_P5', 'rt_B', 'rt_F', 'rt_H', 'rt_G', 'rt_DW', 'rt_Q', 'rt_V', 'rt_U', 'rt_FR', 'rt_SW', 'rt_K']; // SW = the wall light switch on its own atlas with wide gutters (stays white at every mip level); // FR = the one-piece jersey frames (v13);  five prop groups, walls, floor, clock hands, jersey/fridge glass reflections, wall patch,
// wine liquid (real, level geometry) and the wine glasses + decanter (cut away in front of the wine), patch layer for partly visible triangles (V),
// re-unwrapped objects (U: skis, head covers, tyres, clock case, chain), clock face
const NIGHT_ATLASES = ATLASES.filter((a) => a !== 'rt_K'); // the crystal-face test overlay stays day-only
const Q = new URLSearchParams(location.search);
const GLASS = Q.get('g') !== '0', FACE = Q.get('k') === '1', GSTR = parseFloat(Q.get('gs') ?? '1'), PATCH = Q.get('v') !== '0', MIP = Q.get('mip') !== '0';
const START_NIGHT = Q.get('night') === '1';
if (Q.get('zones') === '1') document.body.classList.add('show-zones');   // test flag: draw the (normally invisible) hot zones
const DEBUG = Q.get('debug') === '1';   // test flag: shows the Compare / Reset / Lights buttons
const A2C = Q.get('a2c') === '1';   // test flag: alpha-to-coverage on the cut-out atlases (off: it striped the monitor, whose texels carry alpha < 1)
const HIDE = (Q.get('hide') ?? '').split(',').filter(Boolean).map((h) => (h.startsWith('rt_') ? h : `rt_${h}`));   // test flag: ?hide=W,V drops those layers
const ROOM = Q.get('room') ? `room_${Q.get('room')}.json` : 'room.json';   // test flag: ?room=<name> loads rt/room_<name>.json
const ORDER: Record<string, number> = { rt_K: 10, rt_H: 11, rt_G: 20, rt_Z: 30 };

type View = { yaw: number; pitch: number; zoom: number; ox: number; oy: number };
type Ctl = { cur: View; goal: View; vel: View; smooth: number };
/** Shared light state: t = linear 0 (day) .. 1 (night) crossfade position, u.value = eased value the shaders read. */
type Env = { t: number; target: number; u: { value: number }; nightReady: boolean };
type Sw = { x: number; y: number; r: number; q?: number[] };   // q: screen corners (x0,y0,..x3,y3) of a rectangular zone

const hero = (): View => ({ yaw: 0, pitch: PITCH0, zoom: 1, ox: 0, oy: 0 });
/** test flag ?view=yawDeg,pitchDeg,zoom,ox,oy : start (and stay, until touched) at that view; for automated screenshots */
const start = (): View => {
  const v = (Q.get('view') ?? '').split(',').map(Number);
  return v.length === 5 && v.every(Number.isFinite) ? { yaw: v[0] * D2R, pitch: v[1] * D2R, zoom: v[2], ox: v[3], oy: v[4] } : hero();
};
const zero = (): View => ({ yaw: 0, pitch: 0, zoom: 0, ox: 0, oy: 0 });
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const smooth01 = (t: number) => t * t * (3 - 2 * t);

/** Critically damped spring (Unity-style SmoothDamp): follows `goal` without overshoot, frame-rate independent. */
function smoothDamp(c: View, g: View, vel: View, key: keyof View, smoothTime: number, dt: number) {
  const omega = 2 / Math.max(1e-4, smoothTime), x = omega * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = c[key] - g[key], temp = (vel[key] + omega * change) * dt;
  vel[key] = (vel[key] - omega * temp) * e;
  c[key] = g[key] + (change + temp) * e;
}
const VIEW_KEYS: (keyof View)[] = ['yaw', 'pitch', 'zoom', 'ox', 'oy'];
/** true while the camera is still travelling (dragging, zooming or springing back) */
const viewMoving = (c: Ctl) => VIEW_KEYS.some((k) => Math.abs(c.cur[k] - c.goal[k]) > 1e-4 || Math.abs(c.vel[k]) > 1e-3);

type Prim = { mat: string; nv: number; ni: number; min: number[]; span: number[]; hot?: number; part?: 'hour' | 'min' | 'mask'; baked?: number; pivot?: number[] };

/* goalie-mask inspector: click the mask and the camera zooms in on it, a fully baked copy (every side, studio-lit) lifts off the console and
   floats; drag spins it, a click or Esc puts it back. The resting mask (part of the room's atlases, hot id MASK_HOT) is hidden meanwhile. */
/** Which goalie-mask experience a click on the mask gives. Default: the pop-up with the studio turntable video (MaskViewer).
 *  Add ?float=1 to the URL for the in-room version (camera zooms in, a fully baked 3D copy floats and spins) - saved for later, see the project doc. */
const FLOAT_MASK = typeof location !== 'undefined' && new URLSearchParams(location.search).has('float');
const MASK_HOT = 12, MASK_LIFT = 0.2, MASK_ZOOM = 8;
const MASK_PIVOT = new THREE.Vector3(1.94, 0.71, -1.803);   // centre of the mask, three coords
const INSPECT = { on: false, t: 0, yaw: 0, pitch: 0, grab: false, idle: 0, ready: false };   // ready: the floating copy has downloaded
const HIDE_HOT = { value: 0 };   // hot id whose surfaces the room shaders skip (the resting mask while its floating copy is shown)
const inspectView = (): View => {   // hero angle, centred on the floating mask
  const d = new THREE.Vector3(Math.cos(PITCH0) * Math.sin(YAW0), Math.sin(PITCH0), Math.cos(PITCH0) * Math.cos(YAW0));
  const x = new THREE.Vector3(0, 1, 0).cross(d).normalize(), y = d.clone().cross(x);
  const P = MASK_PIVOT.clone().add(new THREE.Vector3(0, MASK_LIFT, 0)).sub(PIVOT);
  return { yaw: 0, pitch: PITCH0, zoom: MASK_ZOOM, ox: P.dot(x), oy: P.dot(y) };
};

/* wall clock: hands turn about the clock centre (Blender (1.744, -2.25, 1.76), axis +Y) to the visitor's local time */
const CLOCK_PIVOT = new THREE.Vector3(1.744, 1.76, 2.25);
const CLOCK_TEST = Q.get('clock');   // test flag ?clock=15:00 freezes the hands at that time

/* hovered / selected hotspot id (0 = none): every room material reads it and lightens that prop */
const HOVER = { value: 0 };
const IN_FRAME = (() => { try { return window.self !== window.top; } catch { return true; } })();

/** Loads rt/room.json: quantized, delta-coded, gzipped geometry (see tools/pack_room.py). No decoder files needed. */
/** Line icons for the page links (24x24, stroke follows the page lettering colour). */
function Glyph({ name }: { name: LinkIcon }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return (
    <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true" focusable="false">
      {name === 'linkedin' && <g {...p}><rect x="3.5" y="3.5" width="17" height="17" rx="3.5" /><path d="M8.2 10.4v5.6M8.2 7.9v.1M12 16v-5.6M12 13c0-1.6.9-2.6 2.3-2.6 1.4 0 2.2 1 2.2 2.6V16" /></g>}
      {name === 'email' && <g {...p}><rect x="3" y="5.5" width="18" height="13" rx="2.5" /><path d="m4 7.5 8 6 8-6" /></g>}
      {name === 'instagram' && <g {...p}><rect x="3.5" y="3.5" width="17" height="17" rx="5" /><circle cx="12" cy="12" r="3.9" /><path d="M17 7v.01" /></g>}
    </svg>
  );
}

/** Smooth vertex normals shared by position (vertices are split along UV seams, which would otherwise show as creases). */
function smoothNormals(g: THREE.BufferGeometry) {
  const pos = g.getAttribute('position').array as Float32Array, idx = g.getIndex()!.array as Uint32Array, nv = pos.length / 3;
  const key = (i: number) => `${Math.round(pos[i * 3] * 2e4)},${Math.round(pos[i * 3 + 1] * 2e4)},${Math.round(pos[i * 3 + 2] * 2e4)}`;
  const acc = new Map<string, THREE.Vector3>(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let t = 0; t < idx.length; t += 3) {
    a.fromArray(pos, idx[t] * 3); b.fromArray(pos, idx[t + 1] * 3); c.fromArray(pos, idx[t + 2] * 3);
    n.copy(b).sub(a).cross(c.sub(a));   // area-weighted face normal
    for (let k = 0; k < 3; k++) { const kk = key(idx[t + k]); const v = acc.get(kk); if (v) v.add(n); else acc.set(kk, n.clone()); }
  }
  const nor = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) { const v = acc.get(key(i)); if (v) { n.copy(v).normalize(); nor[i * 3] = n.x; nor[i * 3 + 1] = n.y; nor[i * 3 + 2] = n.z; } }
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
}

async function loadRoom(url: string) {
  const j: { prims: Prim[]; gz: string } = await (await fetch(url)).json();
  const packed = Uint8Array.from(atob(j.gz), (c) => c.charCodeAt(0));
  const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let o = 0;
  const u16 = (n: number, comps: number, fn: (i: number, c: number, v: number) => void) => {
    const lo = buf.subarray(o, o + n * comps), hi = buf.subarray(o + n * comps, o + 2 * n * comps);
    o += 2 * n * comps;
    const acc = new Array(comps).fill(0);
    for (let i = 0; i < n; i++) for (let c = 0; c < comps; c++) {
      const k = i * comps + c;
      acc[c] = (acc[c] + (lo[k] | (hi[k] << 8))) & 0xffff;
      fn(i, c, acc[c]);
    }
  };
  return j.prims.map((p) => {
    const pos = new Float32Array(p.nv * 3), uv = new Float32Array(p.nv * 2), idx = new Uint32Array(p.ni);
    u16(p.nv, 3, (i, c, v) => { pos[i * 3 + c] = p.min[c] + (v / 65535) * p.span[c]; });
    u16(p.nv, 2, (i, c, v) => { uv[i * 2 + c] = v / 65535; });
    const b0 = buf.subarray(o, o + p.ni), b1 = buf.subarray(o + p.ni, o + 2 * p.ni),
      b2 = buf.subarray(o + 2 * p.ni, o + 3 * p.ni), b3 = buf.subarray(o + 3 * p.ni, o + 4 * p.ni);
    o += 4 * p.ni;
    // per-vertex hotspot id (pack_v10.py): which clickable prop a vertex belongs to, 0 = none
    const hot = p.hot ? buf.slice(o, o + p.nv) : new Uint8Array(p.nv);
    if (p.hot) o += p.nv;
    let acc = 0;
    for (let i = 0; i < p.ni; i++) {
      const z = (b0[i] | (b1[i] << 8) | (b2[i] << 16) | (b3[i] << 24)) >>> 0;
      acc += (z >>> 1) ^ -(z & 1); // zigzag
      idx[i] = acc;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setAttribute('hot', new THREE.BufferAttribute(hot, 1));
    g.computeBoundingSphere();
    if (p.mat === 'rt_Z' || p.part === 'mask') smoothNormals(g);   // surfaces shaded live (glass, the floating mask's sheen) need normals
    const pv = p.part === 'mask' ? MASK_PIVOT : CLOCK_PIVOT;
    if (p.part) g.translate(-pv.x, -pv.y, -pv.z);   // moving parts: geometry around its pivot, placed by a group
    return { mat: p.mat, geometry: g, part: p.part, baked: p.baked ?? 0 };
  });
}

/** Wine glasses and decanter: real see-through glass, shaded live so it is right from every angle (a baked picture of what was seen
 *  through the glass only holds from the one view it was baked at). Clear in the middle, brighter toward the silhouette (Fresnel), with a
 *  window highlight by day and a Tron-blue rim at night. Drawn after everything else, without writing depth. */
function glassMaterial(uMix: { value: number }) {
  return new THREE.ShaderMaterial({
    uniforms: { uMix },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: `varying vec3 vN; varying vec3 vV;
      void main() {
        vN = mat3(modelMatrix) * normal;
        vV = normalize(vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));   // orthographic: one view direction for the whole scene
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `uniform float uMix; varying vec3 vN; varying vec3 vV;
      void main() {
        // guarded: a zero normal or pow() of a slightly negative number is NaN on real GPUs, and a NaN pixel is simply not drawn
        vec3 N = dot(vN, vN) > 1e-8 ? normalize(vN) : vV; float nv = clamp(abs(dot(N, vV)), 0.0, 1.0);
        float fres = pow(max(1.0 - nv, 1e-4), 1.7);
        vec3 R = reflect(-vV, dot(N, vV) < 0.0 ? -N : N);
        float win = pow(max(dot(R, normalize(vec3(-0.25, 0.55, -0.8))), 0.0), 48.0);          // the window wall
        float lamp = pow(max(dot(R, normalize(vec3(-0.7, 0.6, 0.35))), 0.0), 90.0);            // desk side
        vec3 day = mix(vec3(0.80, 0.84, 0.88), vec3(1.0), fres) + vec3(1.0) * (win * 0.9 + lamp * 0.5);
        vec3 night = mix(vec3(0.03, 0.10, 0.14), vec3(0.12, 0.62, 0.80), fres) + vec3(0.12, 0.78, 1.0) * (win * 0.25 + lamp * 0.5);
        float aDay = 0.10 + 0.62 * fres + win * 0.8 + lamp * 0.5, aNight = 0.07 + 0.48 * fres + lamp * 0.5;
        gl_FragColor = vec4(mix(day, night, uMix), clamp(mix(aDay, aNight, uMix), 0.0, 0.95));
      }`,
  });
}

function Room({ onReady, env, onNightReady }: { onReady: () => void; env: React.MutableRefObject<Env>; onNightReady: () => void }) {
  const parts = suspend(loadRoom, [`${ASSETS}${ROOM}`]);
  const maps = useLoader(THREE.TextureLoader, ATLASES.map((a) => `${ASSETS}${a}.webp`));
  const gl = useThree((s) => s.gl);
  const subFloor = useRef<THREE.MeshBasicMaterial>(null!), windowPanel = useRef<THREE.MeshBasicMaterial>(null!);
  const prep = useCallback((t: THREE.Texture) => {
    t.flipY = false; // UVs follow the glTF convention
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = gl.capabilities.getMaxAnisotropy();
    t.generateMipmaps = MIP;
    t.minFilter = MIP ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }, [gl]);

  // every atlas material blends its day texture (map) with its night texture (mapN) by the shared uniform uMix
  const night = useRef<Record<string, { value: THREE.Texture }>>({});
  const mats = useMemo(() => {
    const byName: Record<string, THREE.Material> = {};
    ATLASES.forEach((a, i) => {
      const t = prep(maps[i]);
      let m: THREE.MeshBasicMaterial;
      if (a === 'rt_G') {   // glass reflections (jersey frames, fridge door): added on top, never writes depth
        m = new THREE.MeshBasicMaterial({ map: t, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: GSTR });
      } else if (a === 'rt_K') {   // clock face as seen through the crystal (bake test)
        m = new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false });
      } else if (a === 'rt_H') {   // clock hands draw after the face disc
        m = new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide, transparent: true });
      } else {
        // rt_P1 / rt_J / rt_Z carry a cut-out mask in their alpha channel (jersey mat openings, jersey silhouettes, glass in front of the wine)
        const cut = a === 'rt_P1' || a === 'rt_J';
        // alpha-to-coverage turns the hard cut-out edges (mat openings, jersey outlines) into antialiased ones, so they don't shimmer in motion
        m = new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide, alphaTest: cut ? 0.5 : 0, alphaToCoverage: cut && A2C });
      }
      // the V patch layer repeats some main-atlas triangles exactly (monitor screen, wall top strip, frame edges) with poorer texels; coplanar
      // copies z-fight (flicker) and, when V wins, stripe the surface. Push V a hair away from the camera: the main atlas always wins a tie,
      // and V still fills every spot where it is the only surface.
      if (NIGHT_ATLASES.includes(a)) {
        // one uniform per atlas for the life of the page: React StrictMode (the local dev server) builds these materials twice,
        // and the night loader must reach the copy that is actually drawn, so both copies share this object
        const nu = night.current[a] ?? (night.current[a] = { value: t });   // holds the day atlas until the night one arrives
        const hl = a !== 'rt_G';   // hover highlight on everything but the additive glass reflections
        m.onBeforeCompile = (sh) => {
          sh.uniforms.mapN = nu; sh.uniforms.uMix = env.current.u; sh.uniforms.uHot = HOVER; sh.uniforms.uHide = HIDE_HOT;
          sh.fragmentShader = 'uniform sampler2D mapN;\nuniform float uMix;\nuniform float uHot;\nuniform float uHide;\nvarying float vHot;\n' + sh.fragmentShader.replace(
            '#include <map_fragment>',
            `#ifdef USE_MAP
              if ( uHide > 0.5 && abs( vHot - uHide ) < 0.5 ) discard;
              vec4 sampledDiffuseColor = texture2D( map, vMapUv );
              if ( uMix > 0.0 ) sampledDiffuseColor = mix( sampledDiffuseColor, texture2D( mapN, vMapUv ), uMix );
              diffuseColor *= sampledDiffuseColor;
            #endif`).replace('#include <opaque_fragment>', hl ? `if ( uHot > 0.5 && abs( vHot - uHot ) < 0.5 ) outgoingLight = mix( outgoingLight, mix( vec3( 1.0 ), vec3( 0.12, 0.78, 1.0 ), uMix ), 0.2 - 0.12 * uMix );
            #include <opaque_fragment>` : '#include <opaque_fragment>');
          sh.vertexShader = 'attribute float hot;\nvarying float vHot;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vHot = hot;');
        };
        m.customProgramCacheKey = () => (hl ? 'dnh' : 'dn');
      }
      byName[a] = m;
    });
    byName.rt_Z = glassMaterial(env.current.u);
    parts.forEach((p) => { if (p.mat === 'rt_Z' && !p.geometry.getAttribute('normal')) p.geometry.computeVertexNormals(); });   // safety net: glass must always have normals
    return byName;
  }, [maps, prep, env]);

  useEffect(() => { onReady(); }, [onReady]);

  // night atlases download in the background once the day room is up; the switch is live when they are all here
  useEffect(() => {
    let dead = false;
    (async () => {
      const loader = new THREE.TextureLoader();
      for (const a of NIGHT_ATLASES) {
        const t = prep(await loader.loadAsync(`${ASSETS}${a}_n.webp`));
        if (dead) return;
        night.current[a].value = t;
        gl.initTexture(t);   // upload now, so the first toggle doesn't hitch
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      env.current.nightReady = true; onNightReady();
    })().catch((e) => console.warn('night atlases failed', e));
    return () => { dead = true; };
  }, [prep, gl, env, onNightReady]);

  // clock hands: angle = real time minus the time they were baked at (10:10); clockwise on the dial is +z in three
  const hands = useRef<Record<string, THREE.Group | null>>({});
  useFrame(() => {
    const ov = (window as unknown as { __clock?: string }).__clock ?? CLOCK_TEST;
    let h: number, m: number, s: number;
    if (ov) { const [a, b] = ov.split(':').map(Number); h = a; m = b || 0; s = 0; }
    else { const d = new Date(); h = d.getHours(); m = d.getMinutes(); s = d.getSeconds() + d.getMilliseconds() / 1000; }
    const ang: Record<string, number> = { min: (m + s / 60) * 6, hour: ((h % 12) + m / 60 + s / 3600) * 30 };
    parts.forEach((p) => { const gr = p.part ? hands.current[p.part] : null; if (gr) gr.rotation.z = (ang[p.part!] - p.baked) * D2R; });
  });


  // flat stand-ins follow the light state too
  useFrame(() => {
    const m = env.current.u.value;
    subFloor.current.color.lerpColors(SUB_DAY, SUB_NIGHT, m);
    windowPanel.current.color.lerpColors(WIN_DAY, WIN_NIGHT, m);
  });

  return (
    <group>
      {parts.filter((p) => (p.mat !== 'rt_G' || GLASS) && (p.mat !== 'rt_K' || FACE) && (p.mat !== 'rt_V' || PATCH) && !HIDE.includes(p.mat)).map((p, i) => {
        const mesh = <mesh key={i} geometry={p.geometry} material={mats[p.mat]} renderOrder={ORDER[p.mat] ?? 0} userData={{ noPick: p.mat === 'rt_G' || p.mat === 'rt_K' }} />;
        return p.part ? <group key={i} position={CLOCK_PIVOT} ref={(g) => { hands.current[p.part!] = g; }}>{mesh}</group> : mesh;
      })}
      {/* test-only stand-ins: dark sub-floor seen through the plank grooves, and the daylight panel behind the windows */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0]}>
        <planeGeometry args={[4.5, 4.5]} />
        <meshBasicMaterial ref={subFloor} color="#130e0a" />
      </mesh>
      <mesh position={[-0.03, 2.31, 2.41]}>
        <planeGeometry args={[4.0, 0.62]} />
        <meshBasicMaterial ref={windowPanel} color="#b7b9b7" side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

/** The floating copy of the goalie mask: rt/mask.json + rt_MK[_n].webp (6 MB) download in the background once the room is up.
 *  While INSPECT.on it lifts off the console and spins (slow turntable until touched, then by hand); otherwise it is not drawn. */
function MaskModel({ env, start }: { env: React.MutableRefObject<Env>; start: boolean }) {
  const gl = useThree((s) => s.gl), camera = useThree((s) => s.camera);
  const group = useRef<THREE.Group>(null!);
  const [mesh, setMesh] = useState<{ geometry: THREE.BufferGeometry; material: THREE.ShaderMaterial } | null>(null);
  useEffect(() => {
    if (!start) return;
    let dead = false;
    (async () => {
      const [part] = await loadRoom(`${ASSETS}mask.json`);
      const loader = new THREE.TextureLoader();
      const tex = async (n: string) => { const t = await loader.loadAsync(`${ASSETS}${n}.webp`); t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = gl.capabilities.getMaxAnisotropy(); return t; };
      const [day, night] = [await tex('rt_MK'), await tex('rt_MK_n')];
      if (dead) return;
      gl.initTexture(day); gl.initTexture(night);
      const material = new THREE.ShaderMaterial({
        uniforms: { map: { value: day }, mapN: { value: night }, uMix: env.current.u }, side: THREE.DoubleSide,
        vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV;
          void main() { vUv = uv; vN = mat3(modelMatrix) * normal; vV = normalize(vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        // baked colour (no baked reflections) + a live sheen that slides over the paint as the mask turns; matte parts (foam, straps) get almost none
        fragmentShader: `uniform sampler2D map; uniform sampler2D mapN; uniform float uMix; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
          void main() {
            vec3 c = mix(texture2D(map, vUv), texture2D(mapN, vUv), uMix).rgb;
            vec3 N = dot(vN, vN) > 1e-8 ? normalize(vN) : vV; float d = dot(N, vV); if (d < 0.0) N = -N;
            float nv = clamp(abs(d), 0.0, 1.0); vec3 R = reflect(-vV, N);
            float gloss = smoothstep(0.10, 0.45, max(c.r, max(c.g, c.b)));
            float spec = pow(max(dot(R, normalize(vec3(-0.25, 0.75, -0.6))), 0.0), 70.0) * 0.22 + pow(max(dot(R, normalize(vec3(-0.6, 0.5, 0.6))), 0.0), 24.0) * 0.05;
            c += (spec + pow(max(1.0 - nv, 1e-4), 4.0) * 0.06) * gloss * mix(vec3(1.0), vec3(0.25, 0.7, 1.0), uMix * 0.8);
            gl_FragColor = vec4(c, 1.0);
            #include <colorspace_fragment>
          }`,
      });
      setMesh({ geometry: part.geometry, material }); INSPECT.ready = true;
    })().catch((e) => console.warn('mask model failed', e));
    return () => { dead = true; };
  }, [start, gl, env]);
  const mq = useMemo(() => ({ a: new THREE.Quaternion(), b: new THREE.Quaternion(), right: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0) }), []);
  useFrame((_, dtRaw) => {
    const g = group.current, I = INSPECT, dt = Math.min(dtRaw, 0.1); if (!g) return;
    I.t = I.on ? Math.min(1, I.t + dt / 0.55) : Math.max(0, I.t - dt / 0.4);
    const e = smooth01(I.t);
    g.visible = I.t > 0; HIDE_HOT.value = I.t > 0 ? MASK_HOT : 0;
    if (I.on && !I.grab) { I.idle += dt; if (I.idle > 1.2) I.yaw += dt * 0.6; }   // slow turntable when left alone
    if (!I.on) { I.yaw = Math.atan2(Math.sin(I.yaw), Math.cos(I.yaw)) * e; I.pitch *= e; }   // turn back to its resting pose on the way down
    g.position.copy(MASK_PIVOT); g.position.y += MASK_LIFT * e + (I.on ? Math.sin(performance.now() / 900) * 0.006 * e : 0);
    mq.right.setFromMatrixColumn(camera.matrixWorld, 0);
    g.quaternion.copy(mq.a.setFromAxisAngle(mq.right, I.pitch)).multiply(mq.b.setFromAxisAngle(mq.up, I.yaw));
  });
  return <group ref={group} visible={false}>{mesh && <mesh geometry={mesh.geometry} material={mesh.material} userData={{ noPick: true }} />}</group>;
}

/** GPU picking: renders the room once into a 1x1 target at the pointer with every vertex coloured by its hotspot id, so walls and
 *  other props in front block the click exactly as they block the view. */
type PickFn = (clientX: number, clientY: number) => number;
type HoverAt = { x: number; y: number; on: boolean; dirty: boolean };
function Picker({ pickRef, hoverAt, onHover, ctl }: { pickRef: React.MutableRefObject<PickFn | null>; hoverAt: React.MutableRefObject<HoverAt>; onHover: (id: number) => void; ctl: React.MutableRefObject<Ctl> }) {
  const { gl, scene, camera } = useThree();
  const rt = useMemo(() => new THREE.WebGLRenderTarget(1, 1), []);
  const mat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: 'attribute float hot;\nvarying float vHot;\nvoid main() { vHot = hot; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }',
    fragmentShader: 'varying float vHot;\nvoid main() { gl_FragColor = vec4( vHot / 255.0, 0.0, 0.0, 1.0 ); }',
    side: THREE.DoubleSide,
  }), []);
  const px = useMemo(() => new Uint8Array(4), []);
  const last = useRef({ t: 0, id: 0 });
  const pick = useCallback<PickFn>((clientX, clientY) => {
    const cam = camera as THREE.OrthographicCamera, r = gl.domElement.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    if (x < 0 || y < 0 || x >= r.width || y >= r.height) return 0;
    const hidden: THREE.Object3D[] = [];
    scene.traverse((o) => { if (o.userData.noPick && o.visible) { o.visible = false; hidden.push(o); } });
    const cc = gl.getClearColor(new THREE.Color()), ca = gl.getClearAlpha(), prevRT = gl.getRenderTarget();
    cam.setViewOffset(r.width, r.height, Math.floor(x), Math.floor(y), 1, 1);
    scene.overrideMaterial = mat; gl.setRenderTarget(rt); gl.setClearColor(0x000000, 1); gl.clear(); gl.render(scene, cam);
    gl.readRenderTargetPixels(rt, 0, 0, 1, 1, px);
    scene.overrideMaterial = null; gl.setRenderTarget(prevRT); gl.setClearColor(cc, ca); cam.clearViewOffset();
    hidden.forEach((o) => { o.visible = true; });
    const id = px[0];
    return HOT_BY_ID[id] ? id : 0;
  }, [gl, scene, camera, mat, rt, px]);
  useEffect(() => { pickRef.current = pick; return () => { pickRef.current = null; }; }, [pick, pickRef]);
  // hover: picking reads a pixel back from the GPU, which stalls the frame, so it never runs while the camera is moving
  // (that was the stutter in the snapback). It re-picks when the mouse moves (at most every 60 ms) and once when the view comes to rest.
  useFrame(() => {
    const h = hoverAt.current, now = performance.now();
    if (!h.on) return;
    if (viewMoving(ctl.current)) {
      h.dirty = true;
      if (last.current.id) { last.current.id = 0; onHover(0); }
      return;
    }
    if (!h.dirty || now - last.current.t < 60) return;
    last.current.t = now; h.dirty = false;
    const id = pick(h.x, h.y);
    if (id !== last.current.id) { last.current.id = id; onHover(id); }
  });
  return null;
}

function Rig({ ctl, env, sw, hint }: { ctl: React.MutableRefObject<Ctl>; env: React.MutableRefObject<Env>; sw: React.MutableRefObject<Sw[]>; hint: React.MutableRefObject<(HTMLDivElement | null)[]> }) {
  const { camera, size } = useThree();
  const tmp = useMemo(() => new THREE.Vector3(), []);
  const right = useMemo(() => new THREE.Vector3(), []), up = useMemo(() => new THREE.Vector3(), []);
  const bg = useMemo(() => new THREE.Color(), []);
  const lastMix = useRef(-1);
  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.1);
    // light crossfade
    const e = env.current, want = e.nightReady ? e.target : 0;
    if (e.t !== want) { e.t = e.t < want ? Math.min(want, e.t + dt / FADE_S) : Math.max(want, e.t - dt / FADE_S); e.u.value = smooth01(e.t); }
    if (e.u.value !== lastMix.current) {
      lastMix.current = e.u.value;
      bg.lerpColors(DAY_BG, NIGHT_BG, e.u.value); document.body.style.backgroundColor = `#${bg.getHexString()}`;
    }
    // view: spring toward the goal (tight while dragging, softer on the way home)
    const { cur, goal, vel, smooth } = ctl.current;
    for (const key of VIEW_KEYS) smoothDamp(cur, goal, vel, key, smooth, dt);
    const yaw = YAW0 + cur.yaw, cp = Math.cos(cur.pitch);
    const cam = camera as THREE.OrthographicCamera;
    // orbit about the pivot; orientation from yaw/pitch directly (no lookAt), so straight-down stays well defined
    cam.position.set(cp * Math.sin(yaw), Math.sin(cur.pitch), cp * Math.cos(yaw)).multiplyScalar(DIST).add(PIVOT);
    cam.rotation.set(-cur.pitch, yaw, 0, 'YXZ');
    cam.updateMatrix();
    // screen-space offset (zoom-to-cursor), in metres along the camera's right/up axes
    right.setFromMatrixColumn(cam.matrix, 0); up.setFromMatrixColumn(cam.matrix, 1);
    cam.position.addScaledVector(right, cur.ox).addScaledVector(up, cur.oy);
    // bird's eye: the room's diagonal is wider than the hero framing, so ease the view out a little as it tilts toward straight down
    const top = clamp((cur.pitch - PITCH0) / (Math.PI / 2 - PITCH0), 0, 1);
    cam.zoom = (Math.min(size.width, size.height) / ORTHO) * cur.zoom * (1 - 0.1 * top * top);
    cam.near = DIST - 8; cam.far = DIST + 8;
    cam.updateMatrix(); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    // where each hot zone is on screen (click target + ring)
    ZONES.forEach((z, i) => {
      tmp.copy(z.pos).project(cam);
      const s = sw.current[i];
      s.x = (tmp.x * 0.5 + 0.5) * size.width; s.y = (1 - (tmp.y * 0.5 + 0.5)) * size.height;
      s.r = z.quad ? 0 : Math.max(SWITCH_MIN_PX, z.r * cam.zoom);
      if (z.quad) s.q = z.quad.flatMap((c) => { tmp.copy(c).project(cam); return [(tmp.x * 0.5 + 0.5) * size.width, (1 - (tmp.y * 0.5 + 0.5)) * size.height]; });
      const el = hint.current[i];
      if (el) el.style.transform = `translate3d(${s.x}px,${s.y}px,0)`;
    });
  });
  return null;
}

export default function Lab() {
  const ctl = useRef<Ctl>({ cur: start(), goal: start(), vel: zero(), smooth: SNAP.followTime });
  const env = useRef<Env>({ t: START_NIGHT ? 1 : 0, target: START_NIGHT ? 1 : 0, u: { value: START_NIGHT ? 1 : 0 }, nightReady: false });
  const sw = useRef<Sw[]>(ZONES.map(() => ({ x: -999, y: -999, r: 0 })));
  const hint = useRef<(HTMLDivElement | null)[]>([]);
  const el = useRef<HTMLDivElement>(null!);
  const [cmp, setCmp] = useState(false);
  const [ready, setReady] = useState(false);
  const [nightReady, setNightReady] = useState(false);
  const [dark, setDark] = useState(START_NIGHT);
  const [hover, setHover] = useState(-1);   // hot zone under the mouse (index into ZONES), -1 = none
  const onReady = useCallback(() => setReady(true), []);
  const onNightReady = useCallback(() => setNightReady(true), []);
  const [box, setBox] = useState({ s: 0, x: 0, y: 0 });
  // clickable props
  const pickRef = useRef<PickFn | null>(null);
  const hoverAt = useRef<HoverAt>({ x: 0, y: 0, on: false, dirty: false });
  const [hot, setHot] = useState(0);
  const [card, setCard] = useState<{ id: number; x: number; y: number } | null>(null);
  const [mask, setMaskState] = useState(false);   // goalie-mask inspector open
  const setMask = useCallback((on: boolean) => {
    if (!FLOAT_MASK) { setMaskState(on); return; }   // pop-up version: MaskViewer
    if (on && !INSPECT.ready) return;   // still downloading
    const c = ctl.current; INSPECT.on = on; INSPECT.grab = false; INSPECT.idle = 0;
    c.goal = on ? inspectView() : hero(); c.smooth = on ? 0.22 : SNAP.returnTime;
    setMaskState(on);
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && INSPECT.on) setMask(false); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [setMask]);
  const onHover = useCallback((id: number) => { setHot(SCREEN_IDS.has(id) ? id : 0); }, []);
  useEffect(() => {
    if (el.current) el.current.style.cursor = hot ? 'pointer' : '';
  }, [hot, card]);
  const activate = useCallback((id: number, x: number, y: number) => {
    const h = HOT_BY_ID[id]; if (!h) return;
    if (!IN_FRAME) {   // the real site: open straight away in a new tab
      const w = window.open(h.url, '_blank', 'noopener');
      if (w) return;
    }
    setCard({ id, x, y });   // inside a sandboxed frame (the artifact viewer) or if a popup was blocked: a card with a real link
  }, []);

  const toggle = useCallback(() => {
    setDark((d) => { env.current.target = d ? 0 : 1; return !d; });
  }, []);

  // layout for the Cycles reference overlay (only lines up at the hero view)
  useEffect(() => {
    const fit = () => {
      const w = window.innerWidth, h = window.innerHeight, s = Math.min(w, h);
      setBox({ s, x: (w - s) / 2, y: (h - s) / 2 });
    };
    fit(); window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  useEffect(() => {
    (window as unknown as { __lab: unknown }).__lab = { ctl, env, sw, pick: (x: number, y: number) => pickRef.current?.(x, y) ?? -1 };
    const node = el.current;
    const pts = new Map<number, { x: number; y: number }>();
    const raw = { yaw: 0, pitch: 0 };           // un-rubbered drag position (radians, absolute; soft() maps it into range)
    let pinch0 = 0, zoom0 = 1, homeTimer = 0, hov = -1;
    let tap: { x: number; y: number; t: number; zone: number } | null = null;
    const zoneAt = (x: number, y: number) => {   // index of the hot zone under a screen point, -1 = none. Frames (rectangles) first, then the nearest circle.
      const r = node.getBoundingClientRect(), px = x - r.left, py = y - r.top; let best = -1, bd = Infinity;
      for (let i = 0; i < sw.current.length; i++) {
        const q = sw.current[i].q; if (!q) continue;
        let inside = false;   // point in polygon (ray casting)
        for (let a = 0, b = 3; a < 4; b = a++) {
          const ax = q[a * 2], ay = q[a * 2 + 1], bx = q[b * 2], by = q[b * 2 + 1];
          if ((ay > py) !== (by > py) && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) inside = !inside;
        }
        if (inside) return i;
      }
      sw.current.forEach((s, i) => { if (s.q) return; const d = Math.hypot(px - s.x, py - s.y); if (d <= s.r && d / s.r < bd) { bd = d / s.r; best = i; } });
      return best;
    };
    const clampOffset = (g: View) => {
      const lim = (ORTHO / 2) * (1 - 1 / g.zoom);
      g.ox = Math.max(-lim, Math.min(lim, g.ox)); g.oy = Math.max(-lim, Math.min(lim, g.oy));
    };
    const zoomAt = (factor: number, cx: number, cy: number) => {
      const g = ctl.current.goal;
      const z1 = Math.max(1, Math.min(ZOOM_MAX, g.zoom * factor));
      const r = node.getBoundingClientRect(), s = Math.min(r.width, r.height);
      const px = (cx - r.left - r.width / 2) / s * ORTHO, py = -(cy - r.top - r.height / 2) / s * ORTHO;
      g.ox += px * (1 / g.zoom - 1 / z1); g.oy += py * (1 / g.zoom - 1 / z1);
      g.zoom = z1; clampOffset(g); setCmp(false);
    };
    // snapback: any interaction cancels a pending return; letting go starts it on the same frame. The spring keeps the
    // velocity the view already has, so the hand-off from your drag to the return is one continuous motion.
    const cancelHome = () => { clearTimeout(homeTimer); ctl.current.smooth = SNAP.followTime; };
    const home = () => { clearTimeout(homeTimer); const c = ctl.current; c.goal = hero(); c.smooth = SNAP.returnTime; };
    const syncRaw = () => {   // grabbed mid-return: carry on from exactly where the view is now (no jump)
      const c = ctl.current.cur;
      raw.yaw = unsoft(c.yaw, SNAP.yawMin, SNAP.yawMax, SNAP.band);
      raw.pitch = unsoft(c.pitch, SNAP.pitchMin, SNAP.pitchMax, SNAP.band);
    };
    const down = (e: PointerEvent) => {
      node.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      hoverAt.current.on = false; setCard(null);
      if (INSPECT.on) {   // inspecting the mask: a drag spins it, a click puts it back
        clearTimeout(homeTimer); INSPECT.grab = true; INSPECT.idle = 0;
        tap = pts.size === 1 ? { x: e.clientX, y: e.clientY, t: performance.now(), zone: -2 } : null;
        return;
      }
      if (pts.size === 1) {
        cancelHome(); syncRaw();
        ctl.current.goal.yaw = ctl.current.cur.yaw; ctl.current.goal.pitch = ctl.current.cur.pitch;
        tap = { x: e.clientX, y: e.clientY, t: performance.now(), zone: zoneAt(e.clientX, e.clientY) };
      } else tap = null;
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); zoom0 = ctl.current.goal.zoom; cancelHome(); }
    };
    const move = (e: PointerEvent) => {
      const p = pts.get(e.pointerId);
      if (!p) {   // hovering: pointer cursor + label over the light switch
        if (e.pointerType === 'mouse') {
          const h = INSPECT.on ? -1 : zoneAt(e.clientX, e.clientY);
          if (INSPECT.on) hoverAt.current.on = false;
          if (h !== hov) { hov = h; setHover(h); node.style.cursor = h >= 0 ? 'pointer' : ''; }
          const ha = hoverAt.current; ha.x = e.clientX; ha.y = e.clientY; ha.on = h < 0 && !INSPECT.on; ha.dirty = true;
          if (h >= 0) setHot(0);
        }
        return;
      }
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      const g = ctl.current.goal;
      if (INSPECT.on) {
        if (pts.size === 1) {
          INSPECT.yaw += dx * 0.011; INSPECT.pitch = clamp(INSPECT.pitch + dy * 0.009, -1.3, 1.3); INSPECT.idle = 0;
          if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 6) tap = null;
        }
        return;
      }
      if (pts.size === 1) {
        const s = Math.min(node.clientWidth, node.clientHeight);
        const b2 = 2.5 * SNAP.band;   // how far past a stop the finger can go before it stops counting (so reversing responds at once)
        raw.yaw = clamp(raw.yaw - (dx / s) * SNAP.dragYaw, SNAP.yawMin - b2, SNAP.yawMax + b2);
        raw.pitch = clamp(raw.pitch + (dy / s) * SNAP.dragPitch, SNAP.pitchMin - b2, SNAP.pitchMax + b2);
        g.yaw = soft(raw.yaw, SNAP.yawMin, SNAP.yawMax, SNAP.band);
        g.pitch = soft(raw.pitch, SNAP.pitchMin, SNAP.pitchMax, SNAP.band);
        if (dx || dy) setCmp(false);
        if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 6) tap = null;
      } else if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const f = (zoom0 * d) / pinch0 / g.zoom;
        zoomAt(f, (a.x + b.x) / 2, (a.y + b.y) / 2);
      }
    };
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      if (INSPECT.on) {
        INSPECT.grab = pts.size > 0;
        if (tap && tap.zone === -2 && e.type === 'pointerup' && performance.now() - tap.t < 500) setMask(false);
        tap = null; return;
      }
      if (tap && e.type === 'pointerup' && pts.size === 0 && performance.now() - tap.t < 500) {
        if (tap.zone >= 0) {   // a tap inside a hot zone
          if (zoneAt(e.clientX, e.clientY) === tap.zone) { const z = ZONES[tap.zone]; if (z.action === 'mask') setMask(true); else if (z.hot) activate(z.hot, e.clientX, e.clientY); else toggle(); }
        } else {   // a tap on a screen (monitor, laptop, phone)
          const id = pickRef.current ? pickRef.current(e.clientX, e.clientY) : 0;
          if (SCREEN_IDS.has(id)) activate(id, e.clientX, e.clientY);
        }
      }
      tap = null;
      if (e.pointerType === 'mouse' && pts.size === 0) { const ha = hoverAt.current; ha.x = e.clientX; ha.y = e.clientY; ha.on = true; ha.dirty = true; }
      if (pts.size === 0 && !INSPECT.on) home();   // (a tap that just opened the mask inspector keeps its zoomed view)
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault(); if (INSPECT.on) return;
      cancelHome();
      zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), e.clientX, e.clientY);
      if (pts.size === 0) homeTimer = window.setTimeout(home, SNAP.wheelIdle * 1000);   // springs back as soon as the scrolling stops
    };
    const leave = () => { hoverAt.current.on = false; setHot(0); hov = -1; setHover(-1); };
    const dbl = (e: MouseEvent) => {
      if (INSPECT.on) return;
      if (zoneAt(e.clientX, e.clientY) >= 0) return;
      if (pickRef.current && SCREEN_IDS.has(pickRef.current(e.clientX, e.clientY))) return;   // double-clicking a prop doesn't reset the view   // two quick clicks on the switch are two toggles, not a reset
      home();
    };
    node.addEventListener('pointerdown', down); node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up); node.addEventListener('pointercancel', up);
    node.addEventListener('wheel', wheel, { passive: false }); node.addEventListener('dblclick', dbl); node.addEventListener('pointerleave', leave);
    return () => {
      node.removeEventListener('pointerleave', leave);
      clearTimeout(homeTimer);
      node.removeEventListener('pointerdown', down); node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up); node.removeEventListener('pointercancel', up);
      node.removeEventListener('wheel', wheel); node.removeEventListener('dblclick', dbl);
    };
  }, [toggle, activate, setMask]);

  const home = () => { const c = ctl.current; c.goal = hero(); c.smooth = SNAP.returnTime; };
  const compare = () => {
    if (!cmp) { home(); setTimeout(() => setCmp(true), 1100); } else setCmp(false);
  };

  return (
    <>
      <div className="lab" ref={el}>
        <Canvas orthographic flat gl={{ antialias: true }} dpr={[1, Math.min(2.5, window.devicePixelRatio || 1)]}
          camera={{ position: [11.55, 12.9, -11.55], near: 0.1, far: 100 }}>
          <Suspense fallback={null}>
            <Room onReady={onReady} env={env} onNightReady={onNightReady} />
          </Suspense>
          {FLOAT_MASK && <MaskModel env={env} start={nightReady} />}
          <Rig ctl={ctl} env={env} sw={sw} hint={hint} />
          <Picker pickRef={pickRef} hoverAt={hoverAt} onHover={onHover} ctl={ctl} />
        </Canvas>
      </div>
      <img className={`ref ${cmp ? 'on' : ''}`} src={`${ASSETS}cycles_ref.webp`} alt=""
        style={{ left: box.x, top: box.y, width: box.s, height: box.s }} />
      {ZONES.map((z, i) => (
        <div key={z.key} ref={(e) => { hint.current[i] = e; }} className={`zone z-${z.key} ${hover === i ? 'hover' : ''} ${ready && (z.key !== 'switch' || nightReady) ? 'live' : ''}`} aria-hidden>
          <div className="ring" /><div className="dot" />
          <div className="tag">{z.action === 'mask' ? 'Goalie mask' : z.hot ? HOT_BY_ID[z.hot].label : dark ? 'Lights on' : 'Lights off'}</div>
        </div>
      ))}
      <div className={`chrome ${dark ? 'dark' : ''} ${ready ? 'in' : ''} ${mask && FLOAT_MASK ? 'away' : ''}`}>
        <h1 className="name">{NAME}</h1>
        <p className="hint"><span className="pip" />Click around the room</p>
        <nav className="links" aria-label="Contact">
          {LINKS.map((l) => (
            <a key={l.label} href={l.url} aria-label={l.label} title={l.label} target={l.url.startsWith('mailto:') ? undefined : '_blank'} rel="noopener noreferrer"><Glyph name={l.icon} /></a>
          ))}
        </nav>
      </div>
      {DEBUG && (
        <div className="ui">
          <button className={cmp ? 'on' : ''} onClick={compare}>{cmp ? 'Showing Cycles render' : 'Compare to Cycles'}</button>
          <button onClick={() => { home(); setCmp(false); }}>Reset view</button>
          <button onClick={toggle} disabled={!nightReady}>{nightReady ? (dark ? 'Lights on' : 'Lights off') : 'Loading night…'}</button>
        </div>
      )}
      {card && (
        <div className="hot-card" style={{ left: card.x, top: card.y }} onPointerDown={(e) => e.stopPropagation()}>
          <a href={HOT_BY_ID[card.id].url} target="_blank" rel="noopener noreferrer" onClick={() => setCard(null)}>{HOT_BY_ID[card.id].label} ↗</a>
          <button aria-label="Close" onClick={() => setCard(null)}>×</button>
        </div>
      )}
      {FLOAT_MASK && <div className={`inspect ${mask ? 'on' : ''}`} aria-hidden={!mask}>
        <span>Drag to spin</span><button onClick={() => setMask(false)}>Close ×</button>
      </div>}
      {mask && !FLOAT_MASK && <MaskViewer src={`${BASE}mask/mask_turntable.mp4`} onClose={() => setMask(false)} />}
      {!ready && <div className="loading">Loading</div>}
    </>
  );
}

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber';
import { suspend } from 'suspend-react';
import * as THREE from 'three';
import { HOT_BY_ID } from './hotspots';

/* Camera: orthographic, matched to Blender's iso_camera (ortho_scale 6.62, pointing at (0,0,1.35)) */
const ORTHO = 6.618519;
const PIVOT = new THREE.Vector3(0, 1.35, 0); // blender (0,0,1.35) -> three (x, z, -y)
const YAW0 = Math.atan2(11.55, -11.55); // 135 deg
const PITCH0 = Math.asin(1 / Math.sqrt(3)); // 35.26 deg
const DIST = 20;
const D2R = Math.PI / 180;
const ZOOM_MAX = 4;

/* ---- snapback: how far people may poke around, and how fast the room pulls back. All tunable. ---- */
const SNAP = {
  peekYaw: 22 * D2R,    // a drag can turn the room this far either way (rubber-band: it gets harder the further you go)
  peekUp: 10 * D2R,     // ...and tilt this far up
  peekDown: 8 * D2R,    // ...and this far down
  dragYaw: 2.2,         // drag sensitivity (radians per screen-height of drag)
  dragPitch: 1.6,
  holdAfterDrag: 0.12,  // seconds the view stays put after you let go before it springs back
  holdAfterZoom: 1.4,   // seconds after the last scroll / pinch before the zoom eases back out
  holdAfterPinch: 0.3,
  returnTime: 0.38,     // spring time of the snapback in seconds (smaller = snappier)
  followTime: 0.07,     // how tightly the view follows your finger while you drag
};

/* ---- light switch: where it sits on the wall (three coords, metres) and how big the click target is ---- */
const SWITCH_POS = new THREE.Vector3(-2.246, 1.2, -2.1); // Blender (-2.246, 2.1, 1.2): the wall switch by the fridge (flush on the wall since v08)
const SWITCH_HIT = 0.2;      // metres; the click target is at least SWITCH_MIN_PX in radius on screen
const SWITCH_MIN_PX = 20;
const FADE_S = 0.7;          // day <-> night crossfade seconds
const DAY_BG = new THREE.Color('#9499a1'), NIGHT_BG = new THREE.Color('#43474d'); // page backdrop = Cycles world colour per state
const WIN_DAY = new THREE.Color('#b7b9b7'), WIN_NIGHT = new THREE.Color('#12161a');
const SUB_DAY = new THREE.Color('#130e0a'), SUB_NIGHT = new THREE.Color('#030202');

const BASE = import.meta.env.BASE_URL;
const ASSETS = `${BASE}rt/`;
const ATLASES = ['rt_P1', 'rt_J', 'rt_P2', 'rt_P3', 'rt_P4', 'rt_P5', 'rt_B', 'rt_F', 'rt_H', 'rt_G', 'rt_W', 'rt_Q', 'rt_Z', 'rt_V', 'rt_U', 'rt_K']; // five prop groups, walls, floor, clock hands, jersey/fridge glass reflections, wall patch,
// wine liquid (real, level geometry) and the wine glasses + decanter (cut away in front of the wine), patch layer for partly visible triangles (V),
// re-unwrapped objects (U: skis, head covers, tyres, clock case, chain), clock face
const NIGHT_ATLASES = ATLASES.filter((a) => a !== 'rt_K'); // the crystal-face test overlay stays day-only
const Q = new URLSearchParams(location.search);
const GLASS = Q.get('g') !== '0', FACE = Q.get('k') === '1', GSTR = parseFloat(Q.get('gs') ?? '1'), PATCH = Q.get('v') !== '0', MIP = Q.get('mip') !== '0';
const START_NIGHT = Q.get('night') === '1';
const ROOM = Q.get('room') ? `room_${Q.get('room')}.json` : 'room.json';   // test flag: ?room=<name> loads rt/room_<name>.json
const ORDER: Record<string, number> = { rt_K: 10, rt_H: 11, rt_G: 20 };

type View = { yaw: number; pitch: number; zoom: number; ox: number; oy: number };
type Ctl = { cur: View; goal: View; vel: View; smooth: number };
/** Shared light state: t = linear 0 (day) .. 1 (night) crossfade position, u.value = eased value the shaders read. */
type Env = { t: number; target: number; u: { value: number }; nightReady: boolean };
type Sw = { x: number; y: number; r: number };

const hero = (): View => ({ yaw: 0, pitch: PITCH0, zoom: 1, ox: 0, oy: 0 });
const zero = (): View => ({ yaw: 0, pitch: 0, zoom: 0, ox: 0, oy: 0 });
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const smooth01 = (t: number) => t * t * (3 - 2 * t);

/** Critically damped spring (Unity-style SmoothDamp): follows `goal` without overshoot, frame-rate independent. */
function smoothDamp(cur: number, goal: number, vel: { v: number }, smoothTime: number, dt: number) {
  const omega = 2 / Math.max(1e-4, smoothTime), x = omega * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - goal, temp = (vel.v + omega * change) * dt;
  vel.v = (vel.v - omega * temp) * e;
  return goal + (change + temp) * e;
}

type Prim = { mat: string; nv: number; ni: number; min: number[]; span: number[]; hot?: number; part?: 'hour' | 'min'; baked?: number };

/* wall clock: hands turn about the clock centre (Blender (1.744, -2.25, 1.76), axis +Y) to the visitor's local time */
const CLOCK_PIVOT = new THREE.Vector3(1.744, 1.76, 2.25);
const CLOCK_TEST = Q.get('clock');   // test flag ?clock=15:00 freezes the hands at that time

/* hovered / selected hotspot id (0 = none): every room material reads it and lightens that prop */
const HOVER = { value: 0 };
const IN_FRAME = (() => { try { return window.self !== window.top; } catch { return true; } })();

/** Loads rt/room.json: quantized, delta-coded, gzipped geometry (see tools/pack_room.py). No decoder files needed. */
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
    if (p.part) g.translate(-CLOCK_PIVOT.x, -CLOCK_PIVOT.y, -CLOCK_PIVOT.z);   // hands: geometry around the pivot, placed by a group
    return { mat: p.mat, geometry: g, part: p.part, baked: p.baked ?? 0 };
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
        m = new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide, alphaTest: a === 'rt_P1' || a === 'rt_J' || a === 'rt_Z' ? 0.5 : 0 });
      }
      if (NIGHT_ATLASES.includes(a)) {
        const nu = { value: t };   // placeholder until the night atlas has downloaded
        night.current[a] = nu;
        const hl = a !== 'rt_G';   // hover highlight on everything but the additive glass reflections
        m.onBeforeCompile = (sh) => {
          sh.uniforms.mapN = nu; sh.uniforms.uMix = env.current.u; sh.uniforms.uHot = HOVER;
          sh.fragmentShader = 'uniform sampler2D mapN;\nuniform float uMix;\nuniform float uHot;\nvarying float vHot;\n' + sh.fragmentShader.replace(
            '#include <map_fragment>',
            `#ifdef USE_MAP
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
      {parts.filter((p) => (p.mat !== 'rt_G' || GLASS) && (p.mat !== 'rt_K' || FACE) && (p.mat !== 'rt_V' || PATCH)).map((p, i) => {
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

/** GPU picking: renders the room once into a 1x1 target at the pointer with every vertex coloured by its hotspot id, so walls and
 *  other props in front block the click exactly as they block the view. */
type PickFn = (clientX: number, clientY: number) => number;
function Picker({ pickRef, hoverAt, onHover }: { pickRef: React.MutableRefObject<PickFn | null>; hoverAt: React.MutableRefObject<{ x: number; y: number; on: boolean }>; onHover: (id: number) => void }) {
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
  // hover: re-pick at most every 70 ms while a mouse rests over the room (also catches the view springing back under a still pointer)
  useFrame(() => {
    const h = hoverAt.current, now = performance.now();
    if (!h.on || now - last.current.t < 70) return;
    last.current.t = now;
    const id = pick(h.x, h.y);
    if (id !== last.current.id) { last.current.id = id; onHover(id); }
  });
  return null;
}

function Rig({ ctl, env, sw, hint }: { ctl: React.MutableRefObject<Ctl>; env: React.MutableRefObject<Env>; sw: React.MutableRefObject<Sw>; hint: React.MutableRefObject<HTMLDivElement | null> }) {
  const { camera, size } = useThree();
  const tmp = useMemo(() => new THREE.Vector3(), []);
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
    (Object.keys(cur) as (keyof View)[]).forEach((key) => {
      const v = { v: vel[key] };
      cur[key] = smoothDamp(cur[key], goal[key], v, smooth, dt);
      vel[key] = v.v;
    });
    const yaw = YAW0 + cur.yaw;
    const dir = new THREE.Vector3(Math.cos(cur.pitch) * Math.sin(yaw), Math.sin(cur.pitch), Math.cos(cur.pitch) * Math.cos(yaw));
    const cam = camera as THREE.OrthographicCamera;
    // screen-space offset (zoom-to-cursor), in metres along the camera's right/up axes
    cam.position.copy(PIVOT).addScaledVector(dir, DIST);
    cam.up.set(0, 1, 0);
    cam.lookAt(PIVOT);
    const right = new THREE.Vector3(), up = new THREE.Vector3();
    cam.updateMatrix();
    right.setFromMatrixColumn(cam.matrix, 0); up.setFromMatrixColumn(cam.matrix, 1);
    cam.position.addScaledVector(right, cur.ox).addScaledVector(up, cur.oy);
    cam.zoom = (Math.min(size.width, size.height) / ORTHO) * cur.zoom;
    cam.near = DIST - 6; cam.far = DIST + 6;
    cam.updateMatrix(); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    // where the light switch is on screen (click target + hint)
    tmp.copy(SWITCH_POS).project(cam);
    const s = sw.current;
    s.x = (tmp.x * 0.5 + 0.5) * size.width; s.y = (1 - (tmp.y * 0.5 + 0.5)) * size.height;
    s.r = Math.max(SWITCH_MIN_PX, SWITCH_HIT * cam.zoom);
    if (hint.current) hint.current.style.transform = `translate3d(${s.x}px,${s.y}px,0)`;
  });
  return null;
}

export default function Lab() {
  const ctl = useRef<Ctl>({ cur: hero(), goal: hero(), vel: zero(), smooth: SNAP.followTime });
  const env = useRef<Env>({ t: START_NIGHT ? 1 : 0, target: START_NIGHT ? 1 : 0, u: { value: START_NIGHT ? 1 : 0 }, nightReady: false });
  const sw = useRef<Sw>({ x: -999, y: -999, r: 0 });
  const hint = useRef<HTMLDivElement | null>(null);
  const el = useRef<HTMLDivElement>(null!);
  const [cmp, setCmp] = useState(false);
  const [ready, setReady] = useState(false);
  const [nightReady, setNightReady] = useState(false);
  const [dark, setDark] = useState(START_NIGHT);
  const [used, setUsed] = useState(false);
  const [hover, setHover] = useState(false);
  const onReady = useCallback(() => setReady(true), []);
  const onNightReady = useCallback(() => setNightReady(true), []);
  const [box, setBox] = useState({ s: 0, x: 0, y: 0 });
  // clickable props
  const pickRef = useRef<PickFn | null>(null);
  const hoverAt = useRef({ x: 0, y: 0, on: false });
  const tagEl = useRef<HTMLDivElement>(null);
  const [hot, setHot] = useState(0);
  const [card, setCard] = useState<{ id: number; x: number; y: number } | null>(null);
  const onHover = useCallback((id: number) => { setHot(id); }, []);
  useEffect(() => {
    HOVER.value = card ? card.id : hot;
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
    setUsed(true);
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
    const raw = { yaw: 0, pitch: 0 };           // un-rubbered drag amount (radians)
    let pinch0 = 0, zoom0 = 1, pinched = false, homeTimer = 0, hov = false;
    let tap: { x: number; y: number; t: number; onSwitch: boolean } | null = null;
    const overSwitch = (x: number, y: number) => {
      const r = node.getBoundingClientRect(), s = sw.current;
      return Math.hypot(x - r.left - s.x, y - r.top - s.y) <= s.r;
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
    // snapback: any interaction cancels the pending return; letting go (or going idle on the wheel) schedules it
    const cancelHome = () => { clearTimeout(homeTimer); ctl.current.smooth = SNAP.followTime; };
    const goHome = (delay: number) => {
      clearTimeout(homeTimer);
      homeTimer = window.setTimeout(() => {
        const c = ctl.current; c.goal = hero(); c.smooth = SNAP.returnTime; raw.yaw = 0; raw.pitch = 0;
      }, delay * 1000);
    };
    const atanh = (x: number) => 0.5 * Math.log((1 + x) / (1 - x));
    const syncRaw = () => {   // grabbed mid-return: continue the rubber band from where the view is now
      const c = ctl.current.cur;
      raw.yaw = SNAP.peekYaw * atanh(clamp(c.yaw / SNAP.peekYaw, -0.98, 0.98));
      const dp = c.pitch - PITCH0, lim = dp >= 0 ? SNAP.peekUp : SNAP.peekDown;
      raw.pitch = lim * atanh(clamp(dp / lim, -0.98, 0.98));
    };
    const down = (e: PointerEvent) => {
      node.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      hoverAt.current.on = false; setCard(null);
      if (pts.size === 1) {
        cancelHome(); syncRaw(); pinched = false;
        ctl.current.goal.yaw = ctl.current.cur.yaw; ctl.current.goal.pitch = ctl.current.cur.pitch;
        tap = { x: e.clientX, y: e.clientY, t: performance.now(), onSwitch: overSwitch(e.clientX, e.clientY) };
      } else tap = null;
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); zoom0 = ctl.current.goal.zoom; pinched = true; cancelHome(); }
    };
    const move = (e: PointerEvent) => {
      const p = pts.get(e.pointerId);
      if (!p) {   // hovering: pointer cursor + label over the light switch
        if (e.pointerType === 'mouse') {
          const h = overSwitch(e.clientX, e.clientY);
          if (h !== hov) { hov = h; setHover(h); node.style.cursor = h ? 'pointer' : ''; }
          const ha = hoverAt.current; ha.x = e.clientX; ha.y = e.clientY; ha.on = !h;
          if (tagEl.current) tagEl.current.style.transform = `translate3d(${e.clientX}px,${e.clientY}px,0)`;
          if (h) setHot(0);
        }
        return;
      }
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      const g = ctl.current.goal;
      if (pts.size === 1) {
        const s = Math.min(node.clientWidth, node.clientHeight);
        raw.yaw = clamp(raw.yaw - (dx / s) * SNAP.dragYaw, -3 * SNAP.peekYaw, 3 * SNAP.peekYaw);
        raw.pitch = clamp(raw.pitch + (dy / s) * SNAP.dragPitch, -3 * SNAP.peekDown, 3 * SNAP.peekUp);
        g.yaw = SNAP.peekYaw * Math.tanh(raw.yaw / SNAP.peekYaw);   // rubber band: resists more the further you pull
        g.pitch = PITCH0 + (raw.pitch >= 0 ? SNAP.peekUp * Math.tanh(raw.pitch / SNAP.peekUp) : SNAP.peekDown * Math.tanh(raw.pitch / SNAP.peekDown));
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
      if (tap && e.type === 'pointerup' && pts.size === 0 && performance.now() - tap.t < 500) {
        if (tap.onSwitch && overSwitch(e.clientX, e.clientY)) toggle();
        else if (!tap.onSwitch) {   // a tap on a clickable prop
          const id = pickRef.current ? pickRef.current(e.clientX, e.clientY) : 0;
          if (id) activate(id, e.clientX, e.clientY);
        }
      }
      tap = null;
      if (e.pointerType === 'mouse' && pts.size === 0) { const ha = hoverAt.current; ha.x = e.clientX; ha.y = e.clientY; ha.on = true; }
      if (pts.size === 0) goHome(pinched ? SNAP.holdAfterPinch : SNAP.holdAfterDrag);
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault(); cancelHome();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
      if (pts.size === 0) goHome(SNAP.holdAfterZoom);
    };
    const leave = () => { hoverAt.current.on = false; setHot(0); };
    const dbl = (e: MouseEvent) => {
      if (overSwitch(e.clientX, e.clientY)) return;
      if (pickRef.current && pickRef.current(e.clientX, e.clientY)) return;   // double-clicking a prop doesn't reset the view   // two quick clicks on the switch are two toggles, not a reset
      const c = ctl.current; c.goal = hero(); c.smooth = SNAP.returnTime;
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
  }, [toggle, activate]);

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
          <Rig ctl={ctl} env={env} sw={sw} hint={hint} />
          <Picker pickRef={pickRef} hoverAt={hoverAt} onHover={onHover} />
        </Canvas>
      </div>
      <img className={`ref ${cmp ? 'on' : ''}`} src={`${ASSETS}cycles_ref.webp`} alt=""
        style={{ left: box.x, top: box.y, width: box.s, height: box.s }} />
      <div ref={hint} className={`sw ${hover ? 'hover' : ''} ${used ? 'used' : ''} ${ready && nightReady ? 'live' : ''}`} aria-hidden>
        <div className="ring" /><div className="tag">{dark ? 'Lights on' : 'Lights off'}</div>
      </div>
      <div className="ui">
        <button className={cmp ? 'on' : ''} onClick={compare}>{cmp ? 'Showing Cycles render' : 'Compare to Cycles'}</button>
        <button onClick={() => { home(); setCmp(false); }}>Reset view</button>
        <button onClick={toggle} disabled={!nightReady}>{nightReady ? (dark ? 'Lights on' : 'Lights off') : 'Loading night…'}</button>
      </div>
      <div ref={tagEl} className={`hot-tag ${hot && !card ? 'on' : ''}`} aria-hidden><span>{HOT_BY_ID[hot]?.label ?? ''} ↗</span></div>
      {card && (
        <div className="hot-card" style={{ left: card.x, top: card.y }} onPointerDown={(e) => e.stopPropagation()}>
          <a href={HOT_BY_ID[card.id].url} target="_blank" rel="noopener noreferrer" onClick={() => setCard(null)}>{HOT_BY_ID[card.id].label} ↗</a>
          <button aria-label="Close" onClick={() => setCard(null)}>×</button>
        </div>
      )}
      {!ready && <div className="loading">Loading the room…</div>}
      <div className="note">Live 3D · {dark ? 'night' : 'day'} · drag to peek, it springs back · scroll or pinch to zoom · click things to visit them · the light switch is on the right wall</div>
    </>
  );
}

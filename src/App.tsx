import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { BACKDROP, CAMERA, CLOCK, FRAME_ANGLES, MAX_SWING, frameUrl, type Mode } from './scene';

/* ------------------------------------------------------------------ */
/* shared motion state (mutated by the rAF loop, read by both layers)  */
/* ------------------------------------------------------------------ */
type Motion = { angle: number; vel: number; dragging: boolean; night: number; nightTarget: number };

const STEP = FRAME_ANGLES[1] - FRAME_ANGLES[0];

function useFrames(mode: Mode) {
  return useMemo(() => FRAME_ANGLES.map((a) => {
    const im = new Image();
    im.decoding = 'async';
    im.src = frameUrl(mode, a);
    return im;
  }), [mode]);
}

/** draws the two swing frames either side of the current angle, blended */
function drawSwing(ctx: CanvasRenderingContext2D, frames: HTMLImageElement[], angle: number) {
  const f = (angle - FRAME_ANGLES[0]) / STEP;
  const i0 = Math.max(0, Math.min(frames.length - 1, Math.floor(f)));
  const i1 = Math.min(frames.length - 1, i0 + 1);
  const t = Math.max(0, Math.min(1, f - i0));
  const { width: w, height: h } = ctx.canvas;
  const a = frames[i0], b = frames[i1];
  if (!a.complete || !a.naturalWidth) return;
  ctx.globalAlpha = 1;
  ctx.drawImage(a, 0, 0, w, h);
  if (t > 0.001 && b.complete && b.naturalWidth) {
    ctx.globalAlpha = t;
    ctx.drawImage(b, 0, 0, w, h);
    ctx.globalAlpha = 1;
  }
}

/* ------------------------------------------------------------------ */
/* three.js overlay: camera locked to the Blender swing camera         */
/* ------------------------------------------------------------------ */
const toThree = (v: number[]) => new THREE.Vector3(v[0], v[2], -v[1]);

function SwingCamera({ motion }: { motion: React.MutableRefObject<Motion> }) {
  const set = useThree((s) => s.set);
  const cam = useMemo(() => {
    const s = CAMERA.orthoScale / 2;
    const c = new THREE.OrthographicCamera(-s, s, s, -s, 0.1, 100);
    return c;
  }, []);
  const base = useMemo(() => {
    const m = new THREE.Matrix4().fromArray(CAMERA.matrixThree); // column-major, three coords
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
    m.decompose(pos, quat, scl);
    return { pos, quat, pivot: toThree(CAMERA.pivotBlender) };
  }, []);
  useEffect(() => { set({ camera: cam }); }, [cam, set]);
  useFrame(() => {
    const th = THREE.MathUtils.degToRad(motion.current.angle);
    const r = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), th);
    cam.position.copy(base.pos).sub(base.pivot).applyQuaternion(r).add(base.pivot);
    cam.quaternion.copy(r).multiply(base.quat);
    cam.updateMatrixWorld();
  });
  return null;
}

function handGeometry(tris: number[][], z: number) {
  const g = new THREE.BufferGeometry();
  const pos: number[] = [];
  for (const t of tris) for (let k = 0; k < 3; k++) pos.push(t[2 * k], t[2 * k + 1], z);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

function LiveClock({ motion }: { motion: React.MutableRefObject<Motion> }) {
  const group = useRef<THREE.Group>(null!);
  const hour = useRef<THREE.Mesh>(null!);
  const minute = useRef<THREE.Mesh>(null!);
  const mats = useMemo(() => ({
    hand: new THREE.MeshBasicMaterial({ color: new THREE.Color(CLOCK.handColorDay), side: THREE.DoubleSide }),
    pin: new THREE.MeshBasicMaterial({ color: new THREE.Color(CLOCK.pinColor), side: THREE.DoubleSide }),
  }), []);
  const geo = useMemo(() => ({
    hour: handGeometry(CLOCK.hourTris, 0.0004),
    minute: handGeometry(CLOCK.minuteTris, 0.0009),
  }), []);
  const frame = useMemo(() => {
    // dial frame: x = 3 o'clock direction, y = 12 o'clock, z = out of the dial (into the room)
    const x = toThree(CLOCK.uBlender), y = toThree(CLOCK.vBlender), z = toThree(CLOCK.nBlender);
    const m = new THREE.Matrix4().makeBasis(x, y, z);
    m.setPosition(toThree(CLOCK.centerBlender));
    return m;
  }, []);
  const day = useMemo(() => new THREE.Color(CLOCK.handColorDay), []);
  const glow = useMemo(() => new THREE.Color(CLOCK.handColorNight), []);
  useEffect(() => { group.current.matrixAutoUpdate = false; group.current.matrix.copy(frame); }, [frame]);
  useFrame(() => {
    const now = new Date();
    const s = now.getSeconds() + now.getMilliseconds() / 1000;
    const m = now.getMinutes() + s / 60;
    const h = (now.getHours() % 12) + m / 60;
    minute.current.rotation.z = -(m / 60) * Math.PI * 2;
    hour.current.rotation.z = -(h / 12) * Math.PI * 2;
    mats.hand.color.copy(day).lerp(glow, motion.current.night);
  });
  return (
    <group ref={group}>
      <mesh ref={hour} geometry={geo.hour} material={mats.hand} />
      <mesh ref={minute} geometry={geo.minute} material={mats.hand} />
      <mesh position={[0, 0, 0.0014]} material={mats.pin}>
        <circleGeometry args={[CLOCK.pinRadius, 24]} />
      </mesh>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* page                                                                */
/* ------------------------------------------------------------------ */
export default function App() {
  const [mode, setMode] = useState<Mode>('day');
  const [hinted, setHinted] = useState(false);
  const motion = useRef<Motion>({ angle: 0, vel: 0, dragging: false, night: 0, nightTarget: 0 });
  const dayFrames = useFrames('day');
  const nightFrames = useFrames('night');
  const dayCanvas = useRef<HTMLCanvasElement>(null!);
  const nightCanvas = useRef<HTMLCanvasElement>(null!);
  const stage = useRef<HTMLDivElement>(null!);

  // render loop: spring + frame blending
  useEffect(() => {
    let raf = 0, last = performance.now();
    const k = 70, zeta = 0.62, c = 2 * Math.sqrt(k) * zeta;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const M = motion.current;
      if (!M.dragging) {
        const acc = -k * M.angle - c * M.vel;
        M.vel += acc * dt; M.angle += M.vel * dt;
        if (Math.abs(M.angle) < 0.01 && Math.abs(M.vel) < 0.01) { M.angle = 0; M.vel = 0; }
      }
      M.night += (M.nightTarget - M.night) * Math.min(1, dt * 5);
      for (const [cv, frames] of [[dayCanvas.current, dayFrames], [nightCanvas.current, nightFrames]] as const) {
        const ctx = cv.getContext('2d');
        if (ctx) drawSwing(ctx, frames, M.angle);
      }
      nightCanvas.current.style.opacity = String(M.night);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [dayFrames, nightFrames]);

  // keep canvases at device resolution
  useEffect(() => {
    const fit = () => {
      const r = stage.current.getBoundingClientRect();
      const px = Math.round(r.width * Math.min(2, window.devicePixelRatio || 1));
      for (const cv of [dayCanvas.current, nightCanvas.current]) { cv.width = px; cv.height = px; }
    };
    fit();
    const ro = new ResizeObserver(fit); ro.observe(stage.current);
    return () => ro.disconnect();
  }, []);

  // drag to swing
  useEffect(() => {
    const el = stage.current;
    let startX = 0, startA = 0, lastT = 0;
    const down = (e: PointerEvent) => {
      const M = motion.current; M.dragging = true; M.vel = 0;
      startX = e.clientX; startA = M.angle; lastT = performance.now();
      el.setPointerCapture(e.pointerId); setHinted(true);
    };
    const move = (e: PointerEvent) => {
      const M = motion.current; if (!M.dragging) return;
      const w = el.getBoundingClientRect().width;
      let a = startA + ((e.clientX - startX) / w) * 2 * MAX_SWING;
      if (Math.abs(a) > MAX_SWING) a = Math.sign(a) * (MAX_SWING + (Math.abs(a) - MAX_SWING) * 0.25); // rubber band
      a = Math.max(-MAX_SWING - 4, Math.min(MAX_SWING + 4, a));
      const now = performance.now();
      M.vel = ((a - M.angle) / Math.max(1, now - lastT)) * 1000;
      M.angle = a; lastT = now;
    };
    const up = () => { motion.current.dragging = false; motion.current.angle = Math.max(-MAX_SWING, Math.min(MAX_SWING, motion.current.angle)); };
    el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    return () => { el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
  }, []);

  const toggle = () => {
    const next: Mode = mode === 'day' ? 'night' : 'day';
    setMode(next); motion.current.nightTarget = next === 'night' ? 1 : 0;
  };

  return (
    <div className="page" style={{ background: mode === 'day' ? BACKDROP.day : BACKDROP.night }}>
      <header className="bar">
        <span className="name">Noah Menendez</span>
        <button className={`switch ${mode}`} onClick={toggle} aria-label={mode === 'day' ? 'Turn the lights off' : 'Turn the lights on'}>
          <span className="knob" />
          <span className="label">{mode === 'day' ? 'Lights on' : 'Lights off'}</span>
        </button>
      </header>
      <div className="stage" ref={stage}>
        <canvas ref={dayCanvas} className="layer" />
        <canvas ref={nightCanvas} className="layer" style={{ opacity: 0 }} />
        <Canvas className="layer overlay" gl={{ alpha: true, antialias: true }} dpr={[1, 2]} frameloop="always">
          <SwingCamera motion={motion} />
          <LiveClock motion={motion} />
        </Canvas>
        <div className={`hint ${hinted ? 'gone' : ''}`}>Drag to look around</div>
      </div>
    </div>
  );
}

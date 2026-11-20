import { useEffect, useRef, useState } from 'react';

/** Pop-up inspector for the goalie mask: the studio turntable (150 frames, one full turn in 5 s, every frame a keyframe) spins on its own;
 *  drag sideways to turn it by hand, let go and it carries on. Closes with the X, Esc or a click outside. */
export default function MaskViewer({ src, onClose }: { src: string; onClose: () => void }) {
  const vid = useRef<HTMLVideoElement>(null);
  const [grab, setGrab] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const drag = useRef<{ x: number; t: number } | null>(null);
  const down = (e: React.PointerEvent) => {
    const v = vid.current; if (!v) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    v.pause(); drag.current = { x: e.clientX, t: v.currentTime }; setGrab(true); setTouched(true);
  };
  const move = (e: React.PointerEvent) => {
    const v = vid.current, d = drag.current; if (!v || !d || !v.duration) return;
    const w = (e.currentTarget as HTMLElement).clientWidth;
    // one stage-width of drag = one full turn; dragging right brings the right side round, like turning the real thing
    const t = d.t - ((e.clientX - d.x) / w) * v.duration;
    v.currentTime = ((t % v.duration) + v.duration) % v.duration;
  };
  const up = () => { drag.current = null; setGrab(false); void vid.current?.play().catch(() => {}); };

  return (
    <div className="mask-pop" role="dialog" aria-modal="true" aria-label="Goalie mask" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mask-card">
        <div className={`mask-stage ${grab ? 'grab' : ''}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <video ref={vid} src={src} autoPlay loop muted playsInline preload="auto" disablePictureInPicture />
        </div>
        <div className="mask-bar">
          <span className="mask-title">Goalie mask</span>
          <span className={`mask-hint ${touched ? 'off' : ''}`}>Drag to spin</span>
        </div>
        <button className="mask-x" aria-label="Close" onClick={onClose}>×</button>
      </div>
    </div>
  );
}

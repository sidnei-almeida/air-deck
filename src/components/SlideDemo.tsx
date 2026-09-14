import { useEffect, useState } from 'react';
import { GESTURE_GUIDE } from '../lib/glyphs';
import { Scribble } from './Scribble';

const SCENES = [
  { guide: 'ellipse', gesture: 'Thumb + ring', result: 'circles a word' },
  { guide: 'arrow', gesture: 'Thumb + pinky', result: 'points at a detail' },
  { guide: 'pen', gesture: 'Thumb + index', result: 'underlines a line' },
] as const;
const SCENE_MS = 2800;

/** A small slide that annotates itself in a loop: what the gestures do, before the camera is even on. */
export function SlideDemo() {
  const [scene, setScene] = useState(0);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = window.setInterval(() => setScene(s => (s + 1) % SCENES.length), SCENE_MS);
    return () => window.clearInterval(id);
  }, []);
  const current = SCENES[scene];
  const glyph = GESTURE_GUIDE.find(g => g.id === current.guide);

  return (
    <figure className="demo" aria-hidden="true">
      <div className="demo-slide">
        <span className="demo-eyebrow">Biology · 04</span>
        <p className="demo-title">
          Plants turn light into{' '}
          <span className="scribbled">
            glucose
            {scene === 0 && <Scribble kind="ellipse" />}
          </span>
        </p>
        <div className="demo-row">
          <p className="demo-formula">
            <span className="scribbled">
              6CO₂ + 6H₂O → C₆H₁₂O₆ + 6O₂
              {scene === 2 && <Scribble kind="underline" />}
            </span>
          </p>
          <div className="demo-chart">
            <i />
            <i />
            <i />
            {scene === 1 && <Scribble kind="arrow" className="demo-arrow" />}
          </div>
        </div>
      </div>
      <figcaption className="demo-caption">
        {glyph && <svg viewBox="0 0 176 64" dangerouslySetInnerHTML={{ __html: glyph.svg }} />}
        <span>
          <b>{current.gesture}</b> {current.result}
        </span>
      </figcaption>
    </figure>
  );
}

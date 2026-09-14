import type { CSSProperties } from 'react';
import { GESTURE_GUIDE } from '../lib/glyphs';
import { Icon } from './Icon';
import { Scribble } from './Scribble';

/** The gestures worth remembering when a presentation starts, in the order you'll need them. */
const TIPS = ['nav', 'laser', 'pen', 'rect', 'ellipse', 'arrow', 'menu', 'clear', 'history'];

interface Props {
  /** Thumbs-up hold progress (0–1): the OK button fills while the thumb is up. */
  progress: number;
  showAtStart: boolean;
  onShowAtStart: (show: boolean) => void;
  onClose: () => void;
  onHelp: () => void;
}

/** A reminder sheet over the first slide, so nobody has to remember every gesture after opening a PDF. */
export function TipsSheet({ progress, showAtStart, onShowAtStart, onClose, onHelp }: Props) {
  const guides = TIPS.flatMap(id => GESTURE_GUIDE.filter(g => g.id === id));
  return (
    <div className="backdrop" onClick={onClose}>
      <div className="dialog tips paper" role="dialog" aria-modal="true" aria-labelledby="tips-title" onClick={e => e.stopPropagation()}>
        <header className="dialog-head">
          <div>
            <span className="label">Before you start</span>
            <h2 id="tips-title" className="display">
              A quick{' '}
              <span className="scribbled">
                reminder
                <Scribble kind="underline" delay={150} />
              </span>
            </h2>
          </div>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>

        <ul className="tips-grid">
          {guides.map(g => (
            <li key={g.id} className="tip">
              <svg viewBox="0 0 176 64" aria-hidden="true" dangerouslySetInnerHTML={{ __html: g.svg }} />
              <b>{g.name}</b>
              <span>{g.how}</span>
            </li>
          ))}
        </ul>

        <footer className="tips-foot">
          <label className="tips-check">
            <input type="checkbox" checked={showAtStart} onChange={e => onShowAtStart(e.target.checked)} />
            Show this when a presentation opens
          </label>
          <div className="tips-actions">
            <button className="link" type="button" onClick={onHelp}>
              All gestures and keys
            </button>
            <button className="btn btn-primary thumb-btn" type="button" onClick={onClose} autoFocus style={{ '--p': progress } as CSSProperties}>
              <span className="thumb-fill" aria-hidden="true" />
              Got it <Icon name="thumbUp" size={16} />
            </button>
          </div>
        </footer>
        <p className="dialog-foot mono">
          <Icon name="thumbUp" size={14} /> Hold a thumbs up to start presenting · Esc works too
        </p>
      </div>
    </div>
  );
}

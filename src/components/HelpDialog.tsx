import { SHORTCUTS } from '../lib/glyphs';
import { GestureCards } from './GestureCards';
import { Icon } from './Icon';
import { Scribble } from './Scribble';

/** A sheet of paper laid over the stage: every gesture, and the keyboard. */
export function HelpDialog({ onClose, onTrain }: { onClose: () => void; onTrain: () => void }) {
  return (
    <div className="backdrop" onClick={onClose}>
      <div className="dialog paper" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={e => e.stopPropagation()}>
        <header className="dialog-head">
          <div>
            <span className="label">Help</span>
            <h2 id="help-title" className="display">
              How to{' '}
              <span className="scribbled">
                control it
                <Scribble kind="underline" delay={150} />
              </span>
            </h2>
          </div>
          <div className="dialog-actions">
            <button className="btn btn-quiet btn-small" type="button" onClick={onTrain}>
              <Icon name="hand" size={16} /> Practice gestures
            </button>
            <button className="icon-btn" type="button" onClick={onClose} aria-label="Close" autoFocus>
              <Icon name="close" />
            </button>
          </div>
        </header>
        <GestureCards compact />
        <div className="shortcuts">
          <span className="label">Keyboard and clicker</span>
          <dl>
            {SHORTCUTS.map(([keys, action]) => (
              <div key={action}>
                <dt>
                  {keys.map(k => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </dt>
                <dd>{action}</dd>
              </div>
            ))}
          </dl>
        </div>
        <p className="dialog-foot mono">
          <Icon name="thumbUp" size={14} /> Hold a thumbs up to close this sheet.
        </p>
      </div>
    </div>
  );
}

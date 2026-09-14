import { SMOOTHING, type SmoothingPreset } from '../lib/oneEuro';
import { INK_COLORS, type Prefs } from '../lib/prefs';

interface Props {
  prefs: Prefs;
  onPrefs: (prefs: Prefs) => void;
  cameraOn: boolean;
  onCameraOn: (on: boolean) => void;
  mouseLaser: boolean;
  onMouseLaser: (on: boolean) => void;
  onTrain: () => void;
}

const SMOOTHING_NOTE: Record<SmoothingPreset, string> = {
  responsive: 'Follows your hand instantly; a little more tremor.',
  balanced: 'A balance between steady and quick.',
  stable: 'Very steady, with a slight delay.',
};

export function SettingsPanel({ prefs, onPrefs, cameraOn, onCameraOn, mouseLaser, onMouseLaser, onTrain }: Props) {
  const registered = prefs.profile ? new Date(prefs.profile.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;

  return (
    <div className="panel settings" role="dialog" aria-label="Settings">
      <section>
        <span className="label">Smoothing</span>
        <div className="seg" role="radiogroup" aria-label="Smoothing preset">
          {(Object.keys(SMOOTHING) as SmoothingPreset[]).map(key => (
            <label key={key}>
              <input type="radio" name="smoothing" value={key} checked={prefs.smoothing === key} onChange={() => onPrefs({ ...prefs, smoothing: key })} />
              <span>{SMOOTHING[key].label}</span>
            </label>
          ))}
        </div>
        <span className="seg-note">{SMOOTHING_NOTE[prefs.smoothing]}</span>
      </section>

      <section>
        <span className="label">Ink color</span>
        <div className="swatches" role="radiogroup" aria-label="Ink color">
          {INK_COLORS.map(c => (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={prefs.inkColor === c.value}
              aria-label={c.label}
              title={c.label}
              className={c.value === 'auto' ? 'swatch swatch-auto' : 'swatch'}
              style={c.value === 'auto' ? undefined : { background: c.value }}
              onClick={() => onPrefs({ ...prefs, inkColor: c.value })}
            />
          ))}
        </div>
      </section>

      <section>
        <div className="panel-row">
          <span>
            <span className="label">Your hand</span>
            <span className="profile-note">{registered ? `Set up on ${registered}` : 'Not set up yet'}</span>
          </span>
          <button className="btn btn-quiet btn-small" type="button" onClick={onTrain}>
            {registered ? 'Redo and practice' : 'Set up'}
          </button>
        </div>
      </section>

      <section className="toggles">
        <Toggle label="Hand tracking" checked={cameraOn} onChange={onCameraOn} />
        <Toggle label="Show camera" checked={prefs.showCamera} onChange={v => onPrefs({ ...prefs, showCamera: v })} disabled={!cameraOn} />
        <Toggle label="Mouse laser" hint="Drag with the button pressed to write" checked={mouseLaser} onChange={onMouseLaser} />
      </section>
    </div>
  );
}

function Toggle({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`toggle${disabled ? ' is-disabled' : ''}`}>
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <i aria-hidden="true" />
    </label>
  );
}

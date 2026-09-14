import { GESTURE_GUIDE } from '../lib/glyphs';

const num = (i: number) => String(i + 1).padStart(2, '0');

/** The launcher's gesture index: numbered entries on ruled lines, like notes in a notebook. */
export function GestureList() {
  return (
    <ol className="gesture-index">
      {GESTURE_GUIDE.map((g, i) => (
        <li className="gesture-entry" key={g.id}>
          <div className="gesture-text">
            <span className="gesture-num mono">{num(i)}</span>
            <b>{g.name}</b>
            <span>{g.how}</span>
          </div>
          <svg viewBox="0 0 176 64" role="img" aria-label={`${g.name}: ${g.how}`} dangerouslySetInnerHTML={{ __html: g.svg }} />
        </li>
      ))}
    </ol>
  );
}

export function GestureCards({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? 'gestures gestures-compact' : 'gestures'}>
      {GESTURE_GUIDE.map((g, i) => (
        <article className="gesture" key={g.id}>
          <svg viewBox="0 0 176 64" role="img" aria-label={`${g.name}: ${g.how}`} dangerouslySetInnerHTML={{ __html: g.svg }} />
          <h3>
            <span className="mono">{num(i)}</span>
            {g.name}
          </h3>
          <p>{g.how}</p>
          <span className="gesture-detail">{g.detail}</span>
        </article>
      ))}
    </div>
  );
}

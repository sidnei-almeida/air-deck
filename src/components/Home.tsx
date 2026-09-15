import { useCallback, useEffect, useRef, useState } from 'react';
import { closePdf, openPdf, openPdfBytes, PdfError, renderPage, type PDFDocumentProxy } from '../lib/pdf';
import { clearPrefs, loadPrefs, savePrefs, type Prefs } from '../lib/prefs';
import { forgetRecentDeck, loadRecentDeck, saveRecentDeck, type RecentDeck } from '../lib/recent';
import { Lockup } from './Brand';
import { GestureList } from './GestureCards';
import { Icon } from './Icon';
import { Scribble } from './Scribble';
import { SlideDemo } from './SlideDemo';
import { SlideCanvas } from './SlideCanvas';
import { Trainer } from './Trainer';

interface LoadedDeck {
  doc: PDFDocumentProxy;
  name: string;
  thumb: ImageBitmap;
  startPage: number;
}

type State =
  | { kind: 'idle' }
  | { kind: 'loading'; name: string }
  | { kind: 'ready'; deck: LoadedDeck }
  | { kind: 'error'; message: string };

const thumbOf = (doc: PDFDocumentProxy, page: number) => renderPage(doc, page, 1280, 720, Math.min(window.devicePixelRatio || 1, 2)).then(r => r.bitmap);

/** The launcher: a sheet of paper with the app's own annotations. Open a PDF, check the gestures, present. */
export function Home({ onPresent }: { onPresent: (doc: PDFDocumentProxy, name: string, startPage: number) => void }) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const updatePrefs = useCallback((next: Prefs) => {
    setPrefs(next);
    savePrefs(next);
  }, []);
  const [trainer, setTrainer] = useState<null | 'practice' | 'before-present'>(null);

  // The last deck, to pick up where the presentation stopped.
  const [recent, setRecent] = useState<RecentDeck | null>(null);
  useEffect(() => {
    let alive = true;
    loadRecentDeck().then(deck => {
      if (alive) setRecent(deck);
    });
    return () => {
      alive = false;
    };
  }, []);

  const release = () => {
    const previous = stateRef.current;
    if (previous.kind === 'ready') {
      previous.deck.thumb.close();
      closePdf(previous.deck.doc);
    }
  };

  const openFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    release();
    setState({ kind: 'loading', name: file.name });
    try {
      const { doc, bytes } = await openPdf(file);
      const name = file.name.replace(/\.pdf$/i, '');
      setState({ kind: 'ready', deck: { doc, name, thumb: await thumbOf(doc, 1), startPage: 1 } });
      const deck = { name, bytes, pages: doc.numPages, page: 1 };
      if (await saveRecentDeck(deck)) setRecent({ ...deck, savedAt: Date.now() });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof PdfError ? err.message : 'Couldn’t open this PDF.' });
    }
  }, []);

  const resume = async () => {
    if (!recent) return;
    release();
    setState({ kind: 'loading', name: recent.name });
    try {
      const doc = await openPdfBytes(recent.bytes);
      const startPage = Math.min(Math.max(recent.page, 1), doc.numPages);
      setState({ kind: 'ready', deck: { doc, name: recent.name, thumb: await thumbOf(doc, startPage), startPage } });
    } catch {
      forgetRecentDeck();
      setRecent(null);
      setState({ kind: 'error', message: 'The saved PDF won’t open anymore. Choose the file again.' });
    }
  };

  const fromFirstSlide = async () => {
    const current = stateRef.current;
    if (current.kind !== 'ready') return;
    const thumb = await thumbOf(current.deck.doc, 1);
    current.deck.thumb.close();
    setState({ kind: 'ready', deck: { ...current.deck, thumb, startPage: 1 } });
  };

  // Accept a drop anywhere in the window.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(depth - 1, 0);
      if (depth === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      openFile(e.dataTransfer?.files[0]);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [openFile]);

  /** Must run inside a click so the browser counts it as a user gesture for fullscreen. */
  const startPresenting = () => {
    const current = stateRef.current;
    if (current.kind !== 'ready') return;
    const { doc, name, thumb, startPage } = current.deck;
    document.documentElement.requestFullscreen?.().catch(() => {});
    thumb.close();
    onPresent(doc, name, startPage);
  };

  // The first-run trainer shows up once; after that the saved hand (or the choice to skip) is respected.
  const present = () => {
    if (!prefs.profile && !prefs.onboarded) setTrainer('before-present');
    else startPresenting();
  };

  const forgetData = async () => {
    clearPrefs();
    await forgetRecentDeck();
    window.location.reload();
  };

  const choose = () => inputRef.current?.click();
  const registered = !!prefs.profile;
  const pages = state.kind === 'ready' ? state.deck.doc.numPages : 0;

  return (
    <div className="home paper">
      <header className="home-bar">
        <Lockup size={24} />
        <nav className="home-nav">
          <a className="portfolio-link" href="https://sidnei-almeida.github.io/">
            <Icon name="arrowLeft" size={16} /> Portfolio
          </a>
          <span className="hand-note" data-state={registered ? 'ok' : 'off'}>
            {registered && <Icon name="check" size={14} />}
            {registered ? 'Hand set up' : 'Hand not set up'}
          </span>
          <button className="btn btn-quiet btn-small" type="button" onClick={() => setTrainer('practice')}>
            <Icon name="hand" size={16} /> {registered ? 'Practice' : 'Set up hand'}
          </button>
        </nav>
      </header>

      <main className="home-main">
        <section className="home-hero">
          <p className="label">Gesture-controlled presentations · right in your browser</p>
          <h1 className="display home-title">
            Present
            <br />
            with your{' '}
            <span className="scribbled">
              hands
              <Scribble kind="ellipse" delay={350} />
            </span>
            .
          </h1>
          <p className="home-lead">Change slides, point with a laser, circle, underline and write over any PDF, using nothing but your computer’s camera.</p>

          <div className={`sheet${dragging ? ' is-dragging' : ''}`} data-state={state.kind}>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
              hidden
              onChange={e => {
                openFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />

            {state.kind === 'idle' && (
              <div className="sheet-idle">
              <div className="sheet-body">
                {recent && !dragging && (
                  <div className="resume">
                    <span className="resume-icon">
                      <Icon name="file" size={18} />
                    </span>
                    <span className="resume-text">
                      <b className="truncate">{recent.name}</b>
                      <span className="mono">
                        stopped at slide {recent.page} of {recent.pages}
                      </span>
                    </span>
                    <button className="btn btn-quiet btn-small" type="button" onClick={resume}>
                      Resume
                    </button>
                  </div>
                )}
                <h2 className="display sheet-title">
                  {dragging ? (
                    'Let it go.'
                  ) : (
                    <>
                      Drop a PDF <span className="hl">here</span>.
                    </>
                  )}
                </h2>
                <p>Or pick one from your computer. The file never leaves this device.</p>
                <div className="sheet-actions">
                  <button className="btn btn-primary btn-big" type="button" onClick={choose}>
                    <Icon name="file" size={18} /> Choose PDF
                  </button>
                  <span className="mono sheet-hint">Exported from PowerPoint, Keynote, Canva or Google Slides</span>
                </div>
              </div>
              <SlideDemo />
              </div>
            )}

            {state.kind === 'loading' && (
              <div className="sheet-body is-center" role="status">
                <span className="spinner" aria-hidden="true" />
                <h2 className="display sheet-title is-small">Opening the PDF</h2>
                <span className="mono truncate">{state.name}</span>
              </div>
            )}

            {state.kind === 'error' && (
              <div className="sheet-body" role="alert">
                <h2 className="display sheet-title is-error">{state.message}</h2>
                <p>{dragging ? 'Let it go.' : 'Drop another file or choose again.'}</p>
                <div className="sheet-actions">
                  <button className="btn btn-quiet" type="button" onClick={choose}>
                    Choose another PDF
                  </button>
                </div>
              </div>
            )}

            {state.kind === 'ready' && (
              <div className="deck-ready">
                <figure className="deck-photo">
                  <SlideCanvas bitmap={state.deck.thumb} width="auto" height="auto" />
                </figure>
                <div className="deck-info">
                  <span className="label">Ready to present</span>
                  <h2 className="display deck-name">{state.deck.name}</h2>
                  <span className="mono deck-meta">
                    {pages} {pages === 1 ? 'slide' : 'slides'} · blank whiteboard included
                    {state.deck.startPage > 1 && ` · resumes at slide ${state.deck.startPage}`}
                  </span>
                  <div className="deck-go">
                    <button className="btn btn-primary btn-big" type="button" onClick={present} autoFocus>
                      Present <Icon name="arrowRight" size={18} />
                    </button>
                    <Scribble kind="arrow" delay={450} />
                  </div>
                  <p className="deck-note">
                    {registered || prefs.onboarded ? 'The camera and fullscreen turn on when you start.' : 'First, one minute to set up your hand.'}
                  </p>
                  <div className="deck-links">
                    {state.deck.startPage > 1 && (
                      <button className="link" type="button" onClick={fromFirstSlide}>
                        Start from slide 1
                      </button>
                    )}
                    <button className="link" type="button" onClick={choose}>
                      Change file
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          <ol className="home-steps">
            <li data-done={state.kind === 'ready'}>
              <span className="step-num">1</span>
              <span>Open a PDF</span>
            </li>
            <li data-done={registered}>
              <span className="step-num">2</span>
              {registered ? (
                <span>Set up your hand</span>
              ) : (
                <button className="link" type="button" onClick={() => setTrainer('practice')}>
                  Set up your hand · 1 min
                </button>
              )}
            </li>
            <li>
              <span className="step-num">3</span>
              <span>Present with gestures</span>
            </li>
          </ol>
        </section>

        <aside className="home-index" aria-label="Gestures">
          <header className="index-head">
            <h2 className="display">Gestures</h2>
            <button className="link" type="button" onClick={() => setTrainer('practice')}>
              {registered ? 'Practice' : 'Learn them'} →
            </button>
          </header>
          <div className="index-scroll">
            <GestureList />
          </div>
          <footer className="index-foot">
            <div>
              <Icon name="sun" size={16} />
              <span>Light in front of you, hand at chest height, 1–2 m from the camera.</span>
            </div>
            <div>
              <Icon name="shield" size={16} />
              <span>
                Your PDF, camera and hand data stay on this computer.{' '}
                <button className="link" type="button" onClick={forgetData}>
                  Delete my data
                </button>
              </span>
            </div>
            <div>
              <Icon name="github" size={16} />
              <span>
                Built by{' '}
                <a className="link" href="https://github.com/sidnei-almeida" target="_blank" rel="noopener noreferrer">
                  Sidnei Almeida
                </a>{' '}
                and{' '}
                <a className="link" href="https://github.com/filipecunhaadv" target="_blank" rel="noopener noreferrer">
                  Filipe Cunha
                </a>
              </span>
            </div>
          </footer>
        </aside>
      </main>

      {trainer && (
        <Trainer
          prefs={prefs}
          onPrefs={updatePrefs}
          startStep={trainer === 'practice' && registered ? 'practice' : 'hand'}
          doneLabel={trainer === 'before-present' ? 'Start presenting' : 'Done'}
          skipLabel={trainer === 'before-present' ? 'Skip and present' : 'Close'}
          onClose={() => {
            const mode = trainer;
            setTrainer(null);
            // Read what the trainer saved, so its hand profile isn't overwritten by this render's copy.
            const next = { ...loadPrefs(), onboarded: true };
            savePrefs(next);
            setPrefs(next);
            if (mode === 'before-present') startPresenting();
          }}
        />
      )}
    </div>
  );
}

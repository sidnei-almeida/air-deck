import { useCallback, useState } from 'react';
import { MotionConfig } from 'motion/react';
import { closePdf, type PDFDocumentProxy } from './lib/pdf';
import { saveRecentPage } from './lib/recent';
import { Home } from './components/Home';
import { Presenter } from './components/Presenter';

interface Deck {
  doc: PDFDocumentProxy;
  name: string;
  startPage: number;
}

export default function App() {
  const [deck, setDeck] = useState<Deck | null>(null);

  const exit = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (deck) closePdf(deck.doc);
    setDeck(null);
  }, [deck]);

  const rememberPage = useCallback((page: number) => {
    saveRecentPage(page);
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      {deck ? (
        <Presenter doc={deck.doc} name={deck.name} startPage={deck.startPage} onPage={rememberPage} onExit={exit} />
      ) : (
        <Home onPresent={(doc, name, startPage) => setDeck({ doc, name, startPage })} />
      )}
    </MotionConfig>
  );
}

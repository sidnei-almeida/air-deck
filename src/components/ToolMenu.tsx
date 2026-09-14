import type { CSSProperties } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { PointerTool } from '../lib/gestures';
import { Icon } from './Icon';

export const MENU_OPTIONS = [
  { option: 1, label: 'Laser', hint: 'Points without drawing' },
  { option: 2, label: 'Zoom', hint: 'A lens that follows your finger' },
  { option: 3, label: 'Eraser', hint: 'Erase with your index finger' },
  { option: 4, label: 'Whiteboard', hint: 'A blank page to explain on' },
  { option: 5, label: 'Clear ink', hint: 'Wipes everything on this slide' },
] as const;

/** Menu options that change what one raised finger does. */
export const OPTION_TOOL: Partial<Record<number, PointerTool>> = { 1: 'laser', 2: 'lens', 3: 'eraser' };

const DWELL_MS = 700;

/** Hover and hold: the option under the hand pointer is picked after a short dwell. */
export class MenuDwell {
  hot: number | null = null;
  progress = 0;
  private since = 0;

  update(option: number | null, t: number): number | null {
    if (option !== this.hot) {
      this.hot = option;
      this.since = t;
    }
    this.progress = option ? Math.min((t - this.since) / DWELL_MS, 1) : 0;
    if (option && this.progress >= 1) {
      this.reset();
      return option;
    }
    return null;
  }

  reset() {
    this.hot = null;
    this.progress = 0;
  }
}

/** The menu option at a point in client coordinates. The overlay canvases don't take pointer events, so they are skipped. */
export function menuOptionAt(clientX: number, clientY: number): number | null {
  const el = document.elementFromPoint(clientX, clientY)?.closest('[data-option]');
  return el ? Number(el.getAttribute('data-option')) : null;
}

interface Props {
  open: boolean;
  /** Option under the hand pointer, and how long it has been held (0–1). */
  hot: number | null;
  progress: number;
  pointerTool: PointerTool;
  board: boolean;
  compact?: boolean;
  onSelect: (option: number) => void;
  onClose: () => void;
}

export function ToolMenu({ open, hot, progress, pointerTool, board, compact, onSelect, onClose }: Props) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={compact ? 'tool-menu is-compact' : 'tool-menu'}
          role="menu"
          aria-label="Tools"
          initial={{ opacity: 0, y: -8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.98 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        >
          <header>
            <span className="label">Tools</span>
            <button className="icon-btn icon-btn-small" type="button" onClick={onClose} aria-label="Close menu">
              <Icon name="close" size={15} />
            </button>
          </header>
          {MENU_OPTIONS.map(o => {
            const isHot = hot === o.option;
            const tool = OPTION_TOOL[o.option];
            const current = tool ? tool === pointerTool : o.option === 4 && board;
            return (
              <button
                key={o.option}
                type="button"
                role="menuitem"
                className="menu-item"
                data-option={o.option}
                data-hot={isHot}
                style={{ '--p': isHot ? progress : 0 } as CSSProperties}
                onClick={() => onSelect(o.option)}
              >
                <span className="menu-fill" aria-hidden="true" />
                <kbd>{o.option}</kbd>
                <span className="menu-text">
                  <b>{o.label}</b>
                  <small>{o.hint}</small>
                </span>
                {current && <span className="menu-current" aria-label="in use" />}
              </button>
            );
          })}
          <footer>Point and hold, or pinch · two fingers sideways close it</footer>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

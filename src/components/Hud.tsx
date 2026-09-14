import type { CameraStatus } from '../hooks/useHandTracking';
import type { PointerTool, Tool, TrackingState } from '../lib/gestures';
import { Icon } from './Icon';

export const TOOL_LABEL: Record<Tool, string> = {
  laser: 'Laser',
  lens: 'Zoom',
  pen: 'Pen',
  rect: 'Rectangle',
  ellipse: 'Circle',
  arrow: 'Arrow',
  eraser: 'Eraser',
  zoom: 'Zoom',
  menu: 'Menu',
  clear: 'Clear',
};

export const POINTER_LABEL: Record<PointerTool, string> = { laser: 'Laser', lens: 'Zoom', eraser: 'Eraser' };

type ChipState = 'ok' | 'search' | 'lost' | 'off';

export function trackingChip(cameraOn: boolean, status: CameraStatus, tracking: TrackingState): { state: ChipState; text: string } {
  if (!cameraOn) return { state: 'off', text: 'Camera off' };
  switch (status) {
    case 'off':
    case 'starting':
      return { state: 'search', text: 'Starting camera' };
    case 'denied':
      return { state: 'lost', text: 'Camera blocked' };
    case 'unavailable':
      return { state: 'lost', text: 'No camera' };
    case 'error':
      return { state: 'lost', text: 'Tracking failed' };
  }
  if (tracking === 'tracking') return { state: 'ok', text: 'Hand detected' };
  if (tracking === 'lost') return { state: 'lost', text: 'Hand lost' };
  return { state: 'search', text: 'Looking for a hand' };
}

interface HudProps {
  visible: boolean;
  chip: { state: ChipState; text: string };
  page: number;
  total: number;
  zoomText: string;
  tool: Tool | null;
  pointerTool: PointerTool;
  board: boolean;
  onMenu: () => void;
  cameraOn: boolean;
  isFullscreen: boolean;
  panel: 'help' | 'settings' | 'tips' | null;
  onHelp: () => void;
  onTrain: () => void;
  onSettings: () => void;
  onCamera: () => void;
  onFullscreen: () => void;
  onExit: () => void;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export function Hud(props: HudProps) {
  const { visible, chip, page, total, zoomText, tool, pointerTool, board } = props;

  return (
    <div className={`hud${visible ? '' : ' is-hidden'}`}>
      <div className="hudbar" aria-live="polite">
        <span className="chip" data-state={chip.state}>
          <i />
          {chip.text}
        </span>
        <span className="hud-div" />
        <span className="chip mono">{board ? 'Whiteboard' : `${pad2(Math.min(page, total))} / ${pad2(total)}`}</span>
        <span className="chip mono dim">{zoomText}</span>
        <button className="chip chip-btn" type="button" onClick={props.onMenu} title="Tool menu (M)">
          1 finger · {POINTER_LABEL[pointerTool]}
        </button>
        {tool && <span className="pill">{TOOL_LABEL[tool]}</span>}
      </div>

      <div className="hudbar">
        <button className="icon-btn" type="button" onClick={props.onHelp} aria-pressed={props.panel === 'help'} title="Help (?)">
          <Icon name="help" />
        </button>
        <button className="icon-btn" type="button" onClick={props.onTrain} title="Practice gestures (T)">
          <Icon name="hand" />
        </button>
        <button className="icon-btn" type="button" onClick={props.onSettings} aria-pressed={props.panel === 'settings'} title="Settings">
          <Icon name="settings" />
        </button>
        <button className="icon-btn" type="button" onClick={props.onCamera} title={props.cameraOn ? 'Turn tracking off' : 'Turn tracking on'}>
          <Icon name={props.cameraOn ? 'camera' : 'cameraOff'} />
        </button>
        <button className="icon-btn" type="button" onClick={props.onFullscreen} title="Fullscreen (F)">
          <Icon name={props.isFullscreen ? 'shrink' : 'expand'} />
        </button>
        <span className="hud-div" />
        <button className="icon-btn" type="button" onClick={props.onExit} title="Exit (Esc)">
          <Icon name="close" />
        </button>
      </div>
    </div>
  );
}

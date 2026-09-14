import { useEffect, useRef, useState } from 'react';
import { tracker, type CameraStatus, type HandFrame } from '../lib/tracker';

export type { CameraStatus, HandFrame };

/**
 * Subscribes to the shared hand tracker. Frames go to `onFrame` directly, outside React
 * state, so 30–60 fps never re-renders.
 */
export function useHandTracking(enabled: boolean, onFrame: (frame: HandFrame) => void): CameraStatus {
  const [status, setStatus] = useState<CameraStatus>(tracker.status);
  const onFrameRef = useRef(onFrame);

  useEffect(() => {
    onFrameRef.current = onFrame;
  }, [onFrame]);

  useEffect(() => {
    if (!enabled) return;
    const release = tracker.acquire();
    const offStatus = tracker.onStatus(setStatus);
    const offFrame = tracker.onFrame(frame => onFrameRef.current(frame));
    return () => {
      offFrame();
      offStatus();
      release();
    };
  }, [enabled]);

  return enabled ? status : 'off';
}

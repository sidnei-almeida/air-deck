import { HandLandmarker } from '@mediapipe/tasks-vision';

/** Runs the hand landmarker off the main thread. Frames arrive as transferred VideoFrames. */
let landmarker: HandLandmarker | null = null;

const post = (message: unknown) => (self as unknown as { postMessage(m: unknown): void }).postMessage(message);

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;

  if (msg.type === 'init') {
    try {
      const fileset = { wasmLoaderPath: msg.loaderPath, wasmBinaryPath: msg.binaryPath };
      const create = (delegate: 'GPU' | 'CPU') =>
        HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: msg.modelPath, delegate },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.45,
          minTrackingConfidence: 0.4,
        });
      try {
        landmarker = await create('GPU');
      } catch {
        landmarker = await create('CPU');
      }
      post({ type: 'ready' });
    } catch (err) {
      post({ type: 'error', message: String(err) });
    }
    return;
  }

  if (msg.type === 'detect') {
    const frame = msg.frame as VideoFrame | ImageBitmap;
    try {
      if (!landmarker) throw new Error('Landmarker not started');
      const r = landmarker.detectForVideo(frame, msg.t);
      post({
        type: 'result',
        t: msg.t,
        landmarks: r.landmarks.map(hand => hand.map(p => ({ x: p.x, y: p.y }))),
        handedness: r.handedness.map(h => h[0]?.categoryName ?? ''),
      });
    } catch (err) {
      post({ type: 'result', t: msg.t, error: String(err) });
    } finally {
      frame.close();
    }
  }
};

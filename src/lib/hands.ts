import { HandLandmarker } from '@mediapipe/tasks-vision';
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';

/** Model served by the app itself: nothing about the camera leaves the browser. */
const MODEL_URL = '/models/hand_landmarker.task';

/** Main-thread fallback when the worker can't run. Loaded on demand. */
export async function createHandLandmarker(): Promise<HandLandmarker> {
  const fileset = { wasmLoaderPath, wasmBinaryPath };
  const options = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: 'VIDEO' as const,
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.45,
    minTrackingConfidence: 0.4,
  });
  try {
    return await HandLandmarker.createFromOptions(fileset, options('GPU'));
  } catch {
    return HandLandmarker.createFromOptions(fileset, options('CPU'));
  }
}

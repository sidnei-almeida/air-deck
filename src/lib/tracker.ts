import type { Landmark } from './gestures';
import { debugLog, debugStat } from './debug';
import moduleLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url';
import moduleBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url';

export type CameraStatus = 'off' | 'starting' | 'ready' | 'denied' | 'unavailable' | 'error';

export interface HandFrame {
  hands: Landmark[][];
  /** MediaPipe handedness label per hand. */
  handedness: string[];
  /** Capture time, performance.now() clock. */
  t: number;
  aspect: number;
  video: HTMLVideoElement;
  backend: 'worker' | 'main';
}

interface DetectResult {
  landmarks: Landmark[][];
  handedness: string[];
}

interface Backend {
  kind: 'worker' | 'main';
  detect(video: HTMLVideoElement, t: number): Promise<DetectResult>;
  close(): void;
}

type VideoFrameCallback = (now: number, meta: { captureTime?: number }) => void;
type VideoWithCallbacks = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: VideoFrameCallback) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

const MODEL_URL = '/models/hand_landmarker.task';
const absolute = (url: string) => new URL(url, window.location.href).href;

/** Inference in a Web Worker keeps the main thread free for 60–120 fps rendering. */
async function createWorkerBackend(): Promise<Backend> {
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') throw new Error('Workers unavailable');
  const worker = new Worker(new URL('../workers/hands.worker.ts', import.meta.url), { type: 'module' });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Timed out starting the worker')), 20000);
      worker.onmessage = e => {
        if (e.data.type === 'ready') {
          window.clearTimeout(timer);
          resolve();
        } else if (e.data.type === 'error') {
          window.clearTimeout(timer);
          reject(new Error(e.data.message));
        }
      };
      worker.onerror = e => {
        window.clearTimeout(timer);
        reject(new Error(e.message));
      };
      worker.postMessage({ type: 'init', loaderPath: absolute(moduleLoaderUrl), binaryPath: absolute(moduleBinaryUrl), modelPath: absolute(MODEL_URL) });
    });
  } catch (err) {
    worker.terminate();
    throw err;
  }

  let pending: { resolve: (r: DetectResult) => void; reject: (e: Error) => void } | null = null;
  worker.onmessage = e => {
    if (e.data.type !== 'result' || !pending) return;
    const p = pending;
    pending = null;
    if (e.data.error) p.reject(new Error(e.data.error));
    else p.resolve({ landmarks: e.data.landmarks, handedness: e.data.handedness });
  };
  worker.onerror = e => {
    pending?.reject(new Error(e.message));
    pending = null;
  };

  return {
    kind: 'worker',
    async detect(video, t) {
      const frame = typeof VideoFrame !== 'undefined' ? new VideoFrame(video, { timestamp: Math.round(t * 1000) }) : await createImageBitmap(video);
      return new Promise<DetectResult>((resolve, reject) => {
        pending = { resolve, reject };
        worker.postMessage({ type: 'detect', frame, t }, [frame]);
      });
    },
    close() {
      worker.terminate();
      pending?.reject(new Error('closed'));
      pending = null;
    },
  };
}

async function createMainBackend(): Promise<Backend> {
  const { createHandLandmarker } = await import('./hands');
  const landmarker = await createHandLandmarker();
  return {
    kind: 'main',
    async detect(video, t) {
      const r = landmarker.detectForVideo(video, t);
      return { landmarks: r.landmarks, handedness: r.handedness.map(h => h[0]?.categoryName ?? '') };
    },
    close() {
      landmarker.close();
    },
  };
}

/**
 * One camera and one hand model for the whole app, shared by the presenter and the trainer.
 * Reference-counted: the camera turns off shortly after the last user releases it.
 */
class HandTracker {
  status: CameraStatus = 'off';
  private users = 0;
  private stopTimer = 0;
  private session: { stop(): void } | null = null;
  private backend: Promise<Backend> | null = null;
  private statusListeners = new Set<(s: CameraStatus) => void>();
  private frameListeners = new Set<(f: HandFrame) => void>();

  acquire() {
    this.users++;
    window.clearTimeout(this.stopTimer);
    if (!this.session) this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.users--;
      if (this.users === 0) this.stopTimer = window.setTimeout(() => this.stop(), 1200);
    };
  }

  onStatus(fn: (s: CameraStatus) => void) {
    this.statusListeners.add(fn);
    fn(this.status);
    return () => {
      this.statusListeners.delete(fn);
    };
  }

  onFrame(fn: (f: HandFrame) => void) {
    this.frameListeners.add(fn);
    return () => {
      this.frameListeners.delete(fn);
    };
  }

  private setStatus(status: CameraStatus) {
    this.status = status;
    debugLog('camera', { status });
    this.statusListeners.forEach(fn => fn(status));
  }

  private getBackend() {
    this.backend ??= createWorkerBackend()
      .catch(err => {
        console.warn('[air-deck] tracking in a worker unavailable, using the main thread', err);
        debugLog('backend-fallback', { error: String(err) });
        return createMainBackend();
      })
      .catch(err => {
        this.backend = null;
        throw err;
      });
    return this.backend;
  }

  private stop() {
    this.session?.stop();
    this.session = null;
    this.setStatus('off');
  }

  private start() {
    let stopped = false;
    let stream: MediaStream | null = null;
    let raf = 0;
    let videoCallback = 0;
    const video = document.createElement('video') as VideoWithCallbacks;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('aria-hidden', 'true');
    Object.assign(video.style, { position: 'fixed', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none', left: '-10px', top: '-10px' });
    document.body.appendChild(video);

    this.session = {
      stop: () => {
        stopped = true;
        cancelAnimationFrame(raf);
        if (videoCallback) video.cancelVideoFrameCallback?.(videoCallback);
        stream?.getTracks().forEach(track => track.stop());
        video.srcObject = null;
        video.remove();
      },
    };
    this.setStatus('starting');

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        this.setStatus('unavailable');
        return;
      }
      const backendPromise = this.getBackend();
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } },
          audio: false,
        });
      } catch (err) {
        if (stopped) return;
        const name = (err as { name?: string }).name;
        this.setStatus(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' ? 'unavailable' : 'error');
        return;
      }
      let backend: Backend;
      try {
        backend = await backendPromise;
      } catch {
        if (!stopped) this.setStatus('error');
        return;
      }
      if (stopped) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      video.srcObject = stream;
      await video.play().catch(() => {});
      if (stopped) return;
      stream.getVideoTracks()[0]?.addEventListener('ended', () => this.setStatus('error'));
      const settings = stream.getVideoTracks()[0]?.getSettings();
      debugLog('camera-ready', { backend: backend.kind, width: settings?.width, height: settings?.height, fps: settings?.frameRate });
      this.setStatus('ready');

      let busy = false;
      let lastFrameT = 0;
      const run = async (t: number) => {
        if (busy || stopped || video.readyState < 2) {
          if (busy) debugStat('droppedFrames', 1);
          return;
        }
        busy = true;
        try {
          const started = performance.now();
          const result = await backend.detect(video, t);
          if (stopped) return;
          debugStat('detectMs', performance.now() - started);
          debugStat('captureToResultMs', performance.now() - t);
          if (lastFrameT) debugStat('frameGapMs', t - lastFrameT);
          lastFrameT = t;
          debugStat('hands', result.landmarks.length);
          const frame: HandFrame = {
            hands: result.landmarks,
            handedness: result.handedness,
            t,
            aspect: video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 4 / 3,
            video,
            backend: backend.kind,
          };
          this.frameListeners.forEach(fn => fn(frame));
        } catch (err) {
          if (!stopped && backend.kind === 'worker') {
            console.warn('[air-deck] worker failed, switching to the main thread', err);
            debugLog('backend-fallback', { error: String(err) });
            backend.close();
            this.backend = createMainBackend();
            backend = await this.backend;
          }
        } finally {
          busy = false;
        }
      };

      if (video.requestVideoFrameCallback) {
        const onVideoFrame: VideoFrameCallback = (now, meta) => {
          if (stopped) return;
          videoCallback = video.requestVideoFrameCallback!(onVideoFrame);
          const capture = meta.captureTime;
          run(capture && capture <= now && now - capture < 500 ? capture : now);
        };
        videoCallback = video.requestVideoFrameCallback(onVideoFrame);
      } else {
        let lastTime = -1;
        const loop = () => {
          if (stopped) return;
          raf = requestAnimationFrame(loop);
          if (video.currentTime === lastTime) return;
          lastTime = video.currentTime;
          run(performance.now());
        };
        raf = requestAnimationFrame(loop);
      }
    })();
  }
}

export const tracker = new HandTracker();

const PATHS = {
  help: 'M9.2 9a2.9 2.9 0 1 1 4 2.7c-.8.4-1.2 1-1.2 1.8v.5M12 17.2v.1M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  settings: 'M4 7h9m4 0h3M4 17h3m4 0h9M15 5v4M9 15v4',
  camera: 'M3 8.5A2.5 2.5 0 0 1 5.5 6h9A2.5 2.5 0 0 1 17 8.5v7a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 3 15.5v-7ZM17 10.5l4-2.5v8l-4-2.5',
  cameraOff: 'M3 3l18 18M8.5 6h6A2.5 2.5 0 0 1 17 8.5v5M17 10.5l4-2.5v8l-2.2-1.4M14.5 18h-9A2.5 2.5 0 0 1 3 15.5v-7c0-1 .6-1.8 1.4-2.2',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  shrink: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  close: 'M6 6l12 12M18 6 6 18',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Zm0 0v5h5',
  arrowRight: 'M5 12h14m-6-6 6 6-6 6',
  arrowLeft: 'M19 12H5m6-6-6 6 6 6',
  shield: 'M12 3 5 6v5.5c0 4.3 3 8.2 7 9.5 4-1.3 7-5.2 7-9.5V6l-7-3Z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  ruler: 'M3 17 17 3l4 4L7 21l-4-4Zm4-4 2 2m1-5 2 2m1-5 2 2',
  check: 'M5 12.5 10 17.5 19 7',
  thumbUp: 'M7 10.5V20H4v-9.5h3Zm0 0 3.8-7c1.5 0 2.7 1.2 2.7 2.7V9h5.2a2 2 0 0 1 2 2.4l-1.3 6.9A2.1 2.1 0 0 1 17.3 20H7',
  github: 'M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 3.5c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4M9 18c-4.51 2-5-2-7-2',
  hand: 'M8 12.5V5.8a1.5 1.5 0 0 1 3 0V11m0-6.3a1.5 1.5 0 0 1 3 0V11m0-5.2a1.5 1.5 0 0 1 3 0V14c0 4-2.6 7-6.5 7-2.8 0-4.4-1.5-5.5-3.6l-1.6-3.2a1.5 1.5 0 0 1 2.5-1.6L8 14',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

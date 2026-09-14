/** Air-Deck mark: an open 4:3 slide with the Holofote dot in the missing corner. */
export function Mark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path
        d="M28 12H11a6 6 0 0 0-6 6v15a6 6 0 0 0 6 6h24a6 6 0 0 0 6-6v-8"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="41" cy="12" r="4.25" fill="var(--ad-holofote)" />
    </svg>
  );
}

/** Logotype "airdeck": lowercase, the dot of the i is the Holofote point. */
export function Wordmark() {
  return (
    <span className="wordmark" aria-label="airdeck">
      a<span className="wordmark-i">ı</span>rdeck
    </span>
  );
}

export function Lockup({ size = 22 }: { size?: number }) {
  return (
    <span className="lockup" style={{ fontSize: size }}>
      <Mark size={Math.round(size * 1.2)} />
      <Wordmark />
    </span>
  );
}

// The cockpit's line icons, inline so the page fetches nothing to draw itself.
// 24×24 grid, 2px stroke, currentColor — they take the colour of the thing
// they sit in.

const PATHS: Record<string, string[]> = {
  arrowRight: ["M5 12h14", "m12 5 7 7-7 7"],
  chevronLeft: ["m15 6-6 6 6 6"],
  chevronRight: ["m9 6 6 6-6 6"],
  skip: ["m5 4 10 8-10 8V4Z", "M19 5v14"],
  rerun: ["M21 12a9 9 0 1 1-3-6.7", "M21 4v5h-5"],
  zap: ["M13 2 4 14h7l-1 8 9-12h-7Z"],
  comment: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
  check: ["M20 6 9 17l-5-5"],
  edit: ["M12 20h9", "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"],
  drop: ["M3 6h18", "M8 6V4h8v2", "M6 6l1 14h10l1-14"],
  plus: ["M12 5v14", "M5 12h14"],
  send: ["M22 2 11 13", "M22 2 15 22l-4-9-9-4Z"],
  eye: ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"],
  download: ["M12 3v12", "m7 12 5 5 5-5", "M5 21h14"],
  external: ["M14 4h6v6", "M20 4 10 14", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"],
};

/** Icons with a circle in them, drawn before the paths. */
const CIRCLES: Record<string, { cx: number; cy: number; r: number }[]> = {
  approve: [{ cx: 12, cy: 12, r: 9 }],
  changes: [{ cx: 12, cy: 12, r: 9 }],
  eye: [{ cx: 12, cy: 12, r: 3 }],
};

const EXTRA: Record<string, string[]> = {
  approve: ["m8 12 3 3 5-6"],
  changes: ["M12 8v5", "M12 16h.01"],
};

export type IconName =
  | keyof typeof PATHS
  | "approve"
  | "changes";

export function Icon({ name, size = 13 }: { name: IconName; size?: number }) {
  const paths = [...(PATHS[name] ?? []), ...(EXTRA[name] ?? [])];
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {(CIRCLES[name] ?? []).map((c, i) => (
        <circle key={i} cx={c.cx} cy={c.cy} r={c.r} />
      ))}
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

/** A keycap, for the hints that tell you the keyboard can do this too. */
export function Key({ children }: { children: React.ReactNode }) {
  return <span className="key">{children}</span>;
}

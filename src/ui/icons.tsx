import type { CSSProperties, ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function I({ size = 15, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden {...rest}
    >
      {children}
    </svg>
  );
}

export const IconFolder = (p: IconProps) => (
  <I {...p}><path d="M3 7.5A2 2 0 0 1 5 5.5h3.6l1.8 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></I>
);
export const IconDownload = (p: IconProps) => (
  <I {...p}><path d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5" /><path d="M4 17.5V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.5" /></I>
);
export const IconUpload = (p: IconProps) => (
  <I {...p}><path d="M12 16V4m0 0 4.5 4.5M12 4 7.5 8.5" /><path d="M4 17.5V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.5" /></I>
);
export const IconPlus = (p: IconProps) => (
  <I {...p}><path d="M12 5v14M5 12h14" /></I>
);
export const IconX = (p: IconProps) => (
  <I {...p}><path d="M6 6l12 12M18 6 6 18" /></I>
);
export const IconAlert = (p: IconProps) => (
  <I {...p}><path d="M12 3.5 21 20H3z" /><path d="M12 9.5v4.5M12 17.2v.1" /></I>
);
export const IconChevron = (p: IconProps) => (
  <I {...p}><path d="m9 5 7 7-7 7" /></I>
);
export const IconPin = (p: IconProps) => (
  <I {...p}><path d="M9 3h6l-1 6 4 3v2H6v-2l4-3z" /><path d="M12 14v7" /></I>
);
export const IconRefresh = (p: IconProps) => (
  <I {...p}><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4.5V11h-6.5" /></I>
);
export const IconArrowRight = (p: IconProps) => (
  <I {...p}><path d="M4 12h15m0 0-5-5m5 5-5 5" /></I>
);
export const IconLoop = (p: IconProps) => (
  <I {...p}><path d="M4 9.5A5.5 5.5 0 0 1 9.5 4h5A5.5 5.5 0 0 1 20 9.5v0a5.5 5.5 0 0 1-5.5 5.5H10" /><path d="m12.5 12.5-3 3 3 3" /></I>
);
export const IconSearch = (p: IconProps) => (
  <I {...p}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 5 5" /></I>
);
export const IconFile = (p: IconProps) => (
  <I {...p}><path d="M6 3h7l5 5v13H6z" /><path d="M13 3v5h5" /></I>
);
export const IconBrackets = (p: IconProps) => (
  <I {...p}><path d="M9 4H6v16h3M15 4h3v16h-3" /></I>
);
export const IconUndo = (p: IconProps) => (
  <I {...p}><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-4" /></I>
);
export const IconCopy = (p: IconProps) => (
  <I {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" /></I>
);
export const IconZap = (p: IconProps) => (
  <I {...p}><path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z" /></I>
);

/** Brand mark: two nodes joined by an indexed link. */
export function Logo({ size = 26, style }: { size?: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={style} aria-hidden>
      <rect x="1.5" y="1.5" width="29" height="29" rx="8" fill="#0E1A1A" stroke="#2B4A46" />
      <rect x="6.5" y="7" width="8" height="7" rx="2" fill="#12242A" stroke="#4ED8C0" strokeWidth="1.3" />
      <rect x="17.5" y="18" width="8" height="7" rx="2" fill="#12242A" stroke="#F0B45F" strokeWidth="1.3" />
      <path d="M14.5 10.5h3.2a2 2 0 0 1 2 2V18" stroke="#4ED8C0" strokeWidth="1.3" />
      <circle cx="19.7" cy="18" r="1.4" fill="#F0B45F" />
    </svg>
  );
}

// Icon set, ported from the original design prototype.
// ponytail: static trusted SVG strings rendered via innerHTML; switch to per-file SVG components if the set grows.
const I = {
  home:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/></svg>',
  dumbbell:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6.5 6.5v11M17.5 6.5v11M3 9v6M21 9v6M6.5 12h11"/></svg>',
  trophy:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8v5a4 4 0 0 1-8 0V4Z"/><path d="M8 5H4.5a3.5 3.5 0 0 0 3.6 3.5M16 5h3.5a3.5 3.5 0 0 1-3.6 3.5M12 13v4M8.5 20h7M10 17h4"/></svg>',
  shop:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16l-1.2 12a2 2 0 0 1-2 1.8H7.2a2 2 0 0 1-2-1.8L4 7Z"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/></svg>',
  user:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="8" r="4.2"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/></svg>',
  gem:'<svg viewBox="0 0 24 24" fill="none" stroke="var(--coin-edge,#b98318)" stroke-width="2"><circle cx="12" cy="12" r="9" fill="var(--coin,#e0a526)"/><circle cx="12" cy="12" r="5.5"/></svg>',
  star:'<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="m12 2.6 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4l-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9L12 2.6Z"/></svg>',
  check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.5 5 5 10-11"/></svg>',
  bookmark:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h12v17l-6-4.2-6 4.2v-17Z"/></svg>',
  bookmarkOn:'<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h12v17l-6-4.2-6 4.2v-17Z"/></svg>',
  trash:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4.5h6V7M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>',
  lock:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><rect x="5" y="11" width="14" height="9" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  bolt:'<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2Z"/></svg>',
  pen:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4 11.5-11.5Z"/><path d="M14 6l4 4"/></svg>',
  book:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17.5H6.5A2.5 2.5 0 0 0 4 22V4.5Z"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/></svg>',
  story:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h11l3 3v15H5V3Z"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>',
  mic:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>',
  headphones:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 14a8 8 0 0 1 16 0"/><rect x="3" y="13" width="4" height="7" rx="2"/><rect x="17" y="13" width="4" height="7" rx="2"/></svg>',
  video:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="m16 10.5 5-2.5v8l-5-2.5"/></svg>',
  chat:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4V5Z"/><path d="M8 9.5h8M8 12.5h5"/></svg>',
  captions:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10.5 10a2.4 2.4 0 1 0 0 4M17 10a2.4 2.4 0 1 0 0 4"/></svg>',
  send:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 3 10 14"/><path d="M21 3l-7 18-4-7-7-4 18-7Z"/></svg>',
  down:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  phone:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13.5c5-4.7 13-4.7 18 0l-2.2 2.7-3.6-1.3v-2.6a11 11 0 0 0-6.4 0v2.6l-3.6 1.3L3 13.5Z"/></svg>',
  bell:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9Z"/><path d="M10 19.5a2.2 2.2 0 0 0 4 0"/></svg>',
  gear:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1"/></svg>',
  clock:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
  users:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="9" cy="8.5" r="3.5"/><path d="M3 19.5a6 6 0 0 1 12 0M15.5 5.3a3.5 3.5 0 0 1 0 6.4M17.5 13.8a6 6 0 0 1 3.5 5.7"/></svg>',
  swap:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h15l-4-4M20 16H5l4 4"/></svg>',
  refresh:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 3v4.5h-4.5"/></svg>',
  x:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  spark:'<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2c.7 4.5 2 6 6.5 6.7C14 9.4 12.7 10.9 12 15.4 11.3 10.9 10 9.4 5.5 8.7 10 8 11.3 6.5 12 2ZM19 14c.4 2.4 1 3 3.4 3.4C20 17.8 19.4 18.4 19 20.8c-.4-2.4-1-3-3.4-3.4C18 17 18.6 16.4 19 14Z"/></svg>',
  drop:'<svg viewBox="0 0 24 24" fill="var(--blue,#3d7a99)" stroke="none"><path d="M12 2.5c3.6 4.3 6.5 7.6 6.5 11.2a6.5 6.5 0 0 1-13 0C5.5 10.1 8.4 6.8 12 2.5Z"/><path d="M9 14a3 3 0 0 0 2.4 3" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width="1.8" stroke-linecap="round"/></svg>',
  roots:'<svg viewBox="0 0 24 24" fill="none" stroke="var(--green,#4f8a3c)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 13V8"/><path d="M12 8c0-3 2-4.5 5-4.5 0 3-2 4.5-5 4.5Z"/><path d="M12 10.5c0-2.5-1.7-3.8-4.5-3.8 0 2.7 1.8 3.8 4.5 3.8Z"/><path d="M12 13c0 3-1 5-3 7.5M12 15.5c1 1.5 3 2.5 4 5M12 15l-5 1.5"/></svg>',
  greenhouse:'<svg viewBox="0 0 24 24" fill="none" stroke="var(--green,#4f8a3c)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 20.5v-9L12 4l8.5 7.5v9Z"/><path d="M12 4v16.5M3.5 14.5h17M8 8v12.5M16 8v12.5"/></svg>',
  basket:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 10a4.5 4.5 0 0 1 9 0"/><path d="M3 10h18l-1.7 9a2 2 0 0 1-2 1.6H6.7a2 2 0 0 1-2-1.6L3 10Z"/><path d="M9 10v10.5M15 10v10.5M3.8 14.5h16.4"/></svg>',
  info:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.5" r=".6" fill="currentColor"/></svg>',
  help:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 3-3 3 3 0 0 1 3 3c0 1.5-1.5 2.5-1.5 3.5"/><path d="M12 17h.01"/></svg>',
  qr:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><rect x="3.5" y="3.5" width="6" height="6" rx="1"/><rect x="14.5" y="3.5" width="6" height="6" rx="1"/><rect x="3.5" y="14.5" width="6" height="6" rx="1"/><path d="M14.5 14.5h2.5v2.5h-2.5zM18 18h2.5v2.5H18zM14.5 20.5h1M20.5 14.5v1" stroke-linecap="round"/></svg>',
  dots:'<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="19" cy="12" r="2.2"/></svg>',
} as const;

export type IconName = keyof typeof I;

/** `size` (px) overrides the default 24px glyph; a fixed-size wrapper alone does not resize the SVG. */
export function Icon({ name, className, size }: { name: IconName; className?: string; size?: number }) {
  return <span aria-hidden="true" className={className ? `ic ${className}` : "ic"} style={{ display: "inline-flex", ...(size && { "--ic": `${size}px` }) } as React.CSSProperties} dangerouslySetInnerHTML={{ __html: I[name] }} />;
}

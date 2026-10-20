const paths = {
  contacts: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M20 8v6M17 11h6',
  import: 'M12 3v12M7 10l5 5 5-5M4 16v5h16v-5',
  memory: 'M3 4h7l2 2 2-2h7v15h-7l-2 2-2-2H3V4ZM12 6v15',
  sync: 'M20 7a9 9 0 0 0-15-2L2 8M2 3v5h5M4 17a9 9 0 0 0 15 2l3-3M22 21v-5h-5',
  config: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  write: 'M16 3l5 5L9 20l-6 1 1-6L16 3ZM13 6l5 5',
  close: 'M6 6l12 12M18 6 6 18',
  sparkle: 'M12 3l3 6 6 3-6 3-3 6-3-6-6-3 6-3 3-6Z',
  check: 'M5 12l4 4L19 6',
  copy: 'M8 8h13v13H8V8ZM16 8V3H3v13h5',
  chevron: 'M7 10l5 5 5-5',
} as const;

export function Icon({ name, size = 18 }: { name: keyof typeof paths; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={paths[name]} />
  </svg>;
}

export default function Icon({ name }: { name: 'hide' | 'close' | 'shield' | 'screen' | 'folder' }) {
  const paths = {
    hide: 'M5 12h14', close: 'm6 6 12 12M6 18 18 6',
    shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6zM8 12l3 3 5-6',
    screen: 'M3 4h18v13H3zM8 21h8M12 17v4',
    folder: 'M3 6h7l2 2h9v12H3z',
  };
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}

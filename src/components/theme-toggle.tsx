'use client';

import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'wac-theme';

/*
 * Runs before first paint, inlined into the document head.
 *
 * Deciding the theme in an effect would paint the default and then correct it,
 * which is the flash of wrong theme every themed app gets judged on. Written
 * as a string because it has to execute before React exists.
 */
export const THEME_BOOTSTRAP = `(function(){try{
var stored=localStorage.getItem('${THEME_STORAGE_KEY}');
var theme=stored==='light'||stored==='dark'?stored:'dark';
document.documentElement.setAttribute('data-theme',theme);
}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

export function ThemeToggle() {
  // Initialised from the attribute the bootstrap script already set, so the
  // button label matches what is on screen from the first render.
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    const current = document.documentElement.getAttribute('data-theme');
    setTheme(current === 'dark' ? 'dark' : 'light');
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(THEME_STORAGE_KEY, next);
    setTheme(next);
  };

  return (
    <button
      type="button"
      className="ghost"
      onClick={toggle}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}

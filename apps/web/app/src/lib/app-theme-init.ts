export const APP_THEME_STORAGE_KEY = "breezify-theme"

/**
 * Inline script that applies the stored theme to <html> while the HTML is
 * still being parsed. Without it the `.dark` class only lands in an effect
 * after hydration, so dark-mode users see a light first paint and anything
 * that reads the theme on mount (Mermaid diagrams) renders light, then redraws.
 * Static string, no user input. Must stay in sync with getSnapshot /
 * resolveEffectiveTheme in components/app-theme-provider.tsx.
 */
export const APP_THEME_INIT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(APP_THEME_STORAGE_KEY)});if(t==="dark"||(t==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`

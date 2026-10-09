// Tema dell'interfaccia: "auto" (segue il sistema), "light" o "dark", salvato in
// settings.theme (pagina Impostazioni).
// Script classico (non modulo) caricato in modo sincrono nel <head> di ogni pagina: imposta
// data-theme su <html>, sempre "light" o "dark", prima del primo disegno, così non compare
// per un attimo il tema sbagliato. Lo stile scuro è in :root[data-theme="dark"] (style.css).
// Legge direttamente il localStorage (stessa chiave di storage.js), perché qui i moduli non
// sono ancora caricati.
(() => {
  const KEY = 'meteo:settings';
  const system = window.matchMedia('(prefers-color-scheme: dark)');

  function saved() {
    try {
      const t = JSON.parse(localStorage.getItem(KEY) || '{}').theme;
      return t === 'light' || t === 'dark' ? t : 'auto';
    } catch {
      return 'auto';
    }
  }

  function apply(choice = saved()) {
    const dark = choice === 'dark' || (choice === 'auto' && system.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    // Colore della barra del browser / della PWA: lo stesso dello sfondo.
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = dark ? '#0c111b' : '#f4f5f7';
  }

  apply();
  system.addEventListener('change', () => apply());
  // Cambio fatto in un'altra scheda, o ritorno dalle Impostazioni con la pagina in bfcache.
  window.addEventListener('storage', (e) => { if (e.key === KEY) apply(); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) apply(); });
  window.meteoTheme = { apply, saved };
})();

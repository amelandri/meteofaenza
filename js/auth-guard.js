// Accesso: script classico (non modulo) caricato in modo sincrono come primo script nel <head>
// delle pagine che mostrano dati (index, verify, settings). Se manca il cookie meteo_auth
// (segnale leggibile della sessione, impostato dal server insieme al cookie di sessione
// HttpOnly, vedi server/auth.py) va subito alla pagina di accesso, prima del primo disegno:
// senza, la pagina si vedeva per un attimo vuota prima del 401 dell'API. Se il cookie c'è ma la
// sessione non vale più (es. password cambiata), resta il controllo dell'API (goToLogin() in
// api.js), e il server toglie il segnale.
(() => {
  if (/(?:^|;\s*)meteo_auth=1(?:;|$)/.test(document.cookie)) return;
  document.documentElement.style.visibility = 'hidden'; // niente disegno mentre si cambia pagina
  const page = location.pathname.split('/').pop() || './';
  location.replace(`login.html?next=${encodeURIComponent(page)}`);
})();

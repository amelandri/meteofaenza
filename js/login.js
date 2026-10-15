// Pagina di accesso: invia nome e password a api/login (il server risponde con il cookie di
// sessione, HttpOnly: JavaScript non lo vede) e torna alla pagina da cui si è arrivati
// (?next=…, solo pagine dell'app). Se l'accesso c'è già, ci torna subito.

const $ = (sel) => document.querySelector(sel);
const PAGES = ['./', 'index.html', 'verify.html', 'settings.html', 'info.html'];
const raw = new URLSearchParams(location.search).get('next');
const next = PAGES.includes(raw) ? raw : './'; // mai indirizzi esterni o arbitrari

function showError(msg) {
  const el = $('#login-error');
  el.textContent = msg || '';
  el.hidden = !msg;
}

// Già collegati (es. pagina di login aperta da un segnalibro): si torna all'app.
fetch('api/me', { cache: 'no-store' }).then((r) => { if (r.ok) location.replace(next); }).catch(() => {});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#login-user').value.trim();
  const password = $('#login-pass').value;
  if (!username || !password) { showError('Inserisci nome utente e password.'); return; }
  const btn = $('#login-btn');
  btn.disabled = true;
  showError('');
  try {
    const res = await fetch('api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      cache: 'no-store',
    });
    if (res.ok) { location.replace(next); return; }
    let msg = 'Accesso non riuscito.';
    try { msg = `${(await res.json()).error}.`.replace(/^./, (c) => c.toUpperCase()); } catch { /* risposta non JSON */ }
    showError(msg);
    $('#login-pass').select();
  } catch {
    showError('Connessione non riuscita: riprova.');
  } finally {
    btn.disabled = false;
  }
});

$('#login-user').focus();

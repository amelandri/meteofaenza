// Pagina Impostazioni: tema (automatico/chiaro/scuro, settings.theme, applicato da
// js/theme.js), modelli mostrati (entrambi / solo ICON-2I / solo ICON-EU, settings.models,
// letti da app.js), grafico e sezioni all'apertura (app.js), scelte della Verifica
// (verify.js) e account (utente collegato, Esci). Le preferenze sono salvate sul server per
// utente (api/settings); il browser ne tiene solo una copia di lettura (storage.js).

import * as store from './storage.js';
import { getJSON, goToLogin } from './api.js';

const $ = (sel) => document.querySelector(sel);
// --- Preferenze a scelta singola (tema, modelli, grafico, sezioni, verifica) ---
// Tre tipi di controllo con data-pref: gruppi di pulsanti .seg (un pulsante per valore,
// data-value = String(valore) di PREF_VALUES in storage.js), menu a tendina (option value =
// String(valore)) e interruttori .switch (preferenze true/false). La scelta si salva subito
// sul server, senza pulsante Salva. Il tema si applica anche a questa pagina (vale anche se
// lo storage è bloccato).
const segs = [...document.querySelectorAll('.seg[data-pref]')];
const selects = [...document.querySelectorAll('select[data-pref]')];
const switches = [...document.querySelectorAll('.switch[data-pref]')];

function syncPrefs(settings = store.getSettings()) {
  for (const g of segs) {
    const current = String(settings[g.dataset.pref]);
    for (const b of g.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.value === current));
  }
  for (const sel of selects) sel.value = String(settings[sel.dataset.pref]);
  for (const sw of switches) sw.setAttribute('aria-checked', String(settings[sw.dataset.pref] === true));
}

// Il valore vero (stringa, numero o booleano) è quello di PREF_VALUES con lo stesso testo.
function savePref(key, raw) {
  const value = store.PREF_VALUES[key]?.find((v) => String(v) === raw);
  if (value === undefined || !store.validPref(key, value)) return;
  store.saveSettings({ [key]: value });
  if (key === 'theme') window.meteoTheme?.apply(value);
  syncPrefs({ ...store.getSettings(), [key]: value });
}

for (const g of segs) {
  g.addEventListener('click', (e) => {
    const raw = e.target.closest('button[data-value]')?.dataset.value;
    if (raw !== undefined) savePref(g.dataset.pref, raw);
  });
}
for (const sel of selects) sel.addEventListener('change', () => savePref(sel.dataset.pref, sel.value));
for (const sw of switches) {
  sw.addEventListener('click', () => savePref(sw.dataset.pref, String(sw.getAttribute('aria-checked') !== 'true')));
}
// Preferenze cambiate da un'altra scheda (anche dalla pagina principale) o arrivate dal
// server (cambiate su un altro dispositivo).
window.addEventListener('storage', (e) => { if (e.key === 'meteo:settings') syncPrefs(); });
window.addEventListener('meteo-settings', () => syncPrefs());

syncPrefs(); // subito dalla copia locale, poi dal server
store.syncSettings();
window.addEventListener('pageshow', (e) => { if (e.persisted) store.syncSettings(); });

// --- Account: utente collegato e uscita ---
// api/me richiede l'accesso: senza, getJSON() porta alla pagina di login.
getJSON('api/me').then((me) => {
  const el = $('#account-user');
  el.classList.remove('muted');
  el.textContent = me.user;
  $('#account-avatar').textContent = (me.user || '?').charAt(0).toUpperCase();
  $('#pw-user').value = me.user;
}).catch(() => { $('#account-user').textContent = 'Utente non disponibile'; });

$('#logout-btn').addEventListener('click', async () => {
  await store.syncSettings(); // prima di uscire: le ultime modifiche arrivano al server
  try {
    await fetch('api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store' });
  } catch { /* offline: il cookie resta, ma i dati salvati si tolgono comunque */ }
  goToLogin();
});

// --- Cambio della password (POST api/password) ---
// "Cambia password" (sotto il nome utente) apre il modulo sotto, nella stessa pillola. Controlli nel browser (campi pieni,
// lunghezza minima come MIN_PASSWORD di server/auth.py, ripetizione uguale), poi il server
// verifica la password attuale. Il server chiude le altre sessioni e ne dà una nuova a questo
// browser: si resta collegati.
const MIN_PASSWORD = 8;
const pwForm = $('#pw-form');

function pwMessage(msg) {
  const el = $('#pw-msg');
  el.textContent = msg || '';
  el.hidden = !msg;
}

function pwOpen(open) {
  pwForm.hidden = !open;
  $('#pw-toggle').setAttribute('aria-expanded', String(open));
  $('#pw-toggle').hidden = open;
  pwMessage('');
  if (open) {
    $('#pw-done').hidden = true;
    $('#pw-current').focus();
  } else {
    for (const id of ['#pw-current', '#pw-new', '#pw-repeat']) $(id).value = '';
  }
}

$('#pw-toggle').addEventListener('click', () => pwOpen(true));
$('#pw-cancel').addEventListener('click', () => { pwOpen(false); $('#pw-toggle').focus(); });

pwForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const current = $('#pw-current').value, next = $('#pw-new').value, repeat = $('#pw-repeat').value;
  if (!current || !next || !repeat) return pwMessage('Compila tutti e tre i campi.');
  if (next.length < MIN_PASSWORD) return pwMessage(`La nuova password deve avere almeno ${MIN_PASSWORD} caratteri.`);
  if (next !== repeat) return pwMessage('Le due nuove password non coincidono.');
  if (next === current) return pwMessage('La nuova password è uguale a quella attuale.');
  const btn = $('#pw-save');
  btn.disabled = true;
  pwMessage('');
  try {
    const res = await fetch('api/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current, new: next }),
      cache: 'no-store',
    });
    if (res.status === 401) { goToLogin(); return; }
    if (!res.ok) {
      let body = null;
      try { body = await res.json(); } catch { /* risposta non JSON */ }
      const err = body?.error || `errore del server (${res.status})`;
      pwMessage(`${err.charAt(0).toUpperCase()}${err.slice(1)}.`);
      return;
    }
    pwOpen(false);
    $('#pw-done').hidden = false;
    $('#pw-toggle').focus();
  } catch {
    pwMessage('Server non raggiungibile: controlla la connessione e riprova.');
  } finally {
    btn.disabled = false;
  }
});

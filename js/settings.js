// Pagina Impostazioni: tema (automatico/chiaro/scuro, settings.theme, applicato da
// js/theme.js), modelli mostrati (entrambi / solo ICON-2I / solo ICON-EU, settings.models,
// letti da app.js), grafico e sezioni all'apertura (app.js), scelte della Verifica
// (verify.js) e account (utente collegato, Esci). Le preferenze sono salvate sul server per
// utente (api/settings); il browser ne tiene solo una copia di lettura (storage.js).

import * as store from './storage.js';
import { getJSON, goToLogin } from './api.js';

const $ = (sel) => document.querySelector(sel);
// --- Preferenze a scelta singola (tema, modelli, grafico, sezioni, verifica) ---
// Ogni gruppo .seg[data-pref] ha un pulsante per valore (data-value = String(valore) di
// PREF_VALUES in storage.js); la scelta si salva subito sul server, senza pulsante Salva. Il
// tema si applica anche a questa pagina (vale anche se lo storage è bloccato).
const prefGroups = [...document.querySelectorAll('.seg[data-pref]')];

function syncPrefs(settings = store.getSettings()) {
  for (const g of prefGroups) {
    const current = String(settings[g.dataset.pref]);
    for (const b of g.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.value === current));
  }
}

for (const g of prefGroups) {
  const key = g.dataset.pref;
  g.addEventListener('click', (e) => {
    const raw = e.target.closest('button[data-value]')?.dataset.value;
    // Il valore vero (stringa, numero o booleano) è quello di PREF_VALUES con lo stesso testo.
    const value = store.PREF_VALUES[key]?.find((v) => String(v) === raw);
    if (value === undefined || !store.validPref(key, value)) return;
    store.saveSettings({ [key]: value });
    if (key === 'theme') window.meteoTheme?.apply(value);
    syncPrefs({ ...store.getSettings(), [key]: value });
  });
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
  el.textContent = '';
  el.append('Accesso come ', Object.assign(document.createElement('b'), { textContent: me.user }));
}).catch(() => { $('#account-user').textContent = 'Utente non disponibile'; });

$('#logout-btn').addEventListener('click', async () => {
  await store.syncSettings(); // prima di uscire: le ultime modifiche arrivano al server
  try {
    await fetch('api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store' });
  } catch { /* offline: il cookie resta, ma i dati salvati si tolgono comunque */ }
  goToLogin();
});

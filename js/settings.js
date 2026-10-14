// Pagina Impostazioni: tema (automatico/chiaro/scuro, settings.theme, applicato da
// js/theme.js), modelli mostrati (entrambi / solo ICON-2I / solo ICON-EU, settings.models,
// letti da app.js), grafico e sezioni all'apertura (app.js) e scelte della Verifica
// (verify.js). I valori sono salvati nel localStorage. Esportazione e importazione di tutte
// le preferenze in un file JSON.

import * as store from './storage.js';

const $ = (sel) => document.querySelector(sel);
// --- Preferenze a scelta singola (tema, modelli, grafico, sezioni, verifica) ---
// Ogni gruppo .seg[data-pref] ha un pulsante per valore (data-value = String(valore) di
// PREF_VALUES in storage.js); la scelta si salva subito, senza pulsante Salva. Il tema si
// applica anche a questa pagina (vale anche se lo storage è bloccato).
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
// Preferenze cambiate da un'altra scheda (anche dalla pagina principale).
window.addEventListener('storage', (e) => { if (e.key === 'meteo:settings') syncPrefs(); });

syncPrefs();

// --- Esporta / importa: file JSON con le preferenze ---
// Il file importato non è fidato: lo legge e lo filtra parseSettingsFile() di storage.js, e
// nulla del file finisce in innerHTML (messaggi con textContent, conferma con confirm()).

function showIo(error, done = '') {
  const err = $('#io-error');
  err.textContent = error || '';
  err.hidden = !error;
  const ok = $('#io-done');
  ok.textContent = done;
  ok.hidden = !done;
}

$('#export-settings').addEventListener('click', () => {
  const data = store.exportSettings();
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `meteo-faenza-impostazioni-${data.exportedAt.slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  showIo('', 'File esportato.');
});

const importInput = $('#import-file');
$('#import-settings').addEventListener('click', () => importInput.click());
importInput.addEventListener('change', async () => {
  const file = importInput.files?.[0];
  importInput.value = ''; // così si può riscegliere lo stesso file
  if (!file) return;
  showIo('');
  if (file.size > store.MAX_IMPORT_BYTES) { showIo('Il file è troppo grande per essere un file di impostazioni.'); return; }
  let text;
  try {
    text = await file.text();
  } catch {
    showIo('Impossibile leggere il file.');
    return;
  }
  const { error, settings, ignored } = store.parseSettingsFile(text);
  if (error) { showIo(error); return; }

  if (!Object.keys(settings).length) { showIo('Il file non contiene impostazioni riconosciute.'); return; }
  if (!window.confirm('Sostituire le impostazioni con quelle del file?')) return;
  if (!store.importSettings(settings)) { showIo('Impossibile salvare: lo storage del browser non è disponibile.'); return; }

  // Mostra i valori come salvati.
  window.meteoTheme?.apply(store.getSettings().theme);
  syncPrefs();
  const skipped = ignored.length ? ` (${ignored.length} ${ignored.length === 1 ? 'voce non riconosciuta ignorata' : 'voci non riconosciute ignorate'})` : '';
  showIo('', `Impostazioni importate${skipped}.`);
});

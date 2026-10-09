// Pagina Impostazioni: tema (automatico/chiaro/scuro, settings.theme, applicato da
// js/theme.js), modelli mostrati (entrambi / solo ICON-2I / solo ICON-EU, settings.models,
// letti da app.js) e intervalli monitorati (nome e al massimo 3 intervalli orari, settings.watch,
// letti da app.js). I valori sono salvati nel localStorage.

import * as store from './storage.js';

const $ = (sel) => document.querySelector(sel);
const form = $('#watch-form');
const list = $('#watch-windows');
const addBtn = $('#add-window');

const REMOVE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

// Giorni della settimana (0 = domenica, come in storage.js), mostrati da lunedì a domenica.
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_SHORT = ['Do', 'Lu', 'Ma', 'Me', 'Gi', 'Ve', 'Sa'];
const DAY_LONG = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

function windowRow(w = { from: '', to: '', days: store.ALL_DAYS }) {
  const li = document.createElement('li');
  li.className = 'win-row';
  li.innerHTML = `
    <div class="win-times">
      <label><span class="win-tag">Dalle</span><input type="time" class="win-from" required></label>
      <label><span class="win-tag">alle</span><input type="time" class="win-to" required></label>
      <button type="button" class="icon-btn win-remove" title="Rimuovi intervallo" aria-label="Rimuovi intervallo">${REMOVE_ICON}</button>
    </div>
    <div class="win-days" role="group" aria-label="Giorni in cui monitorare l'intervallo">
      ${DAY_ORDER.map((d) => `<label class="win-day" title="${DAY_LONG[d]}"><input type="checkbox" value="${d}" aria-label="${DAY_LONG[d]}"${w.days.includes(d) ? ' checked' : ''}><span>${DAY_SHORT[d]}</span></label>`).join('')}
    </div>`;
  li.querySelector('.win-from').value = w.from;
  li.querySelector('.win-to').value = w.to;
  return li;
}

// Pulsante "Aggiungi" (fino a MAX_WATCH_WINDOWS) e "Rimuovi" (almeno un intervallo).
function syncList() {
  const rows = [...list.children];
  addBtn.hidden = rows.length >= store.MAX_WATCH_WINDOWS;
  for (const r of rows) r.querySelector('.win-remove').disabled = rows.length <= 1;
}

function fill(watch) {
  $('#watch-label').value = watch.label;
  $('#watch-label').maxLength = store.MAX_WATCH_LABEL;
  list.replaceChildren(...watch.windows.map(windowRow));
  syncList();
}

function showError(msg) {
  const el = $('#form-error');
  el.textContent = msg || '';
  el.hidden = !msg;
}

let savedTimer;
function showSaved() {
  const el = $('#saved');
  el.hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

// Legge il modulo; restituisce il messaggio d'errore oppure gli intervalli da salvare.
function readForm() {
  const label = $('#watch-label').value.trim();
  if (!label) return { error: 'Inserisci un nome per gli intervalli.' };
  const windows = [];
  for (const [i, r] of [...list.children].entries()) {
    const from = r.querySelector('.win-from').value;
    const to = r.querySelector('.win-to').value;
    const days = [...r.querySelectorAll('.win-days input:checked')].map((c) => Number(c.value));
    if (!from || !to) return { error: `Intervallo ${i + 1}: indica inizio e fine.` };
    if (from >= to) return { error: `Intervallo ${i + 1}: l'inizio deve precedere la fine.` };
    if (!days.length) return { error: `Intervallo ${i + 1}: scegli almeno un giorno.` };
    windows.push({ from, to, days });
  }
  if (!windows.length) return { error: 'Serve almeno un intervallo.' };
  if (windows.length > store.MAX_WATCH_WINDOWS) return { error: `Al massimo ${store.MAX_WATCH_WINDOWS} intervalli.` };
  // Due intervalli si sovrappongono solo se hanno orari in comune in uno stesso giorno.
  const names = (days) => DAY_ORDER.filter((d) => days.includes(d)).map((d) => DAY_LONG[d]).join(', ');
  for (let i = 0; i < windows.length; i++) {
    for (let j = i + 1; j < windows.length; j++) {
      const a = windows[i], b = windows[j];
      const common = a.days.filter((d) => b.days.includes(d));
      if (common.length && a.from < b.to && b.from < a.to) {
        return { error: `Gli intervalli ${a.from}–${a.to} e ${b.from}–${b.to} si sovrappongono (${names(common)}).` };
      }
    }
  }
  for (const d of DAY_ORDER) {
    if (windows.filter((w) => w.days.includes(d)).length > store.MAX_WATCH_PER_DAY) {
      return { error: `${d === 0 ? 'La' : 'Il'} ${DAY_LONG[d]} ha più di ${store.MAX_WATCH_PER_DAY} intervalli: al massimo ${store.MAX_WATCH_PER_DAY} per giorno.` };
    }
  }
  return { watch: { label, windows } };
}

addBtn.addEventListener('click', () => {
  if (list.children.length >= store.MAX_WATCH_WINDOWS) return;
  const row = windowRow();
  list.append(row);
  syncList();
  row.querySelector('.win-from').focus();
});

list.addEventListener('click', (e) => {
  const btn = e.target.closest('.win-remove');
  if (!btn || list.children.length <= 1) return;
  btn.closest('.win-row').remove();
  syncList();
});

form.addEventListener('input', () => { showError(''); $('#saved').hidden = true; });

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const { error, watch } = readForm();
  if (error) { showError(error); return; }
  if (!store.saveWatch(watch)) { showError('Impossibile salvare: lo storage del browser non è disponibile.'); return; }
  showError('');
  fill(store.getWatch()); // mostra i valori come salvati (intervalli ordinati)
  showSaved();
});

$('#reset-watch').addEventListener('click', () => {
  store.resetWatch();
  showError('');
  fill(store.getWatch());
  showSaved();
});

fill(store.getWatch());

// --- Tema: si applica e si salva subito, senza pulsante Salva ---
const themeSeg = $('#theme-seg');

function syncTheme(current = window.meteoTheme?.saved() ?? 'auto') {
  for (const b of themeSeg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.themeChoice === current));
}

themeSeg.addEventListener('click', (e) => {
  const choice = e.target.closest('button')?.dataset.themeChoice;
  if (!store.THEMES.includes(choice)) return;
  store.saveSettings({ theme: choice });
  window.meteoTheme?.apply(choice); // vale per questa pagina anche se lo storage è bloccato
  syncTheme(choice);
});
// Tema cambiato da un'altra scheda.
window.addEventListener('storage', (e) => { if (e.key === 'meteo:settings') syncTheme(); });

syncTheme();

// --- Modelli mostrati: si salvano subito, senza pulsante Salva ---
const modelsSeg = $('#models-seg');

function syncModels(current = store.getSettings().models) {
  for (const b of modelsSeg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.modelsChoice === current));
}

modelsSeg.addEventListener('click', (e) => {
  const choice = e.target.closest('button')?.dataset.modelsChoice;
  if (!store.MODEL_VIEWS.includes(choice)) return;
  store.saveSettings({ models: choice });
  syncModels(choice);
});
window.addEventListener('storage', (e) => { if (e.key === 'meteo:settings') syncModels(); });

syncModels();

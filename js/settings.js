// Pagina Impostazioni: intervalli monitorati (nome e al massimo 3 intervalli orari).
// I valori sono salvati nel localStorage (settings.watch) e letti da app.js.

import * as store from './storage.js';

const $ = (sel) => document.querySelector(sel);
const form = $('#watch-form');
const list = $('#watch-windows');
const addBtn = $('#add-window');

const REMOVE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function windowRow(w = { from: '', to: '' }) {
  const li = document.createElement('li');
  li.className = 'win-row';
  li.innerHTML = `
    <label><span class="win-tag">Dalle</span><input type="time" class="win-from" required></label>
    <label><span class="win-tag">alle</span><input type="time" class="win-to" required></label>
    <button type="button" class="icon-btn win-remove" title="Rimuovi intervallo" aria-label="Rimuovi intervallo">${REMOVE_ICON}</button>`;
  li.querySelector('.win-from').value = w.from;
  li.querySelector('.win-to').value = w.to;
  return li;
}

// Numerazione, pulsante "Aggiungi" (fino a 3) e "Rimuovi" (almeno un intervallo).
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
    if (!from || !to) return { error: `Intervallo ${i + 1}: indica inizio e fine.` };
    if (from >= to) return { error: `Intervallo ${i + 1}: l'inizio deve precedere la fine.` };
    windows.push({ from, to });
  }
  if (!windows.length) return { error: 'Serve almeno un intervallo.' };
  if (windows.length > store.MAX_WATCH_WINDOWS) return { error: `Al massimo ${store.MAX_WATCH_WINDOWS} intervalli.` };
  const sorted = [...windows].sort((a, b) => a.from.localeCompare(b.from));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].from < sorted[i - 1].to) return { error: `Gli intervalli ${sorted[i - 1].from}–${sorted[i - 1].to} e ${sorted[i].from}–${sorted[i].to} si sovrappongono.` };
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

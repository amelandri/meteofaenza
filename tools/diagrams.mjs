// Disegna i diagrammi di info.html dai sorgenti in docs/diagrams/*.mmd (sintassi Mermaid) con
// Pele (https://pele.run, MIT) e mette l'SVG nella pagina, tra i commenti
//   <!-- diagramma:<nome> --> … <!-- /diagramma:<nome> -->
// Si lancia a mano solo quando cambia un diagramma: la pagina contiene già l'SVG, quindi il
// browser non scarica nessuna libreria (niente build step, niente richieste esterne).
//
//   cd /tmp && npm install pele@1.8.0      (versione fissa)
//   PELE=/tmp/node_modules/pele/dist/pele.js node tools/diagrams.mjs
//
// I colori non sono nell'SVG: vengono dalle variabili --pele-* nella sezione "Pagina
// informativa" di css/style.css, legate ai colori dell'app (tema chiaro e scuro).

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { render } = await import(process.env.PELE ? pathToFileURL(resolve(process.env.PELE)).href : 'pele');
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'; // = --font

const page = join(root, 'info.html');
let html = readFileSync(page, 'utf8');
for (const file of readdirSync(join(root, 'docs/diagrams')).filter((f) => f.endsWith('.mmd')).sort()) {
  const name = file.slice(0, -4);
  const { svg, width, height } = render(readFileSync(join(root, 'docs/diagrams', file), 'utf8'), { fontFamily: FONT, fontSize: 14 });
  // Dimensioni gestite dal CSS (.info-diagram): su telefono il diagramma scorre di lato
  // invece di rimpicciolire il testo.
  const out = svg.replace('max-width:100%;height:auto;', '');
  const re = new RegExp(`(<!-- diagramma:${name} -->)[\\s\\S]*?(<!-- /diagramma:${name} -->)`);
  if (!re.test(html)) throw new Error(`info.html: mancano i commenti del diagramma "${name}"`);
  html = html.replace(re, (_, a, b) => `${a}\n${out}\n${b}`);
  console.log(`${name}: ${Math.round(width)}×${Math.round(height)}`);
}
writeFileSync(page, html);

// Suivi du poids (page Exercices) : chaque pesée est enregistrée avec sa date et son heure,
// stockée dans la même base que le reste de l'app et synchronisée entre appareils.

import { db, uid } from './db.js';
import { startSync } from './sync.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtKg = n => n.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtDay = iso => new Date(iso).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtShort = iso => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
const fmtTime = iso => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

const PAGE = 10;
let entries = [];   // { id, at, kg, createdAt, updatedAt }, la plus récente en premier
let shown = PAGE;

async function load() {
  entries = ((await db.all('weights')) || []).sort((a, b) => b.at.localeCompare(a.at));
  render();
}

function render() {
  const delta = $('#weight-delta');
  if (entries.length >= 2) {
    const d = Math.round((entries[0].kg - entries[1].kg) * 10) / 10;
    const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
    delta.textContent = `${sign}${fmtKg(Math.abs(d))} kg depuis le ${fmtShort(entries[1].at)}`;
  } else {
    delta.textContent = '';
  }

  $('#weight-list').innerHTML = entries.slice(0, shown).map(e => `<li>
      <span class="w-kg">${fmtKg(e.kg)} kg</span>
      <span class="w-date">${esc(fmtDay(e.at))} · ${esc(fmtTime(e.at))}</span>
      <button type="button" class="w-del" data-id="${esc(e.id)}" aria-label="Supprimer la pesée du ${esc(fmtDay(e.at))}">×</button>
    </li>`).join('');
  $('#weight-more').hidden = entries.length <= shown;
  renderChart();
}

// ----- Courbe : une seule série, tracée dans l'ordre chronologique

function renderChart() {
  const box = $('#weight-chart');
  const pts = [...entries].reverse();
  box.hidden = pts.length < 2;
  if (box.hidden) { box.innerHTML = ''; return; }

  const W = Math.max(260, box.clientWidth - 16), H = 150;
  const pad = { l: 34, r: 10, t: 12, b: 22 };
  const t0 = new Date(pts[0].at).getTime(), t1 = new Date(pts[pts.length - 1].at).getTime();
  const kgs = pts.map(p => p.kg);
  const lo = Math.floor(Math.min(...kgs) - 0.5), hi = Math.ceil(Math.max(...kgs) + 0.5);
  const x = t => pad.l + (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const y = kg => pad.t + (hi - kg) / (hi - lo) * (H - pad.t - pad.b);
  const xy = pts.map(p => [x(new Date(p.at).getTime()), y(p.kg)]);

  const ticks = [lo, (lo + hi) / 2, hi];
  const last = xy[xy.length - 1];
  box.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution du poids, de ${fmtKg(pts[0].kg)} à ${fmtKg(pts[pts.length - 1].kg)} kg">
      ${ticks.map(v => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>
        <text class="axis" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${fmtKg(v).replace(',0', '')}</text>`).join('')}
      <text class="axis" x="${pad.l}" y="${H - 4}">${esc(fmtShort(pts[0].at))}</text>
      <text class="axis" x="${W - pad.r}" y="${H - 4}" text-anchor="end">${esc(fmtShort(pts[pts.length - 1].at))}</text>
      <polyline class="line" points="${xy.map(p => p.join(',')).join(' ')}"/>
      <circle class="dot" cx="${last[0]}" cy="${last[1]}" r="4.5"/>
      <line class="cross" y1="${pad.t}" y2="${H - pad.b}" visibility="hidden"/>
      <circle class="dot hover" r="4.5" visibility="hidden"/>
    </svg>
    <div class="w-tip" hidden></div>`;

  // Survol ou toucher : repère vertical et valeur du point le plus proche.
  const svg = box.querySelector('svg'), cross = svg.querySelector('.cross'), hov = svg.querySelector('.hover'), tip = box.querySelector('.w-tip');
  const hide = () => { cross.setAttribute('visibility', 'hidden'); hov.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  svg.addEventListener('pointermove', ev => {
    const r = svg.getBoundingClientRect();
    const mx = (ev.clientX - r.left) * (W / r.width);
    let i = 0;
    xy.forEach((p, k) => { if (Math.abs(p[0] - mx) < Math.abs(xy[i][0] - mx)) i = k; });
    const [px, py] = xy[i];
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
    hov.setAttribute('cx', px); hov.setAttribute('cy', py); hov.setAttribute('visibility', 'visible');
    tip.textContent = `${fmtKg(pts[i].kg)} kg · ${fmtShort(pts[i].at)}`;
    tip.style.left = `${8 + px * (r.width / W)}px`;
    tip.hidden = false;
  });
  svg.addEventListener('pointerleave', hide);
}

// ----- Saisie et suppression

async function addEntry(form) {
  const input = form.kg;
  const kg = Math.round(parseFloat(input.value.replace(',', '.')) * 10) / 10;
  if (!(kg >= 20 && kg <= 400)) { input.setCustomValidity('Indiquez un poids entre 20 et 400 kg.'); input.reportValidity(); return; }
  const now = new Date().toISOString();
  const entry = { id: uid(), at: now, kg, createdAt: now, updatedAt: now };
  await db.put('weights', entry);
  entries.unshift(entry);
  input.value = '';
  input.blur();
  render();
}

async function removeEntry(btn) {
  if (!btn.dataset.confirm) {
    btn.dataset.confirm = '1';
    btn.textContent = 'Supprimer';
    setTimeout(() => { if (btn.isConnected) { delete btn.dataset.confirm; btn.textContent = '×'; } }, 3000);
    return;
  }
  await db.del('weights', btn.dataset.id);
  entries = entries.filter(e => e.id !== btn.dataset.id);
  render();
}

$('#weight-form').addEventListener('submit', e => { e.preventDefault(); addEntry(e.target); });
$('#weight-form').kg.addEventListener('input', e => e.target.setCustomValidity(''));
$('#weight-list').addEventListener('click', e => { const b = e.target.closest('.w-del'); if (b) removeEntry(b); });
$('#weight-more').addEventListener('click', () => { shown += 20; render(); });
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderChart, 150); });

load()
  .then(() => startSync({ onApplied: load }))
  .catch(err => console.error(err));

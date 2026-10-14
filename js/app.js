/* ESPower – app.js  (Vanilla JS + Firebase RTDB) */

import "./background.js";
import { auth } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signOut,
  signInWithEmailAndPassword,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  ref,
  onValue,
  set,
  get,
  push,
  query,
  limitToLast,
  orderByKey,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";

import { db } from "./firebase-config.js";
import {
  telemetryField,
  configureField,
  datalogEntry,
  datalogDay,
  datalogRoot,
  monthlyRoot,
  monthlyMonth,
  monthStart,
  monthStartRoot,
  chartsPath,
  deviceOutput,
  deviceHistory,
  deviceNamesRoot,
  deviceIconsRoot,
} from "./firebase-paths.js";


// ─────────────────────────────────────────────
//  Auth guard – redirect if not logged in
//  (allow ?demo=1 to skip)
// ─────────────────────────────────────────────
const isDemo = new URLSearchParams(window.location.search).has('demo');

let uid = null;
/** Baseline kWh per month (from RTDB `monthStart`) — used for live chart info bar */
let monthStartCache = {};
let demoMode = isDemo;
let demoTimers = [];
let dbUnsubs = [];
let costPerKwh = parseFloat(localStorage.getItem('costPerKwh') || '6.85');
let datalogTimer = null;
let displayIntervalMs = parseInt(localStorage.getItem('displayIntervalMs') || String(15 * 60 * 1000), 10);
let ccalibrate = parseFloat(localStorage.getItem('ccalibrate') || '1');
let vcalibrate = parseFloat(localStorage.getItem('vcalibrate') || '1');
let wmeter = parseFloat(localStorage.getItem('wmeter') || '1');

// Snapshot of latest readings for datalogger write
let latestReadings = { voltage: null, current: null, power: null, kwh: null };
let monthlyUnsub = null;   // separate listener for monthly chart
let deviceStates = {};     // track state across re-renders

// ─────────────────────────────────────────────
//  UI model
// ─────────────────────────────────────────────
const metrics = [
  { id: 'voltage', title: 'Voltaje', unit: 'V', icon: 'zap', max: 260 },
  { id: 'current', title: 'Corriente', unit: 'A', icon: 'activity', max: 100 },
  { id: 'power', title: 'Potencia', unit: 'W', icon: 'flame', max: 5000 },
  { id: 'energy', title: 'Energía', unit: 'kWh', icon: 'gauge', max: 5000 },
];

const devices = [
  { id: 'led', name: 'Dispositivo 1', icon: 'lightbulb' },
  { id: 'led1', name: 'Dispositivo 2', icon: 'wind' },
  { id: 'led2', name: 'Dispositivo 3', icon: 'waves' },
  { id: 'led3', name: 'Dispositivo 4', icon: 'plug' },
];

// Dynamic names/icons from Firebase (override defaults above)
let dynamicDeviceNames = {};
let dynamicDeviceIcons = {};
function devDisplayName(id) { return dynamicDeviceNames[id] || devices.find(d => d.id === id)?.name || id; }
function devDisplayIcon(id) { return dynamicDeviceIcons[id] || devices.find(d => d.id === id)?.icon || 'zap'; }

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────
function clamp01(n) { return Math.min(1, Math.max(0, n)); }

function makeGaugeSVG(value, max) {
  const r = 35;
  const circ = 2 * Math.PI * r;
  const off = circ * (1 - clamp01(Number(value || 0) / Number(max || 1)));
  return `
    <svg class="gauge" viewBox="0 0 80 80" aria-hidden="true">
      <defs>
        <linearGradient id="gaugeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stop-color="#3b82f6"/>
          <stop offset="100%" stop-color="#8b5cf6"/>
        </linearGradient>
      </defs>
      <g transform="rotate(-90 40 40)">
        <circle class="bg" cx="40" cy="40" r="${r}" fill="none" stroke-width="6"></circle>
        <circle cx="40" cy="40" r="${r}" fill="none" stroke="url(#gaugeGrad)" stroke-width="6"
          stroke-linecap="round" stroke-dasharray="${circ}" stroke-dashoffset="${off}"
          style="transition:stroke-dashoffset .5s ease-in-out;"></circle>
      </g>
    </svg>`;
}


function setSystemStatus(text) {
  const el = document.getElementById('systemStatusText');
  if (el) el.textContent = text;
  const topbar = document.getElementById('topbarStatusText');
  if (topbar) topbar.textContent = text;
}

function refreshDataloggerCopy() {
  const title = document.getElementById('dataloggerTitle');
  const mins = Math.max(1, Math.round((displayIntervalMs || (15 * 60 * 1000)) / 60000));
  if (title) title.textContent = `Data Logger (${mins} min)`;
}

function setAppLocked(isLocked) {
  const shell = document.getElementById('appShell');
  const overlay = document.getElementById('authOverlay');
  shell?.classList.toggle('app-locked', isLocked);
  overlay?.classList.toggle('hidden', !isLocked);
}

function setSidebarIdentity(email = '') {
  const sidebarEmail = document.getElementById('sidebarUserEmail');
  if (sidebarEmail) sidebarEmail.textContent = email || 'Sin autenticar';
}

function showLoginError(message = '') {
  const box = document.getElementById('overlayErrorBox');
  const msg = document.getElementById('overlayErrorMsg');
  if (msg) msg.textContent = message;
  box?.classList.toggle('visible', !!message);
}

function humanizeAuthError(error) {
  const code = error?.code || '';
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) {
    return 'Correo o contraseña incorrectos.';
  }
  if (code.includes('too-many-requests')) return 'Demasiados intentos. Probá nuevamente en unos minutos.';
  if (code.includes('network-request-failed')) return 'No se pudo conectar. Revisá tu internet e intentá otra vez.';
  return 'No fue posible iniciar sesión en este momento.';
}

function lucideRefresh() { if (window.lucide) window.lucide.createIcons(); }

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key) {
  // '2026-03' -> 'Marzo'
  const parts = key.split('-');
  const idx = parseInt(parts[1], 10) - 1;
  return MONTHS_ES[idx] ? `${MONTHS_ES[idx]} ${parts[0]}` : key;
}

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}-${String(d.getMinutes()).padStart(2, '0')}`;
}

function isoNow() {
  return new Date().toLocaleString('es-NI', { hour12: false });
}

// ─────────────────────────────────────────────
//  Render: monitoring cards
// ─────────────────────────────────────────────
function renderMonitoringGrid() {
  const root = document.getElementById('monitoringGrid');
  if (!root) return;
  root.innerHTML = metrics.map(m => `
    <div class="card metric-card" id="metric-${m.id}">
      <div class="metric-head">
        <div class="metric-title">${m.title}</div>
        <i data-lucide="${m.icon}"></i>
      </div>
      <div class="metric-body">
        <div>
          <div class="metric-value"><span class="num" data-metric="${m.id}">--</span><span class="metric-unit">${m.unit}</span></div>
          <div class="small muted">Actualizando…</div>
        </div>
        <div class="gauge-wrap" data-gauge="${m.id}">${makeGaugeSVG(0, m.max)}</div>
      </div>
    </div>
  `).join('');
}

function updateMetric(id, value) {
  const m = metrics.find(x => x.id === id);
  if (!m) return;

  // Store latest reading for datalogger
  latestReadings[id === 'energy' ? 'kwh' : id] = value;

  const num = document.querySelector(`[data-metric="${id}"]`);
  if (num) {
    const n = Number(value);
    if (Number.isFinite(n)) {
      num.textContent = id === 'energy' ? n.toFixed(3) : id === 'power' ? n.toFixed(0) : n.toFixed(2);
    } else {
      num.textContent = '--';
    }
  }
  const gauge = document.querySelector(`[data-gauge="${id}"]`);
  if (gauge) gauge.innerHTML = makeGaugeSVG(Number(value || 0), m.max);
  lucideRefresh();
  if (id === 'energy') syncDashboardChartInfo();
}

// ─────────────────────────────────────────────
//  Render: devices
// ─────────────────────────────────────────────
function renderDevices() {
  const root = document.getElementById('deviceGrid');
  if (!root) return;
  root.innerHTML = devices.map(d => {
    const name = devDisplayName(d.id);
    const icon = devDisplayIcon(d.id);
    const isOn = deviceStates[d.id] || false;
    return `
    <div class="card device-card ${isOn ? '' : 'inactive'}" id="device-${d.id}">
      <div class="device-head">
        <div class="device-icon"><i data-lucide="${icon}"></i></div>
        <label class="switch" title="Encender / apagar">
          <input type="checkbox" data-device-toggle="${d.id}" ${isOn ? 'checked' : ''} />
          <span class="slider"></span>
        </label>
      </div>
      <div class="device-body">
        <div class="device-name">${name}</div>
        <div class="small muted" data-device-state="${d.id}">${isOn ? 'Encendido' : 'Apagado'}</div>
      </div>
    </div>`;
  }).join('');
}

function setDeviceUI(id, isOn) {
  const input = document.querySelector(`[data-device-toggle="${id}"]`);
  if (input) input.checked = !!isOn;
  const label = document.querySelector(`[data-device-state="${id}"]`);
  if (label) label.textContent = isOn ? 'Encendido' : 'Apagado';
  const card = document.getElementById(`device-${id}`);
  if (card) card.classList.toggle('inactive', !isOn);
}

// ─────────────────────────────────────────────
//  Render: summary (costs)
// ─────────────────────────────────────────────
function renderSummary(consumptionKwh = null) {
  const kwh = Number.isFinite(Number(consumptionKwh)) ? Number(consumptionKwh) : 342.8;
  const cost = (kwh * costPerKwh).toLocaleString('en-US', { minimumFractionDigits: 2 });
  const root = document.getElementById('summaryGrid');
  if (!root) return;
  root.innerHTML = `
    <div class="card summary-card primary">
      <div class="watermark"><i data-lucide="gauge"></i></div>
      <div class="summary-head">
        <div class="summary-title"><i data-lucide="gauge"></i> Consumo Acumulado</div>
      </div>
      <div class="summary-body">
        <div class="summary-big">${kwh.toFixed(3)} <span style="font-size:1.25rem;font-weight:500;opacity:.85">kWh</span></div>
        <div class="summary-sub">Lectura del mes actual</div>
      </div>
    </div>
    <div class="card summary-card secondary">
      <div class="watermark"><i data-lucide="coins"></i></div>
      <div class="summary-head">
        <div class="summary-title"><i data-lucide="coins"></i> Costo Total Estimado</div>
      </div>
      <div class="summary-body">
        <div class="summary-big">C$ ${cost}</div>
        <div class="summary-sub">Tarifa: C$ ${costPerKwh.toFixed(2)}/kWh</div>
      </div>
    </div>
  `;
  lucideRefresh();
}

// ─────────────────────────────────────────────
//  Chart
// ─────────────────────────────────────────────
const MONTHS_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

function normalizeChartPayload(val) {
  const labels = [], data = [];
  if (!val) return { labels: MONTHS_ES.slice(0, 7), data: [186, 305, 237, 73, 209, 214, 342] };

  if (Array.isArray(val)) {
    if (val.length && typeof val[0] === 'number') {
      val.forEach((n, i) => { labels.push(MONTHS_ES[i] ?? `Mes ${i + 1}`); data.push(Number(n) || 0); });
      return { labels, data };
    }
    if (val.length && typeof val[0] === 'object') {
      val.forEach((o, i) => {
        labels.push(String(o.month ?? o.mes ?? MONTHS_ES[i] ?? `Mes ${i + 1}`));
        data.push(Number(o.consumption ?? o.kwh ?? o.value ?? o.valor ?? 0) || 0);
      });
      return { labels, data };
    }
  }

  if (typeof val === 'object') {
    const monthKeyCount = MONTHS_ES.filter(m => Object.prototype.hasOwnProperty.call(val, m)).length;
    if (monthKeyCount >= 2) {
      MONTHS_ES.forEach(m => {
        if (Object.prototype.hasOwnProperty.call(val, m)) {
          labels.push(m); data.push(Number(val[m]) || 0);
        }
      });
      return { labels, data };
    }
    Object.values(val).forEach((o, i) => {
      if (o && typeof o === 'object') {
        labels.push(String(o.month ?? o.mes ?? MONTHS_ES[i] ?? `Mes ${i + 1}`));
        data.push(Number(o.consumption ?? o.kwh ?? o.value ?? o.valor ?? 0) || 0);
      }
    });
    if (labels.length) return { labels, data };
  }

  return { labels: MONTHS_ES.slice(0, 7), data: [186, 305, 237, 73, 209, 214, 342] };
}

function chartColors() {
  const isDark = document.documentElement.classList.contains('dark');
  const text = isDark ? 'rgba(195,210,230,0.68)' : 'rgba(30,40,60,0.58)';
  const grid = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
  return { isDark, text, grid };
}

// Gradient fill for bars: blue → violet (same as charts.js)
function makeBarGradient(ctx, chartArea, isDark) {
  const grad = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  grad.addColorStop(0, '#3b82f6');
  grad.addColorStop(1, isDark ? '#7c3aed' : '#8b5cf6');
  return grad;
}

function initOrUpdateChart(labels, data) {
  const canvas = document.getElementById('consumptionChart');
  if (!canvas || !window.Chart) return;
  const { isDark, text, grid } = chartColors();

  if (window.__piEnergyChart) {
    window.__piEnergyChart.data.labels = labels;
    window.__piEnergyChart.data.datasets[0].data = data;
    // Update theme colors as well
    window.__piEnergyChart.data.datasets[0].backgroundColor = ctx => {
      const chart = ctx.chart;
      const { ctx: c2, chartArea } = chart;
      if (!chartArea) return '#3b82f6';
      return makeBarGradient(c2, chartArea, isDark);
    };
    window.__piEnergyChart.update('none');
    return;
  }

  window.__piEnergyChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Consumo (kWh)',
        data,
        backgroundColor: ctx => {
          const chart = ctx.chart;
          const { ctx: c2, chartArea } = chart;
          if (!chartArea) return '#3b82f6';
          return makeBarGradient(c2, chartArea, isDark);
        },
        borderRadius: { topLeft: 8, topRight: 8, bottomLeft: 0, bottomRight: 0 },
        borderSkipped: false,
        hoverBackgroundColor: '#8b5cf6',
        barPercentage: 0.68,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 700, easing: 'easeOutQuart' },
      events: ['mousemove', 'mouseout', 'touchstart', 'touchmove'],
      onHover: (event, elements) => {
        const infoBar = document.getElementById('dashChartInfoBar');
        if (!infoBar) return;
        if (elements && elements.length) {
          const idx = elements[0].index;
          const chart = window.__piEnergyChart;
          if (!chart) return;
          const label = chart.data.labels[idx] || '';
          const kwh = chart.data.datasets[0].data[idx] || 0;
          updateChartInfoBar(label, kwh, window.__lastMonthlyMap, true);
          infoBar.classList.add('has-hover');
        } else {
          infoBar.classList.remove('has-hover');
          syncDashboardChartInfo();
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: isDark ? 'rgba(6,10,24,0.92)' : 'rgba(15,20,40,0.88)',
          titleColor: '#fff',
          bodyColor: 'rgba(210,220,240,0.85)',
          padding: { x: 14, y: 12 },
          cornerRadius: 12,
          displayColors: false,
          callbacks: {
            label: ctx => {
              const v = ctx.raw || 0;
              return [`  ${v.toFixed(2)} kWh`, `  C$ ${(v * costPerKwh).toFixed(2)}`];
            }
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: { color: text, font: { size: 11, family: 'Inter, sans-serif' }, maxTicksLimit: 14 },
        },
        y: {
          grid: { color: grid, drawBorder: false },
          border: { display: false },
          ticks: { color: text, font: { size: 11, family: 'Inter, sans-serif' }, callback: v => `${v} kWh` },
          beginAtZero: true,
        },
      },
    },
  });
}

function rebuildChartForTheme() {
  if (window.__piEnergyChart) {
    window.__piEnergyChart.destroy();
    window.__piEnergyChart = null;
  }
  const { labels, data } = normalizeChartPayload(window.__lastChartPayload);
  initOrUpdateChart(labels, data);
  if (window.__lastMonthlyMap) renderInsights(window.__lastMonthlyMap);
}

// ─────────────────────────────────────────────
//  Always-visible Chart Info Bar
// ─────────────────────────────────────────────
function updateChartInfoBar(label, kwh, map, isHover) {
  const bar = document.getElementById('dashChartInfoBar');
  if (!bar) return;

  const kwhNum = Number(kwh);
  const cost = (Number.isFinite(kwhNum) ? kwhNum : 0) * costPerKwh;

  // Find prev month kWh for delta
  let deltaKwh = null, deltaPct = null, deltaCost = null;
  if (map) {
    const keys = Object.keys(map).filter(k => /^\d{4}-\d{2}$/.test(k)).sort();
    let idx = keys.findIndex(k => monthLabel(k) === label);
    if (idx < 0) {
      const ck = monthKey();
      idx = keys.indexOf(ck);
    }
    if (idx > 0) {
      const prevKwh = parseFloat(map[keys[idx - 1]]) || 0;
      if (prevKwh > 0) {
        deltaKwh = kwhNum - prevKwh;
        deltaPct = (deltaKwh / prevKwh * 100);
        deltaCost = deltaKwh * costPerKwh;
      }
    }
  }

  const up = deltaKwh !== null && deltaKwh > 0;
  const sign = deltaKwh !== null ? (up ? '▲' : '▼') : '';
  const cls = deltaKwh === null ? 'neutral' : (up ? 'up' : 'down');
  const pctStr = deltaPct !== null ? `${sign} ${Math.abs(deltaPct).toFixed(1)}%` : '—';
  const diffStr = deltaCost !== null ? `${sign} C$ ${Math.abs(deltaCost).toFixed(2)}` : '—';

  const showKwh = Number.isFinite(kwhNum) && kwhNum >= 0;
  const kwhStr = showKwh ? `${kwhNum.toFixed(2)} kWh` : '—';
  const costStr = showKwh ? `C$ ${cost.toFixed(2)}` : '—';

  bar.innerHTML = `
    <div class="chart-info-item">
      <span class="chart-info-label">Período</span>
      <span class="chart-info-value">${label || '—'}</span>
    </div>
    <div class="chart-info-sep"></div>
    <div class="chart-info-item">
      <span class="chart-info-label">Consumo</span>
      <span class="chart-info-value blue" id="dashChartInfoKwh">${kwhStr}</span>
    </div>
    <div class="chart-info-sep"></div>
    <div class="chart-info-item">
      <span class="chart-info-label">Costo estimado</span>
      <span class="chart-info-value violet" id="dashChartInfoCost">${costStr}</span>
    </div>
    <div class="chart-info-sep"></div>
    <div class="chart-info-item">
      <span class="chart-info-label">vs mes anterior</span>
      <span class="chart-info-value">
        <span class="chart-info-delta ${cls}">${pctStr}</span>
      </span>
      <span class="chart-info-delta ${cls}" style="width:fit-content;margin-top:.2rem">${diffStr}</span>
    </div>
  `;
}

/** Mes actual: consumo en vivo = kWh medidor − snapshot monthStart (igual que en RTDB). */
function syncDashboardChartInfo() {
  const bar = document.getElementById('dashChartInfoBar');
  if (!bar || bar.classList.contains('has-hover')) return;
  const mk = monthKey();
  const label = monthLabel(mk);
  const map = window.__lastMonthlyMap;
  const curK = Number(latestReadings.kwh);
  let consumed = NaN;
  const startK = Number(monthStartCache[mk]);
  if (Number.isFinite(curK) && Number.isFinite(startK)) {
    consumed = Math.max(0, curK - startK);
  } else if (map && map[mk] != null && map[mk] !== '') {
    consumed = parseFloat(map[mk]) || 0;
  } else if (Number.isFinite(curK)) {
    consumed = 0;
  }
  if (!Number.isFinite(consumed)) return;
  updateChartInfoBar(label, consumed, map || {}, false);
}

// ─────────────────────────────────────────────
//  Insights (mirrors charts.js – with C$ amounts)
// ─────────────────────────────────────────────
function generateInsights(map) {
  const chips = [];
  const keys = Object.keys(map).filter(k => /^\d{4}-\d{2}$/.test(k)).sort();
  if (keys.length < 2) return chips;

  const cur = parseFloat(map[keys[keys.length - 1]]) || 0;
  const prev = parseFloat(map[keys[keys.length - 2]]) || 0;
  const avg = keys.reduce((s, k) => s + (parseFloat(map[k]) || 0), 0) / keys.length;

  if (prev > 0) {
    const pct = ((cur - prev) / prev * 100).toFixed(1);
    const diffKwh = (cur - prev).toFixed(2);
    const diffCost = ((cur - prev) * costPerKwh).toFixed(2);
    const up = cur > prev;
    chips.push({
      icon: up ? 'trending-up' : 'trending-down',
      color: up ? 'danger' : 'success',
      text: `${up ? '▲' : '▼'} ${Math.abs(pct)}% (${up ? '+' : ''}${diffKwh} kWh · C$ ${up ? '+' : '-'}${Math.abs(Number(diffCost)).toFixed(2)}) vs mes anterior`,
    });
  }
  if (keys.length >= 3 && avg > 0) {
    const pct = ((cur - avg) / avg * 100).toFixed(1);
    const up = cur > avg;
    chips.push({
      icon: up ? 'flame' : 'leaf',
      color: up ? 'warn' : 'success',
      text: `${Math.abs(pct)}% ${up ? 'sobre' : 'bajo'} el promedio histórico (C$ ${(avg * costPerKwh).toFixed(2)}/mes)`,
    });
  }
  if (keys.length >= 3) {
    const last3 = keys.slice(-3).map(k => parseFloat(map[k]) || 0);
    if (last3[2] > last3[1] && last3[1] > last3[0])
      chips.push({ icon: 'alert-triangle', color: 'warn', text: 'Tendencia creciente 3 meses consecutivos' });
  }
  return chips.slice(0, 3);
}

function renderInsights(map) {
  const row = document.getElementById('dashInsightsRow');
  window.__lastMonthlyMap = map;

  syncDashboardChartInfo();

  if (!row) return;
  const chips = generateInsights(map);
  if (!chips.length) { row.style.display = 'none'; return; }
  row.style.display = '';
  row.innerHTML = chips.map(c => `
    <div class="insight-chip insight-${c.color}" role="status">
      <i data-lucide="${c.icon}"></i><span>${c.text}</span>
    </div>`).join('');
  lucideRefresh();
}

// ─────────────────────────────────────────────
//  Monthly chart auto-calculation
// ─────────────────────────────────────────────
// Firebase structure:
//   UsersData/{uid}/monthly/{YYYY-MM}      → kWh consumed that month (number)
//   UsersData/{uid}/monthStart/{YYYY-MM}   → kWh snapshot at month start
//   UsersData/{uid}/telemetry/*            → live readings from ESP32 (see firebase-paths.js)

async function trackAndWriteMonthlyConsumption(userUid) {
  const curMonth = monthKey();
  const curKwh = Number(latestReadings.kwh);
  if (!Number.isFinite(curKwh) || curKwh <= 0) return;

  const startRef = ref(db, monthStart(userUid, curMonth));

  // 1. Get or create this month's start snapshot
  let startKwh;
  try {
    const snap = await get(startRef);
    if (snap.exists() && Number.isFinite(Number(snap.val()))) {
      startKwh = Number(snap.val());
    } else {
      // First time this month: store current kWh as baseline
      startKwh = curKwh;
      await set(startRef, startKwh);
    }
  } catch { return; }

  // 2. Calculate and write this month's running consumption
  const consumed = Math.max(0, curKwh - startKwh);
  set(ref(db, monthlyMonth(userUid, curMonth)), parseFloat(consumed.toFixed(3))).catch(console.error);
}

function normalizeMonthlySnap(val) {
  // val: { '2026-01': 186.5, '2026-02': 305.2, '2026-03': 45.0 }
  if (!val || typeof val !== 'object') return null;
  const keys = Object.keys(val).filter(k => /^\d{4}-\d{2}$/.test(k));
  if (!keys.length) return null;
  keys.sort();
  const labels = keys.map(monthLabel);
  const data = keys.map(k => parseFloat(val[k]) || 0);
  return { labels, data };
}

function subscribeMonthlyChart(userUid) {
  if (monthlyUnsub) { monthlyUnsub(); monthlyUnsub = null; }

  monthlyUnsub = onValue(ref(db, monthlyRoot(userUid)), snap => {
    const val = snap.val();
    const parsed = normalizeMonthlySnap(val);
    if (parsed) {
      window.__lastChartPayload = val;
      initOrUpdateChart(parsed.labels, parsed.data);
      if (val) renderInsights(val);
    } else {
      // Fallback: try legacy 'charts' node once
      get(ref(db, chartsPath(userUid))).then(s => {
        const { labels, data } = normalizeChartPayload(s.val());
        window.__lastChartPayload = s.val();
        initOrUpdateChart(labels, data);
      }).catch(() => { });
    }
  });
}


function drawLogs(logs) {
  const container = document.getElementById('logBody');
  if (!container) return;

  if (!logs || !logs.length) {
    container.innerHTML = `
      <div class="log-empty">
        <i data-lucide="database"></i>
        <p>Sin registros aún.<br><span class="small muted">Los datos aparecerán al intervalo configurado.</span></p>
      </div>`;
    lucideRefresh();
    return;
  }

  container.innerHTML = logs.map((l, i) => {
    const isWarn = l.status === 'warning';
    const isOffline = l.status === 'offline';
    const isFirst = i === 0;
    const badgeCls = isWarn ? 'log-badge-warn' : isOffline ? 'log-badge-offline' : 'log-badge-ok';
    const badgeTxt = isWarn ? 'Alerta' : isOffline ? 'Apagado' : 'Operativo';
    const dotCls = isWarn ? 'log-dot-warn' : isOffline ? 'log-dot-offline' : '';
    const rowCls = isFirst ? 'log-row log-row-latest' : 'log-row';
    return `
      <div class="${rowCls}">
        <div class="log-row-left">
          <span class="log-dot ${dotCls}"></span>
          <div class="log-row-meta">
            <span class="log-time">${l.timestamp}</span>
            ${isFirst ? '<span class="log-badge-new">Más reciente</span>' : ''}
          </div>
        </div>
        <div class="log-metrics">
          <div class="log-metric">
            <span class="log-metric-label">Voltaje</span>
            <span class="log-metric-value">${l.voltage}</span>
          </div>
          <div class="log-metric">
            <span class="log-metric-label">Corriente</span>
            <span class="log-metric-value">${l.current}</span>
          </div>
          <div class="log-metric">
            <span class="log-metric-label">Potencia</span>
            <span class="log-metric-value">${l.power}</span>
          </div>
        </div>
        <span class="log-status ${badgeCls}">${badgeTxt}</span>
      </div>`;
  }).join('');
  lucideRefresh();
}

function normalizeReading(r, key = '') {
  const v = Number(r?.voltaje ?? r?.voltage ?? r?.V ?? r?.v);
  const a = Number(r?.corriente ?? r?.current ?? r?.A ?? r?.a);
  const w = Number(r?.potencia ?? r?.power ?? r?.W ?? r?.w);

  // Timestamp: try stored datetime string, then key, then now
  let ts = r?.datetime ?? r?.timestamp ?? r?.ts ?? '';
  if (!ts || ts === key) ts = isoNow();

  let status = 'normal';
  if ((Number.isFinite(v) && v === 0) && (Number.isFinite(a) && a === 0)) {
    status = 'offline';
  } else if ((Number.isFinite(v) && (v < 90 || v > 150)) || (Number.isFinite(a) && a > 80) || (Number.isFinite(w) && w > 4500)) {
    status = 'warning';
  }

  return {
    id: key || Math.random().toString(36).slice(2, 11),
    timestamp: String(ts).slice(0, 19),  // show HH:MM:SS
    voltage: Number.isFinite(v) ? `${v.toFixed(2)} V` : '--',
    current: Number.isFinite(a) ? `${a.toFixed(2)} A` : '--',
    power: Number.isFinite(w) ? `${w.toFixed(0)} W` : '--',
    status,
  };
}

// ─────────────────────────────────────────────
//  15-minute Datalogger
// ─────────────────────────────────────────────
function buildDatalogEntry() {
  const { voltage, current, power, kwh } = latestReadings;
  return {
    datetime: isoNow(),
    voltaje: Number(voltage) || 0,
    corriente: Number(current) || 0,
    potencia: Number(power) || 0,
    kwh: Number(kwh) || 0,
  };
}

function writeDatalogEntry(userUid) {
  const dayKey = todayKey();
  const timeKey = nowHHMM();
  const entry = buildDatalogEntry();
  set(ref(db, datalogEntry(userUid, dayKey, timeKey)), entry).catch(console.error);
}

function forceVisualLogUpdate() {
  const v = Number(latestReadings.voltage);
  const a = Number(latestReadings.current);
  const w = Number(latestReadings.power);

  const entry = normalizeReading({
    voltaje: v,
    corriente: a,
    potencia: w,
    datetime: isoNow(),
  });
  window.__logs = [entry, ...(window.__logs || [])].slice(0, LIVE_LOG_MAX);
  drawLogs(window.__logs);
}

function startDatalogTimer(userUid) {
  stopDatalogTimer();

  const intervalMs = Math.max(1000, Number(displayIntervalMs) || (15 * 60 * 1000));

  // Imprimir medición inmediatamente en pantalla y en BD
  writeDatalogEntry(userUid);
  forceVisualLogUpdate();

  datalogTimer = setInterval(() => {
    writeDatalogEntry(userUid);
    forceVisualLogUpdate();
  }, intervalMs);
}

function stopDatalogTimer() {
  if (datalogTimer) { clearInterval(datalogTimer); datalogTimer = null; }
}

// ─────────────────────────────────────────────
//  In-memory live log buffer (last 20 readings)
// ─────────────────────────────────────────────
const LIVE_LOG_MAX = 20;

// ─────────────────────────────────────────────
//  Pre-load last 20 entries from Firebase datalog
// ─────────────────────────────────────────────
async function loadDatalogFromFirebase(userUid) {
  try {
    // Build list of day keys to check (today + last 6 days)
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }

    // Fetch each day in parallel (stop early once we have 20)
    const allEntries = [];
    for (const day of days) {
      if (allEntries.length >= LIVE_LOG_MAX) break;
      const snap = await get(ref(db, datalogDay(userUid, day)));
      if (!snap.exists()) continue;
      const dayData = snap.val();
      // Each key is 'HH-MM', sort descending
      const timeKeys = Object.keys(dayData).sort().reverse();
      for (const tk of timeKeys) {
        const raw = dayData[tk];
        if (!raw) continue;
        allEntries.push(normalizeReading({
          voltaje: raw.voltaje ?? raw.voltage ?? 0,
          corriente: raw.corriente ?? raw.current ?? 0,
          potencia: raw.potencia ?? raw.power ?? 0,
          datetime: raw.datetime ?? `${day} ${tk.replace('-', ':')}`,
        }, tk));
        if (allEntries.length >= LIVE_LOG_MAX) break;
      }
    }

    if (allEntries.length) {
      window.__logs = allEntries;
      drawLogs(window.__logs);
      // Seed lastLoggedAt so pushLiveEntry won't immediately duplicate
      lastLoggedAt = Date.now();
    }
  } catch (err) {
    console.warn('loadDatalogFromFirebase:', err);
  }
}

// ─────────────────────────────────────────────
//  Stop / start Firebase bindings
// ─────────────────────────────────────────────
function stopFirebaseBindings() {
  dbUnsubs.forEach(fn => { try { fn(); } catch { /* ignore */ } });
  dbUnsubs = [];
  if (monthlyUnsub) { monthlyUnsub(); monthlyUnsub = null; }
  monthStartCache = {};
}


function stopDemo() {
  demoTimers.forEach(t => clearInterval(t));
  demoTimers = [];
  demoMode = false;
  setDeviceUI('local_demo', false);
}

function startDemo() {
  stopFirebaseBindings();
  stopDemo();
  stopDatalogTimer();
  demoMode = true;
  setSystemStatus('Demo (sin Firebase)');
  setDeviceUI('local_demo', true);
  monthStartCache = { [monthKey()]: 340 };

  demoTimers.push(setInterval(() => {
    const v = 118 + Math.random() * 4;
    const a = 10 + Math.random() * 10;
    const w = 1500 + Math.random() * 500;
    const k = 340 + Math.random() * 10;
    updateMetric('voltage', v);
    updateMetric('current', a);
    updateMetric('power', w);
    updateMetric('energy', k);
    renderSummary(k);
  }, 2500));

  const demoChart = { Enero: 186, Febrero: 305, Marzo: 237, Abril: 73, Mayo: 209, Junio: 214, Julio: 342 };
  window.__lastChartPayload = demoChart;
  const { labels, data } = normalizeChartPayload(demoChart);
  initOrUpdateChart(labels, data);

  // Demo logs every 30 s
  demoTimers.push(setInterval(() => {
    const entry = normalizeReading({
      voltaje: 118 + Math.random() * 4,
      corriente: 10 + Math.random() * 10,
      potencia: 1500 + Math.random() * 500,
      datetime: isoNow(),
    });
    const prev = window.__logs || [];
    window.__logs = [entry, ...prev].slice(0, 20);
    drawLogs(window.__logs);
  }, 30000));
}

function startFirebaseBindingsForUser(userUid) {
  stopDemo();
  stopFirebaseBindings();
  stopDatalogTimer();

  setSystemStatus('Conectando…');

  // Live metrics – table updates on every ESP32 reading (paths: telemetry/*)
  dbUnsubs.push(onValue(ref(db, telemetryField(userUid, 'voltaje')), s => {
    setSystemStatus('Conectado y Operativo');
    updateMetric('voltage', s.val());
  }));
  dbUnsubs.push(onValue(ref(db, telemetryField(userUid, 'corriente')), s => updateMetric('current', s.val())));
  dbUnsubs.push(onValue(ref(db, telemetryField(userUid, 'potencia')), s => updateMetric('power', s.val())));
  dbUnsubs.push(onValue(ref(db, telemetryField(userUid, 'kwh')), s => {
    updateMetric('energy', s.val());
    renderSummary(s.val());
    // After each kWh update, refresh this month's consumption figure
    trackAndWriteMonthlyConsumption(userUid).catch(console.error);
  }));

  dbUnsubs.push(onValue(ref(db, monthStartRoot(userUid)), s => {
    const v = s.val();
    monthStartCache = v && typeof v === 'object' ? { ...v } : {};
    syncDashboardChartInfo();
  }));

  // Device toggles – read from Firebase
  dbUnsubs.push(onValue(ref(db, deviceOutput(userUid, 'led')), s => { deviceStates['led'] = !!s.val(); setDeviceUI('led', deviceStates['led']); }));
  dbUnsubs.push(onValue(ref(db, deviceOutput(userUid, 'led1')), s => { deviceStates['led1'] = !!s.val(); setDeviceUI('led1', deviceStates['led1']); }));
  dbUnsubs.push(onValue(ref(db, deviceOutput(userUid, 'led2')), s => { deviceStates['led2'] = !!s.val(); setDeviceUI('led2', deviceStates['led2']); }));
  dbUnsubs.push(onValue(ref(db, deviceOutput(userUid, 'led3')), s => { deviceStates['led3'] = !!s.val(); setDeviceUI('led3', deviceStates['led3']); }));

  // Dynamic names and icons from devices.html edits
  dbUnsubs.push(onValue(ref(db, deviceNamesRoot(userUid)), s => {
    const v = s.val() || {};
    dynamicDeviceNames = v;
    renderDevices();
    wireDeviceWrites();
  }));
  dbUnsubs.push(onValue(ref(db, deviceIconsRoot(userUid)), s => {
    const v = s.val() || {};
    dynamicDeviceIcons = v;
    renderDevices();
    wireDeviceWrites();
  }));

  // Limit slider
  const cfgLimit = document.getElementById('cfgLimit');
  dbUnsubs.push(onValue(ref(db, configureField(userUid, 'limitKwh')), s => {
    const v = Number(s.val());
    if (Number.isFinite(v)) {
      if (cfgLimit && document.activeElement !== cfgLimit) cfgLimit.value = String(v);
    }
  }));

  // 15-min datalogger (writes to Firebase)
  startDatalogTimer(userUid);
  // Pre-load history from Firebase immediately
  loadDatalogFromFirebase(userUid);

  // Tarifa from Firebase (optional node)
  dbUnsubs.push(onValue(ref(db, configureField(userUid, 'tarifa')), s => {
    const v = Number(s.val());
    if (Number.isFinite(v) && v > 0) {
      costPerKwh = v;
      localStorage.setItem('costPerKwh', String(v));
      renderSummary(latestReadings.kwh);
      syncDashboardChartInfo();
    }
  }));

  // ccalibrate / vcalibrate from Firebase
  dbUnsubs.push(onValue(ref(db, configureField(userUid, 'ccalibrate')), s => {
    const v = Number(s.val());
    if (Number.isFinite(v) && v > 0) {
      ccalibrate = v;
      localStorage.setItem('ccalibrate', String(v));
      const el = document.getElementById('cfgCcal');
      if (el && document.activeElement !== el) el.value = v;
    }
  }));
  dbUnsubs.push(onValue(ref(db, configureField(userUid, 'vcalibrate')), s => {
    const v = Number(s.val());
    if (Number.isFinite(v) && v > 0) {
      vcalibrate = v;
      localStorage.setItem('vcalibrate', String(v));
      const el = document.getElementById('cfgVcal');
      if (el && document.activeElement !== el) el.value = v;
    }
  }));
  dbUnsubs.push(onValue(ref(db, configureField(userUid, 'wmeter')), s => {
    const v = Number(s.val());
    if (Number.isFinite(v) && v > 0) {
      wmeter = v;
      localStorage.setItem('wmeter', String(v));
    }
  }));

  dbUnsubs.push(onValue(ref(db, configureField(userUid, 'dataloggerMinutes')), s => {
    const mins = Number(s.val());
    if (Number.isFinite(mins) && mins > 0) {
      displayIntervalMs = Math.round(mins * 60 * 1000);
      localStorage.setItem('displayIntervalMs', String(displayIntervalMs));
      refreshDataloggerCopy();
      if (uid) startDatalogTimer(uid);
    }
  }));

  // Monthly chart – auto-calculated from cumulative kWh
  subscribeMonthlyChart(userUid);

  // Device write handlers
  wireDeviceWrites();
}

function wireDeviceWrites() {
  document.querySelectorAll('[data-device-toggle]').forEach(input => {
    const clone = input.cloneNode(true);
    input.parentNode.replaceChild(clone, input);
  });

  document.querySelectorAll('[data-device-toggle]').forEach(input => {
    input.addEventListener('change', () => {
      const id = input.getAttribute('data-device-toggle');
      const isOn = input.checked;
      if (!uid) { setDeviceUI(id, isOn); return; }
      const paths = {
        led: deviceOutput(uid, 'led'),
        led1: deviceOutput(uid, 'led1'),
        led2: deviceOutput(uid, 'led2'),
        led3: deviceOutput(uid, 'led3'),
      };
      if (paths[id]) {
        import("https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js").then(({ set, push, ref }) => {
          set(ref(db, paths[id]), isOn ? 1 : 0);
          const entry = {
            ts: new Date().toLocaleString('es-NI', { hour12: false }),
            action: isOn ? 'on' : 'off',
            trigger: 'manual',
            details: isOn ? 'Encendido desde Dashboard' : 'Apagado desde Dashboard'
          };
          push(ref(db, deviceHistory(uid, id)), entry).catch(console.error);
        });
      }
    });
  });
}

// ─────────────────────────────────────────────
//  Quick Actions
// ─────────────────────────────────────────────
function downloadCSV() {
  const logs = window.__logs || [];
  if (!logs.length) { alert('No hay datos registrados para exportar.'); return; }
  const header = 'Fecha/Hora,Voltaje,Corriente,Potencia,Estado';
  const rows = logs.map(l => `"${l.timestamp}","${l.voltage}","${l.current}","${l.power}","${l.status === 'warning' ? 'Alerta' : 'Operativo'}"`);
  const csv = [header, ...rows].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `espower-reporte-${todayKey()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// Tarifa modal
function openTarifaModal() {
  const modal = document.getElementById('tarifaModal');
  const input = document.getElementById('tarifaInput');
  if (input) input.value = costPerKwh.toFixed(2);
  const msg = document.getElementById('tarifaMsg');
  if (msg) msg.textContent = '';
  modal?.classList.remove('hidden');
  lucideRefresh();
}
function closeTarifaModal() { document.getElementById('tarifaModal')?.classList.add('hidden'); }

function saveTarifa() {
  const val = parseFloat(document.getElementById('tarifaInput')?.value);
  if (!Number.isFinite(val) || val <= 0) {
    const msg = document.getElementById('tarifaMsg');
    if (msg) { msg.textContent = 'Ingresá un valor válido mayor a 0.'; msg.style.color = '#ef4444'; }
    return;
  }
  costPerKwh = val;
  localStorage.setItem('costPerKwh', String(val));
  renderSummary(latestReadings.kwh);
  syncDashboardChartInfo();

  // Write to Firebase if logged in
  if (uid) set(ref(db, configureField(uid, 'tarifa')), val).catch(console.error);

  const msg = document.getElementById('tarifaMsg');
  if (msg) { msg.textContent = '✓ Tarifa guardada correctamente.'; msg.style.color = '#22c55e'; }
  setTimeout(closeTarifaModal, 800);
}

// Calendar modal
async function openCalModal() {
  const modal = document.getElementById('calModal');
  const grid = document.getElementById('calGrid');
  modal?.classList.remove('hidden');
  lucideRefresh();
  if (!grid) return;
  grid.innerHTML = '<span class="small muted">Cargando…</span>';

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let activeDays = new Set();

  if (uid) {
    // Query all day keys for this month
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
    try {
      const snap = await get(ref(db, datalogRoot(uid)));
      if (snap.exists()) {
        snap.forEach(child => {
          if (child.key.startsWith(prefix)) activeDays.add(parseInt(child.key.slice(8, 10), 10));
        });
      }
    } catch { /* ignore */ }
  } else if (demoMode) {
    // fake some days
    [1, 3, 5, 8, 10, 15, 16, 22].forEach(d => activeDays.add(d));
  }

  const DAYS = ['Do', 'Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá'];
  const firstDay = new Date(year, month, 1).getDay();
  const mName = new Date(year, month, 1).toLocaleString('es', { month: 'long' });
  const today = now.getDate();

  let html = `<div style="width:100%">
    <div style="text-align:center;font-weight:700;font-size:.95rem;margin-bottom:.75rem;text-transform:capitalize">${mName} ${year}</div>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;text-align:center">
      ${DAYS.map(d => `<div style="font-size:.7rem;font-weight:600;opacity:.55;padding:.3rem 0">${d}</div>`).join('')}
      ${Array.from({ length: firstDay }, () => '<div></div>').join('')}`;

  for (let d = 1; d <= daysInMonth; d++) {
    const active = activeDays.has(d);
    const isToday = d === today;
    const bg = isToday ? 'var(--primary)' : active ? 'color-mix(in oklab, var(--primary) 18%, transparent)' : 'transparent';
    const col = isToday ? 'var(--primary-foreground)' : 'inherit';
    const dot = active && !isToday ? `<div style="width:5px;height:5px;border-radius:50%;background:var(--primary);margin:.1rem auto 0"></div>` : '';
    html += `<div style="border-radius:.65rem;padding:.4rem .2rem;background:${bg};color:${col};font-size:.82rem;font-weight:${isToday ? 700 : 400}">
      ${d}${dot}</div>`;
  }
  html += `</div></div>`;
  grid.innerHTML = html;
}
function closeCalModal() { document.getElementById('calModal')?.classList.add('hidden'); }

function initSidebar() {
  const shell = document.getElementById('appShell');
  const openBtn = document.getElementById('sidebarToggle');
  const closeBtn = document.getElementById('sidebarClose');
  const backdrop = document.getElementById('sidebarBackdrop');
  const links = document.querySelectorAll('.sidebar-link');

  function closeSidebar() { shell?.classList.remove('sidebar-open'); }
  function openSidebar() { shell?.classList.add('sidebar-open'); }

  openBtn?.addEventListener('click', openSidebar);
  closeBtn?.addEventListener('click', closeSidebar);
  backdrop?.addEventListener('click', closeSidebar);
  links.forEach(link => link.addEventListener('click', () => {
    links.forEach(item => item.classList.remove('is-active'));
    link.classList.add('is-active');
    closeSidebar();
  }));
  if (links[0]) links[0].classList.add('is-active');

  window.addEventListener('resize', () => {
    if (window.innerWidth >= 900) closeSidebar();
  });
}

function initLoginOverlay() {
  const form = document.getElementById('overlayLoginForm');
  const btn = document.getElementById('overlayLoginBtn');
  const emailInput = document.getElementById('overlayEmail');
  const passwordInput = document.getElementById('overlayPassword');

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = emailInput?.value?.trim() || '';
    const password = passwordInput?.value || '';

    if (!email || !password) {
      showLoginError('Ingresá tu correo y contraseña.');
      return;
    }

    showLoginError('');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>Verificando…</span>';
    }

    try {
      await signInWithEmailAndPassword(auth, email, password);
      form.reset();
      setAppLocked(false);
    } catch (error) {
      showLoginError(humanizeAuthError(error));
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="log-in"></i>Iniciar sesión';
        lucideRefresh();
      }
    }
  });
}

// Wire quick actions
function initQuickActions() {
  document.getElementById('btnDownload')?.addEventListener('click', downloadCSV);
  document.getElementById('btnCal')?.addEventListener('click', openCalModal);
  document.getElementById('tarifaSaveBtn')?.addEventListener('click', saveTarifa);

  document.querySelectorAll('[data-close-tarifa]').forEach(el => el.addEventListener('click', closeTarifaModal));
  document.querySelectorAll('[data-close-cal]').forEach(el => el.addEventListener('click', closeCalModal));
}

// ─────────────────────────────────────────────
//  Theme
// ─────────────────────────────────────────────
function initThemeToggle() {
  window.addEventListener('themeChanged', rebuildChartForTheme);
}

// ─────────────────────────────────────────────
//  Auth UI
// ─────────────────────────────────────────────
function initAuthUI() {
  const authBtn = document.getElementById('authBtn');

  if (authBtn) authBtn.disabled = true;

  authBtn?.addEventListener('click', async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error(error);
    }
  });

  onAuthStateChanged(auth, (user) => {
    if (user) {
      uid = user.uid;
      demoMode = false;
      setAppLocked(false);
      showLoginError('');
      if (authBtn) authBtn.disabled = false;
      setSidebarIdentity(user.email || 'Sesión iniciada');
      startFirebaseBindingsForUser(uid);
      setDeviceUI('local_demo', false);
    } else {
      uid = null;
      stopFirebaseBindings();
      stopDatalogTimer();
      setAppLocked(true);
      if (authBtn) authBtn.disabled = true;
      setSystemStatus('Esperando autenticación');
      setSidebarIdentity('Sin autenticar');
      renderSummary();
      window.__logs = [];
      drawLogs([]);
    }
    lucideRefresh();
  });
}

// ─────────────────────────────────────────────
//  Boot
// ─────────────────────────────────────────────
function boot() {
  renderMonitoringGrid();
  renderDevices();
  renderSummary();
  lucideRefresh();

  // Default chart placeholder
  const demoChart = { Enero: 186, Febrero: 305, Marzo: 237, Abril: 73, Mayo: 209, Junio: 214, Julio: 342 };
  window.__lastChartPayload = demoChart;
  const { labels, data } = normalizeChartPayload(demoChart);
  initOrUpdateChart(labels, data);

  // Default empty logs
  window.__logs = [];
  drawLogs([]);

  // Default devices
  setDeviceUI('led', false);
  setDeviceUI('led1', false);
  setDeviceUI('led2', false);
  setDeviceUI('local_demo', false);

  wireDeviceWrites();
  initThemeToggle();
  initSidebar();
  initQuickActions();
  initLoginOverlay();
  initAuthUI();
  refreshDataloggerCopy();

  if (isDemo) setTimeout(startDemo, 500);
}

document.addEventListener('DOMContentLoaded', boot);

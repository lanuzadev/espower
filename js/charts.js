/* ESPower – charts.js  v2  (Vanilla JS + Firebase RTDB) */

import "./background.js";
import { auth, db } from "./firebase-config.js";
import { monthlyRoot, datalogRoot, configurePath } from "./firebase-paths.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { ref, get, onValue } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";


// ─────────────────────────────────────────────
//  State
// ─────────────────────────────────────────────
let uid           = null;
let costPerKwh    = parseFloat(localStorage.getItem('costPerKwh') || '6.85');
let activeRange   = 'month';
let monthlyData   = {};
let dailyData     = {};
let dailyDataHourly = {};
let chartInst     = null;
let donutInst     = null;

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────
const MONTHS_ES   = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
const MONTHS_FULL = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function lucideRefresh() { if (window.lucide) window.lucide.createIcons(); }
function setSidebarIdentity(email = '') {
  const el = document.getElementById('sidebarUserEmail');
  if (el) el.textContent = email || 'Sin autenticar';
}
function setSystemStatus(text) {
  ['systemStatusText','topbarStatusText'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  });
}
function fmtKwh(n)  { return `${Number(n).toFixed(2)} kWh`; }
function fmtCost(n) { return `C$ ${(n * costPerKwh).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`; }

function monthLabel(key) {
  const [,m] = key.split('-');
  return `${MONTHS_ES[parseInt(m,10)-1]} ${key.split('-')[0].slice(2)}`;
}
function todayDate()    { return new Date(); }
function addDays(d, n)  { const r = new Date(d); r.setDate(r.getDate()+n); return r; }
function yyyymmdd(d)    { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function yyyymm(d)      { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }

// ─────────────────────────────────────────────
//  Premium color palette  (donut slices)
// ─────────────────────────────────────────────
const DONUT_PALETTE = [
  '#3b82f6','#8b5cf6','#06b6d4','#10b981','#f59e0b',
  '#ef4444','#ec4899','#6366f1','#14b8a6','#f97316',
];

// ─────────────────────────────────────────────
//  Chart theme colors
// ─────────────────────────────────────────────
function chartColors() {
  const isDark  = document.documentElement.classList.contains('dark');
  const primary = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#3b82f6';
  const text    = isDark ? 'rgba(195,210,230,0.68)' : 'rgba(30,40,60,0.58)';
  const grid    = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
  return { primary, text, grid, isDark };
}

// Gradient fill for line chart
function makeGradient(ctx, isDark) {
  const grad = ctx.createLinearGradient(0, 0, 0, 420);
  if (isDark) {
    grad.addColorStop(0,   'rgba(59,130,246,0.55)');
    grad.addColorStop(0.7, 'rgba(139,92,246,0.12)');
    grad.addColorStop(1,   'rgba(0,0,0,0)');
  } else {
    grad.addColorStop(0,   'rgba(59,130,246,0.35)');
    grad.addColorStop(0.7, 'rgba(139,92,246,0.06)');
    grad.addColorStop(1,   'rgba(255,255,255,0)');
  }
  return grad;
}

// Bar gradient per bar
function makeBarGradient(ctx, area, isDark) {
  const grad = ctx.createLinearGradient(0, area.top, 0, area.bottom);
  grad.addColorStop(0,   isDark ? '#3b82f6' : '#3b82f6');
  grad.addColorStop(1,   isDark ? '#7c3aed' : '#8b5cf6');
  return grad;
}

// ─────────────────────────────────────────────
//  Build main chart dataset
// ─────────────────────────────────────────────
const RANGE_LABELS = {
  day:   'Hoy · por hora',
  week:  'Última semana · por día',
  month: 'Mes actual · por día',
  year:  'Historial · por mes',
};

function buildDataset(range) {
  const now = todayDate();

  if (range === 'year') {
    const keys = Object.keys(monthlyData).filter(k => /^\d{4}-\d{2}$/.test(k)).sort();
    return { labels: keys.map(monthLabel), data: keys.map(k => parseFloat(monthlyData[k])||0), type:'bar' };
  }
  if (range === 'month') {
    const year = now.getFullYear(), month = now.getMonth();
    const days = new Date(year, month+1, 0).getDate();
    const labels=[],data=[];
    for (let d=1;d<=days;d++){
      const key=`${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      labels.push(String(d));
      data.push(parseFloat(dailyData[key])||0);
    }
    return { labels, data, type:'bar' };
  }
  if (range === 'week') {
    const DAYS=['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
    const labels=[],data=[];
    for (let i=6;i>=0;i--){
      const d=addDays(now,-i);
      labels.push(`${DAYS[d.getDay()]} ${d.getDate()}`);
      data.push(parseFloat(dailyData[yyyymmdd(d)])||0);
    }
    return { labels, data, type:'bar' };
  }
  if (range === 'day') {
    const key=yyyymmdd(now);
    const hourly=dailyDataHourly[key]||{};
    const labels=[],data=[];
    for (let h=0;h<24;h++){
      labels.push(`${String(h).padStart(2,'0')}:00`);
      data.push(parseFloat(hourly[String(h).padStart(2,'0')])||0);
    }
    return { labels, data, type:'line' };
  }
  return { labels:[], data:[], type:'bar' };
}

// ─────────────────────────────────────────────
//  Process datalog
// ─────────────────────────────────────────────
function processDatalog(snap) {
  dailyData = {}; dailyDataHourly = {};
  if (!snap.exists()) return;
  snap.forEach(daySnap => {
    const dayKey = daySnap.key;
    let dayKwh = 0;
    const hourBuckets = {};
    daySnap.forEach(r => {
      const v = r.val();
      const kwh = parseFloat(v?.kwh ?? v?.kWh ?? 0)||0;
      const hour = (r.key||'').split('-')[0]||'00';
      hourBuckets[hour] = (hourBuckets[hour]||0) + kwh;
      dayKwh = Math.max(dayKwh, kwh);
    });
    dailyData[dayKey]       = dayKwh;
    dailyDataHourly[dayKey] = hourBuckets;
  });
}

// ─────────────────────────────────────────────
//  Render main chart
// ─────────────────────────────────────────────
function renderChart() {
  const canvas = document.getElementById('mainChart');
  const empty  = document.getElementById('chartsEmpty');
  if (!canvas || !window.Chart) return;

  const { labels, data, type } = buildDataset(activeRange);
  const hasData = data.some(v => v > 0);

  document.getElementById('chartSubLabel').textContent = RANGE_LABELS[activeRange] || '';
  if (empty) empty.style.display = hasData ? 'none' : 'flex';

  const { primary, text, grid, isDark } = chartColors();
  const isLine = type === 'line';

  if (chartInst) {
    if (chartInst.config.type === type) {
      chartInst.data.labels = labels;
      chartInst.data.datasets[0].data = data;
      // Also update theme colors in case theme changed
      if (isLine) {
         chartInst.data.datasets[0].borderColor = primary;
         chartInst.data.datasets[0].backgroundColor = ctx => makeGradient(ctx.chart.ctx, isDark);
         chartInst.data.datasets[0].pointBorderColor = primary;
      }
      chartInst.update('none'); // Update without animation
      return;
    } else {
      chartInst.destroy();
      chartInst = null;
    }
  }
  if (!hasData) return;

  const tooltipCallbacks = {
    title: items => items[0]?.label ?? '',
    label: ctx => {
      const v = ctx.raw||0;
      return [`  ${v.toFixed(3)} kWh`, `  C$ ${(v*costPerKwh).toFixed(2)}`];
    },
  };

  const zoomPlugin = window['chartjs-plugin-zoom'] ?? null;
  if (zoomPlugin) Chart.register(zoomPlugin);

  chartInst = new Chart(canvas, {
    type,
    data: {
      labels,
      datasets: [{
        label: 'Consumo (kWh)',
        data,
        ...(isLine ? {
          borderColor: primary,
          borderWidth: 2.5,
          backgroundColor: ctx => makeGradient(ctx.chart.ctx, isDark),
          fill: true,
          tension: 0.42,
          pointRadius: 3,
          pointHoverRadius: 7,
          pointBackgroundColor: '#fff',
          pointBorderColor: primary,
          pointBorderWidth: 2,
        } : {
          backgroundColor: ctx => {
            const chart = ctx.chart;
            const { ctx: c2, chartArea } = chart;
            if (!chartArea) return primary;
            return makeBarGradient(c2, chartArea, isDark);
          },
          borderRadius: { topLeft:8, topRight:8, bottomLeft:0, bottomRight:0 },
          borderSkipped: false,
          hoverBackgroundColor: '#8b5cf6',
          barPercentage: 0.65,
        }),
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 700, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: isDark ? 'rgba(6,10,24,0.92)' : 'rgba(15,20,40,0.88)',
          titleColor: '#fff',
          bodyColor: 'rgba(210,220,240,0.85)',
          padding: { x:14, y:12 },
          cornerRadius: 12,
          displayColors: false,
          callbacks: tooltipCallbacks,
        },
        zoom: zoomPlugin ? {
          zoom: { wheel:{ enabled:true }, pinch:{ enabled:true }, mode:'x' },
          pan:  { enabled:true, mode:'x' },
        } : undefined,
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: { color: text, font:{ size:11, family:'Inter, sans-serif' }, maxTicksLimit: 14 },
        },
        y: {
          grid: { color: grid, drawBorder: false },
          border: { display: false },
          ticks: {
            color: text,
            font: { size:11, family:'Inter, sans-serif' },
            callback: v => `${v} kWh`,
          },
          beginAtZero: true,
        },
      },
    },
  });
}

// ─────────────────────────────────────────────
//  Render donut chart
// ─────────────────────────────────────────────
function renderDonut(monthlyMap) {
  const canvas = document.getElementById('donutChart');
  const legend = document.getElementById('donutLegend');
  const centerVal = document.getElementById('donutCenterVal');
  if (!canvas || !window.Chart) return;

  const keys = Object.keys(monthlyMap)
    .filter(k => /^\d{4}-\d{2}$/.test(k))
    .sort()
    .slice(-8); // Last 8 months max

  const labels = keys.map(monthLabel);
  const data   = keys.map(k => parseFloat(monthlyMap[k])||0);
  const total  = data.reduce((s,v) => s+v, 0);

  if (centerVal) centerVal.textContent = total > 0 ? `${total.toFixed(1)}` : '--';

  const colors = keys.map((_,i) => DONUT_PALETTE[i % DONUT_PALETTE.length]);
  const { isDark } = chartColors();

  if (donutInst) {
    donutInst.data.labels = labels;
    donutInst.data.datasets[0].data = data;
    donutInst.data.datasets[0].backgroundColor = colors;
    donutInst.data.datasets[0].borderColor = isDark ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,0.85)';
    donutInst.update('none'); // Update without animation
  }

  if (!donutInst) {

  donutInst = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors,
        borderColor: isDark ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,0.85)',
        borderWidth: 3,
        hoverOffset: 12,
        hoverBorderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '70%',
      animation: { duration: 900, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: isDark ? 'rgba(6,10,24,0.92)' : 'rgba(15,20,40,0.88)',
          titleColor: '#fff',
          bodyColor: 'rgba(210,220,240,0.85)',
          padding: { x:12, y:10 },
          cornerRadius: 10,
          displayColors: true,
          callbacks: {
            title: items => items[0]?.label ?? '',
            label: ctx => {
              const v = ctx.raw||0;
              const pct = total > 0 ? (v/total*100).toFixed(1) : '0';
              return [`  ${v.toFixed(2)} kWh  (${pct}%)`, `  C$ ${(v*costPerKwh).toFixed(2)}`];
            },
          },
        },
      },
    },
  });
  }

  // Custom legend
  if (legend) {
    legend.innerHTML = keys.map((k,i) => {
      const v = data[i]||0;
      const pct = total > 0 ? (v/total*100).toFixed(0) : '0';
      return `<div class="donut-legend-row">
        <span class="donut-legend-dot" style="background:${colors[i]}"></span>
        <span class="donut-legend-label">${labels[i]}</span>
        <span class="donut-legend-pct">${pct}%</span>
      </div>`;
    }).join('');
  }
}

// ─────────────────────────────────────────────
//  Insights
// ─────────────────────────────────────────────
function generateInsights(map) {
  const chips = [];
  const keys = Object.keys(map).filter(k=>/^\d{4}-\d{2}$/.test(k)).sort();
  if (keys.length < 2) return chips;

  const cur  = parseFloat(map[keys[keys.length-1]])||0;
  const prev = parseFloat(map[keys[keys.length-2]])||0;
  const avg  = keys.reduce((s,k)=>s+(parseFloat(map[k])||0),0)/keys.length;

  if (prev > 0) {
    const pct = ((cur-prev)/prev*100).toFixed(1);
    const up  = cur > prev;
    chips.push({ icon: up?'trending-up':'trending-down', color: up?'danger':'success',
      text: `${up?'▲':'▼'} ${Math.abs(pct)}% respecto al mes anterior` });
  }
  if (keys.length >= 3 && avg > 0) {
    const pct = ((cur-avg)/avg*100).toFixed(1);
    const up  = cur > avg;
    chips.push({ icon: up?'flame':'leaf', color: up?'warn':'success',
      text: `${Math.abs(pct)}% ${up?'sobre':'bajo'} tu promedio histórico` });
  }
  if (keys.length >= 3) {
    const last3 = keys.slice(-3).map(k=>parseFloat(map[k])||0);
    if (last3[2]>last3[1] && last3[1]>last3[0])
      chips.push({ icon:'alert-triangle', color:'warn', text:'Tendencia creciente 3 meses consecutivos' });
  }
  return chips.slice(0,3);
}

function renderInsights(map) {
  const row = document.getElementById('insightsRow');
  if (!row) return;
  const chips = generateInsights(map);
  row.innerHTML = chips.map(c => `
    <div class="insight-chip insight-${c.color}" role="status">
      <i data-lucide="${c.icon}"></i><span>${c.text}</span>
    </div>`).join('');
  lucideRefresh();
}

// ─────────────────────────────────────────────
//  Stat cards
// ─────────────────────────────────────────────
function renderStats(map) {
  const keys   = Object.keys(map).filter(k=>/^\d{4}-\d{2}$/.test(k)).sort();
  const curKey = yyyymm(todayDate());
  const cur    = parseFloat(map[curKey])||0;
  const avg    = keys.length ? keys.reduce((s,k)=>s+(parseFloat(map[k])||0),0)/keys.length : 0;

  setText('statCurrentVal', fmtKwh(cur), '');

  const prevKey = keys[keys.indexOf(curKey)-1];
  const prev    = prevKey ? (parseFloat(map[prevKey])||0) : null;
  if (prev !== null && prev > 0) {
    const pct = ((cur-prev)/prev*100).toFixed(1);
    const up  = cur > prev;
    setText('statVsPrevVal', `${up?'▲':'▼'} ${Math.abs(pct)}%`, up?'text-danger':'text-success');
    const card = document.getElementById('statVsPrev');
    const icon = card?.querySelector('.chart-stat-icon i');
    if (icon) icon.setAttribute('data-lucide', up?'trending-up':'trending-down');
  } else {
    setText('statVsPrevVal','—','');
  }

  if (avg > 0 && keys.length >= 2) {
    const pct = ((cur-avg)/avg*100).toFixed(1);
    const up  = cur > avg;
    setText('statVsAvgVal', `${up?'▲':'▼'} ${Math.abs(pct)}%`, up?'text-danger':'text-success');
  } else {
    setText('statVsAvgVal','—','');
  }

  setText('statCostVal', fmtCost(cur), '');
  lucideRefresh();
}

function setText(id, val, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = val;
  el.className   = `chart-stat-value${cls?' '+cls:''}`;
}

// ─────────────────────────────────────────────
//  Load & render
// ─────────────────────────────────────────────
async function loadAndRender(userUid) {
  setSystemStatus('Cargando datos…');
  try {
    const [monthSnap, logSnap, cfgSnap] = await Promise.all([
      get(ref(db, monthlyRoot(userUid))),
      get(ref(db, datalogRoot(userUid))),
      get(ref(db, configurePath(userUid))),
    ]);

    monthlyData = monthSnap.exists() ? (monthSnap.val()||{}) : {};
    processDatalog(logSnap);

    if (cfgSnap.exists()) {
      const t = Number(cfgSnap.val()?.tarifa);
      if (Number.isFinite(t) && t > 0) { costPerKwh = t; localStorage.setItem('costPerKwh', String(t)); }
    }

    setSystemStatus('Conectado');
    renderInsights(monthlyData);
    renderStats(monthlyData);
    renderChart();
    renderDonut(monthlyData);

    // Live monthly updates
    onValue(ref(db, monthlyRoot(userUid)), snap => {
      if (!snap.exists()) return;
      monthlyData = snap.val()||{};
      renderInsights(monthlyData);
      renderStats(monthlyData);
      if (activeRange==='month'||activeRange==='year') renderChart();
      renderDonut(monthlyData);
    });

  } catch(err) {
    console.error(err);
    setSystemStatus('Error al cargar');
  }
}

// ─────────────────────────────────────────────
//  Filters
// ─────────────────────────────────────────────
function initFilters() {
  document.querySelectorAll('.chart-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chart-filter-btn').forEach(b=>b.classList.remove('is-active'));
      btn.classList.add('is-active');
      activeRange = btn.dataset.range;
      renderChart();
    });
  });
  document.getElementById('resetZoomBtn')?.addEventListener('click', () => chartInst?.resetZoom?.());
}

// ─────────────────────────────────────────────
//  Sidebar / Theme / Auth
// ─────────────────────────────────────────────
function initSidebar() {
  const shell = document.getElementById('appShell');
  const openBtn  = document.getElementById('sidebarToggle');
  const closeBtn = document.getElementById('sidebarClose');
  const backdrop = document.getElementById('sidebarBackdrop');
  const close = () => shell?.classList.remove('sidebar-open');
  openBtn?.addEventListener('click',  () => shell?.classList.add('sidebar-open'));
  closeBtn?.addEventListener('click', close);
  backdrop?.addEventListener('click', close);
  window.addEventListener('resize', () => { if (window.innerWidth >= 900) close(); });
}

function initThemeToggle() {
  window.addEventListener('themeChanged', () => {
    if (chartInst) {
      chartInst.destroy();
      chartInst = null;
      renderChart();
    }
    if (donutInst) {
      donutInst.destroy();
      donutInst = null;
      renderDonut(monthlyData);
    }
  });
}

function initAuth() {
  const authBtn = document.getElementById('authBtn');
  authBtn?.addEventListener('click', () => signOut(auth).catch(()=>{}));
  onAuthStateChanged(auth, user => {
    if (user) {
      uid = user.uid;
      setSidebarIdentity(user.email || 'Sesión iniciada');
      if (authBtn) authBtn.disabled = false;
      loadAndRender(uid);
    } else {
      uid = null;
      setSidebarIdentity('Sin autenticar');
      setSystemStatus('No autenticado');
      if (authBtn) authBtn.disabled = true;
    }
    lucideRefresh();
  });
}

// ─────────────────────────────────────────────
//  Boot
// ─────────────────────────────────────────────
function boot() {
  initSidebar();
  initFilters();
  initAuth();
  initThemeToggle();
  lucideRefresh();
}

document.addEventListener('DOMContentLoaded', boot);

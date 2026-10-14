/* ESPower – devices.js  (Vanilla JS + Firebase RTDB) */

import "./background.js";
import { auth, db } from "./firebase-config.js";
import {
  telemetryField,
  deviceOutput,
  deviceHistory,
  deviceNameField,
  deviceIconField,
  deviceNamesRoot,
  deviceIconsRoot,
  scheduleEntryEnabled,
  scheduleEntry,
  schedulesDevice,
  automationsRoot,
  automationEnabled,
  automationEntry,
} from "./firebase-paths.js";
import {
  onAuthStateChanged, signOut, signInWithEmailAndPassword,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  ref, onValue, set, get, push, remove, query, limitToLast, orderByKey,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";


// ── Device definitions ──
const DEVICE_ICONS = [
  'lightbulb','wind','waves','zap','thermometer','droplets',
  'monitor','server','wifi','plug','tv','fan',
  'refrigerator','washing-machine','microwave','lamp','speaker','cpu',
];

const ICON_COLORS = ['c-blue','c-violet','c-cyan','c-green','c-amber','c-pink'];

const DEVICES = [
  { id: 'led',  fbKey: 'led',  defaultName: 'Dispositivo 1', icon: 'lightbulb', color: 'c-amber'  },
  { id: 'led1', fbKey: 'led1', defaultName: 'Dispositivo 2', icon: 'wind',      color: 'c-cyan'   },
  { id: 'led2', fbKey: 'led2', defaultName: 'Dispositivo 3', icon: 'waves',     color: 'c-violet' },
  { id: 'led3', fbKey: 'led3', defaultName: 'Dispositivo 4', icon: 'plug',      color: 'c-green'  },
];


const METRIC_LABELS = { power: 'Potencia (W)', voltage: 'Voltaje (V)', current: 'Corriente (A)' };
const DAY_LABELS    = ['D','L','M','M','J','V','S'];

// ── State ──
let uid            = null;
let dbUnsubs       = [];
let deviceStates   = {};   // { led: 0|1, led1: 0|1, led2: 0|1 }
let deviceNames    = {};   // { led: 'Aire...', ... }
let deviceIcons    = {};   // { led: 'wind', ... }
let schedules      = {};   // { led: { pushId: {...}, ... }, ... }
let automations    = {};   // { pushId: { deviceId, metric, operator, threshold, action, enabled } }
let latestMetrics  = { power: 0, voltage: 0, current: 0 };
let deviceLastSeen = {};   // { led: timestamp }

// ── Modal state ──
let currentDeviceId = null;
let editIcon        = null;

// ══════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════
function lucideRefresh() { if (window.lucide) window.lucide.createIcons(); }
function isoNow() { return new Date().toLocaleString('es-NI', { hour12: false }); }

function timeAgo(ts) {
  if (!ts) return '—';
  // ts is a numeric timestamp (Date.now())
  const diff = Date.now() - Number(ts);
  if (diff < 60000)   return 'hace menos de 1 min';
  if (diff < 3600000) return `hace ${Math.round(diff / 60000)} min`;
  if (diff < 86400000) return `hace ${Math.round(diff / 3600000)} h`;
  return `hace ${Math.round(diff / 86400000)} días`;
}

function devName(id) { return deviceNames[id] || DEVICES.find(d => d.id === id)?.defaultName || id; }
function devIcon(id)  { return deviceIcons[id] || DEVICES.find(d => d.id === id)?.icon || 'zap'; }

function setSystemStatus(txt) {
  ['systemStatusText','topbarStatusText'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
  });
}

// ══════════════════════════════════════════════
//  RENDER DEVICES
// ══════════════════════════════════════════════
function renderDevices() {
  const grid = document.getElementById('devicesGrid');
  if (!grid) return;

  grid.innerHTML = DEVICES.map(d => {
    const on       = !!deviceStates[d.id];
    const name     = devName(d.id);
    const icon     = devIcon(d.id);
    const lastSeen = deviceLastSeen[d.id];
    const schedCount = Object.keys(schedules[d.id] || {}).length;
    const autoCount  = Object.values(automations).filter(r => r.deviceId === d.id && r.enabled).length;

    return `
      <div class="dv-card ${on ? 'dv-on' : 'dv-off'}" id="dvcard-${d.id}">
        <div class="dv-topbar">
          <div class="dv-icon ${d.color || 'c-blue'}"><i data-lucide="${icon}"></i></div>
          <div class="dv-meta">
            <div class="dv-name-row">
              <span class="dv-name">${name}</span>
              <button class="dv-edit-btn" data-edit="${d.id}" title="Editar nombre"><i data-lucide="pencil"></i></button>
            </div>
            <div class="dv-status-row">
              <span class="dv-status-dot ${on ? 'on' : 'off'}"></span>
              <span class="dv-status-txt">${on ? 'Encendido' : 'Apagado'}</span>
              ${autoCount > 0 ? `<span class="dv-sched-badge" title="${autoCount} regla(s) activa(s)">⚡${autoCount}</span>` : ''}
            </div>
            <div class="dv-last-seen">Actualizado ${timeAgo(lastSeen)}</div>
          </div>
        </div>
        <div class="dv-toggle-row">
          <span class="dv-toggle-label ${on ? 'on' : 'off'}">${on ? 'Encendido' : 'Apagado'}</span>
          <label class="switch" title="${on ? 'Apagar' : 'Encender'} ${name}">
            <input type="checkbox" data-toggle="${d.id}" ${on ? 'checked' : ''} />
            <span class="slider"></span>
          </label>
        </div>
        <div class="dv-divider"></div>
        <div class="dv-actions">
          <button class="dv-action-btn" data-sched="${d.id}">
            <i data-lucide="calendar-clock"></i>
            Programar${schedCount > 0 ? `<span class="dv-sched-badge">${schedCount}</span>` : ''}
          </button>
          <button class="dv-action-btn" data-auto="${d.id}">
            <i data-lucide="zap"></i>
            Automatizar
          </button>
          <button class="dv-action-btn" data-hist="${d.id}">
            <i data-lucide="history"></i>
            Historial
          </button>
        </div>
      </div>`;
  }).join('');

  lucideRefresh();
  wireCardEvents();
}

function updateDeviceCard(id) {
  // Efficient patch: just refresh the whole card for the given device
  const card = document.getElementById(`dvcard-${id}`);
  if (!card) return;
  renderDevices(); // simple full re-render (grid is small, 3 devices)
}

// ══════════════════════════════════════════════
//  WIRE EVENTS – card buttons
// ══════════════════════════════════════════════
function wireCardEvents() {
  // Toggle switch
  document.querySelectorAll('[data-toggle]').forEach(input => {
    input.addEventListener('change', () => {
      const id  = input.getAttribute('data-toggle');
      const val = input.checked ? 1 : 0;
      toggleDevice(id, val, 'manual');
    });
  });

  // Edit
  document.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => openEditModal(btn.getAttribute('data-edit')));
  });

  // Schedule
  document.querySelectorAll('[data-sched]').forEach(btn => {
    btn.addEventListener('click', () => openSchedModal(btn.getAttribute('data-sched')));
  });

  // Automation
  document.querySelectorAll('[data-auto]').forEach(btn => {
    btn.addEventListener('click', () => openAutoModal(btn.getAttribute('data-auto')));
  });

  // History
  document.querySelectorAll('[data-hist]').forEach(btn => {
    btn.addEventListener('click', () => openHistModal(btn.getAttribute('data-hist')));
  });
}

// ══════════════════════════════════════════════
//  DEVICE TOGGLE + HISTORY LOG
// ══════════════════════════════════════════════
function toggleDevice(id, val, trigger = 'manual', details = '') {
  if (!uid) return;
  const d = DEVICES.find(x => x.id === id);
  if (!d) return;

  set(ref(db, deviceOutput(uid, d.fbKey)), val).catch(console.error);

  // Write to history
  const action = val ? 'on' : 'off';
  logHistory(id, action, trigger, details || (trigger === 'manual' ? (val ? 'Encendido manual' : 'Apagado manual') : details));

  deviceLastSeen[id] = isoNow();
  updateDeviceCard(id);
}

function logHistory(deviceId, action, trigger, details) {
  if (!uid) return;
  const entry = { ts: isoNow(), action, trigger, details };
  push(ref(db, deviceHistory(uid, deviceId)), entry).catch(console.error);
}

// ══════════════════════════════════════════════
//  MODAL HELPERS
// ══════════════════════════════════════════════
function openModal(id)  { document.getElementById(id)?.classList.add('open'); lucideRefresh(); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }

document.addEventListener('click', e => {
  const cls = e.target.closest('[data-close]');
  if (cls) closeModal(cls.dataset.close);

  // Click backdrop
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('open');
  }
});

// ══════════════════════════════════════════════
//  EDIT NAME MODAL
// ══════════════════════════════════════════════
function openEditModal(id) {
  currentDeviceId = id;
  editIcon = devIcon(id);

  document.getElementById('editModalTitle').textContent = 'Editar dispositivo';
  document.getElementById('editModalSub').textContent   = devName(id);
  document.getElementById('editName').value             = devName(id);

  // Render icon grid
  const grid = document.getElementById('iconGrid');
  grid.innerHTML = DEVICE_ICONS.map(ic => `
    <button class="icon-opt ${ic === editIcon ? 'selected' : ''}" data-icon="${ic}" title="${ic}">
      <i data-lucide="${ic}"></i>
    </button>`).join('');

  grid.querySelectorAll('.icon-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      grid.querySelectorAll('.icon-opt').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      editIcon = btn.dataset.icon;
    });
  });

  openModal('editModal');
}

document.getElementById('editSaveBtn')?.addEventListener('click', () => {
  const id   = currentDeviceId;
  const name = document.getElementById('editName').value.trim();
  if (!id || !name) return;

  deviceNames[id] = name;
  deviceIcons[id] = editIcon;

  if (uid) {
    set(ref(db, deviceNameField(uid, id)), name).catch(console.error);
    set(ref(db, deviceIconField(uid, id)), editIcon).catch(console.error);
    logHistory(id, 'rename', 'manual', `Renombrado a: ${name}`);
  }

  closeModal('editModal');
  renderDevices();
});

// ══════════════════════════════════════════════
//  SCHEDULE MODAL
// ══════════════════════════════════════════════
function openSchedModal(id) {
  currentDeviceId = id;
  document.getElementById('schedModalTitle').textContent = 'Programación horaria';
  document.getElementById('schedModalSub').textContent   = devName(id);
  renderSchedList(id);
  openModal('schedModal');
}

function renderSchedList(id) {
  const list = document.getElementById('schedList');
  const map  = schedules[id] || {};
  const keys = Object.keys(map);

  if (!keys.length) {
    list.innerHTML = `<div class="list-empty"><i data-lucide="calendar-x"></i>Sin horarios aún</div>`;
    lucideRefresh();
    return;
  }

  list.innerHTML = keys.map(k => {
    const s = map[k];
    const days = (s.days || []).map(d => DAY_LABELS[d]).join(' ');
    const action = s.action === 'on' ? 'Encender' : 'Apagar';
    const enabled = s.enabled !== false;
    return `
      <div class="list-item">
        <div class="list-item-info">
          <div class="list-item-title">${action} a las ${s.hour}:${String(s.minute).padStart(2,'0')}</div>
          <div class="list-item-sub">${days || 'Sin días'} ${enabled ? '' : '· Desactivado'}</div>
        </div>
        <label class="toggle-mini" title="Activar/desactivar">
          <input type="checkbox" ${enabled ? 'checked' : ''} data-sched-toggle="${id}" data-sched-key="${k}" />
          <span class="sl"></span>
        </label>
        <button class="btn btn-danger btn-sm" data-sched-del="${id}" data-sched-key="${k}"><i data-lucide="trash-2"></i></button>
      </div>`;
  }).join('');

  lucideRefresh();

  list.querySelectorAll('[data-sched-toggle]').forEach(input => {
    input.addEventListener('change', () => {
      const did = input.dataset.schedToggle;
      const key = input.dataset.schedKey;
      if (uid) set(ref(db, scheduleEntryEnabled(uid, did, key)), input.checked).catch(console.error);
      if (schedules[did]?.[key]) schedules[did][key].enabled = input.checked;
    });
  });

  list.querySelectorAll('[data-sched-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      const did = btn.dataset.schedDel;
      const key = btn.dataset.schedKey;
      if (uid) remove(ref(db, scheduleEntry(uid, did, key))).catch(console.error);
      delete (schedules[did] || {})[key];
      renderSchedList(did);
      updateDeviceCard(did);
    });
  });
}

document.getElementById('schedAddBtn')?.addEventListener('click', () => {
  const id = currentDeviceId;
  if (!id || !uid) return;

  const timeVal  = document.getElementById('schedHour').value || '08:00';
  const [h, m]   = timeVal.split(':').map(Number);
  const action   = document.getElementById('schedAction').value;
  const active   = [...document.querySelectorAll('#schedDays .day-btn.active')].map(b => Number(b.dataset.day));

  const entry = { hour: h, minute: m, action, days: active, enabled: true };
  const newRef = push(ref(db, schedulesDevice(uid, id)), entry);
  newRef.catch(console.error);

  newRef.then(r => {
    if (!schedules[id]) schedules[id] = {};
    schedules[id][r.key] = entry;
    renderSchedList(id);
    updateDeviceCard(id);
  });
});

// Days toggle inside modal
document.getElementById('schedDays')?.addEventListener('click', e => {
  const btn = e.target.closest('.day-btn');
  if (btn) btn.classList.toggle('active');
});

// ══════════════════════════════════════════════
//  AUTOMATION MODAL
// ══════════════════════════════════════════════
function openAutoModal(id) {
  currentDeviceId = id;
  document.getElementById('autoModalTitle').textContent = 'Automatizaciones';
  document.getElementById('autoModalSub').textContent   = devName(id);
  renderAutoList(id);
  openModal('autoModal');
}

function renderAutoList(id) {
  const list = document.getElementById('autoList');
  const rules = Object.entries(automations).filter(([,r]) => r.deviceId === id);

  if (!rules.length) {
    list.innerHTML = `<div class="list-empty"><i data-lucide="zap-off"></i>Sin automatizaciones</div>`;
    lucideRefresh();
    return;
  }

  list.innerHTML = rules.map(([k, r]) => {
    const metricLabel  = METRIC_LABELS[r.metric] || r.metric;
    const actionLabel  = r.action === 'on' ? 'Encender' : 'Apagar';
    const enabled      = r.enabled !== false;
    return `
      <div class="list-item">
        <div class="list-item-info">
          <div class="list-item-title">${actionLabel} si ${metricLabel} ${r.operator} ${r.threshold}</div>
          <div class="list-item-sub">${enabled ? 'Activa' : 'Desactivada'}</div>
        </div>
        <label class="toggle-mini">
          <input type="checkbox" ${enabled ? 'checked' : ''} data-auto-toggle="${k}" />
          <span class="sl"></span>
        </label>
        <button class="btn btn-danger btn-sm" data-auto-del="${k}"><i data-lucide="trash-2"></i></button>
      </div>`;
  }).join('');

  lucideRefresh();

  list.querySelectorAll('[data-auto-toggle]').forEach(input => {
    input.addEventListener('change', () => {
      const key = input.dataset.autoToggle;
      if (uid) set(ref(db, automationEnabled(uid, key)), input.checked).catch(console.error);
      if (automations[key]) automations[key].enabled = input.checked;
    });
  });

  list.querySelectorAll('[data-auto-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.autoDel;
      if (uid) remove(ref(db, automationEntry(uid, key))).catch(console.error);
      delete automations[key];
      renderAutoList(id);
      renderDevices();
    });
  });
}

document.getElementById('autoAddBtn')?.addEventListener('click', () => {
  const id = currentDeviceId;
  if (!id || !uid) return;

  const metric    = document.getElementById('autoMetric').value;
  const operator  = document.getElementById('autoOp').value;
  const threshold = parseFloat(document.getElementById('autoThreshold').value);
  const action    = document.getElementById('autoAction').value;

  if (!Number.isFinite(threshold)) return;

  const rule = { deviceId: id, metric, operator, threshold, action, enabled: true };
  const newRef = push(ref(db, automationsRoot(uid)), rule);
  newRef.catch(console.error);

  newRef.then(r => {
    automations[r.key] = rule;
    renderAutoList(id);
    renderDevices();
  });
});

// ══════════════════════════════════════════════
//  HISTORY MODAL
// ══════════════════════════════════════════════
function openHistModal(id) {
  currentDeviceId = id;
  document.getElementById('histModalTitle').textContent = 'Historial';
  document.getElementById('histModalSub').textContent   = devName(id);

  const list = document.getElementById('histList');
  list.innerHTML = `<div class="list-empty"><i data-lucide="loader"></i>Cargando…</div>`;
  openModal('histModal');
  lucideRefresh();

  if (!uid) return;
  const histRef = query(ref(db, deviceHistory(uid, id)), orderByKey(), limitToLast(30));
  get(histRef).then(snap => {
    const val = snap.val();
    if (!val) {
      list.innerHTML = `<div class="list-empty"><i data-lucide="clock"></i>Sin actividad registrada</div>`;
      lucideRefresh();
      return;
    }
    const entries = Object.values(val).reverse();
    const triggerClass = { manual: 'manual', schedule: 'auto', automation: 'auto', error: 'error' };
    const actionLabel  = { on: 'Encendido', off: 'Apagado', rename: 'Renombrado' };
    list.innerHTML = entries.map(e => `
      <div class="hist-row">
        <span class="hist-dot ${triggerClass[e.trigger] || ''}"></span>
        <div class="hist-info">
          <div class="hist-action">${e.details || actionLabel[e.action] || e.action}</div>
          <div class="hist-meta">${e.ts} · ${e.trigger === 'manual' ? 'Manual' : e.trigger === 'schedule' ? 'Horario' : e.trigger === 'automation' ? 'Automatización' : e.trigger}</div>
        </div>
      </div>`).join('');
    lucideRefresh();
  }).catch(() => {
    list.innerHTML = `<div class="list-empty">Error al cargar historial</div>`;
  });
}

// ══════════════════════════════════════════════

//  FIREBASE BINDINGS
// ══════════════════════════════════════════════
function stopFirebaseBindings() {
  dbUnsubs.forEach(fn => { try { fn(); } catch { /* ignore */ } });
  dbUnsubs = [];
}

function startFirebaseBindings(userUid) {
  stopFirebaseBindings();
  setSystemStatus('Conectando…');

  // Device states — track lastSeen timestamp as Date.now()
  DEVICES.forEach(d => {
    dbUnsubs.push(onValue(ref(db, deviceOutput(userUid, d.fbKey)), s => {
      setSystemStatus('Conectado');
      deviceStates[d.id] = Number(s.val());
      deviceLastSeen[d.id] = Date.now();   // numeric timestamp - timeAgo works correctly
      renderDevices();
    }));
  });

  // Custom names
  dbUnsubs.push(onValue(ref(db, deviceNamesRoot(userUid)), s => {
    const v = s.val() || {};
    DEVICES.forEach(d => { if (v[d.id]) deviceNames[d.id] = v[d.id]; });
    renderDevices();
  }));

  // Custom icons
  dbUnsubs.push(onValue(ref(db, deviceIconsRoot(userUid)), s => {
    const v = s.val() || {};
    DEVICES.forEach(d => { if (v[d.id]) deviceIcons[d.id] = v[d.id]; });
    renderDevices();
  }));

  // Schedules
  DEVICES.forEach(d => {
    dbUnsubs.push(onValue(ref(db, schedulesDevice(userUid, d.id)), s => {
      schedules[d.id] = s.val() || {};
      renderDevices();
      if (currentDeviceId === d.id && document.getElementById('schedModal')?.classList.contains('open')) {
        renderSchedList(d.id);
      }
    }));
  });

  // Automations
  dbUnsubs.push(onValue(ref(db, automationsRoot(userUid)), s => {
    automations = s.val() || {};
    renderDevices();
    const auto = document.getElementById('autoModal');
    if (auto?.classList.contains('open') && currentDeviceId) renderAutoList(currentDeviceId);
  }));

  // Live metrics (for automation)
  dbUnsubs.push(onValue(ref(db, telemetryField(userUid, 'potencia')), s => {
    latestMetrics.power = Number(s.val()) || 0;
  }));
  dbUnsubs.push(onValue(ref(db, telemetryField(userUid, 'voltaje')), s => {
    latestMetrics.voltage = Number(s.val()) || 0;
  }));
  dbUnsubs.push(onValue(ref(db, telemetryField(userUid, 'corriente')), s => {
    latestMetrics.current = Number(s.val()) || 0;
  }));
}

// ══════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════
function setAppLocked(locked) {
  document.getElementById('appShell')?.classList.toggle('app-locked', locked);
  document.getElementById('authOverlay')?.classList.toggle('hidden', !locked);
}

function setSidebarEmail(email) {
  const el = document.getElementById('sidebarUserEmail');
  if (el) el.textContent = email || 'Sin autenticar';
}

onAuthStateChanged(auth, user => {
  if (user) {
    uid = user.uid;
    setAppLocked(false);
    setSidebarEmail(user.email);
    startFirebaseBindings(uid);
    renderDevices();
  } else {
    uid = null;
    setAppLocked(true);
    stopFirebaseBindings();
  }
});

// Login form
document.getElementById('overlayLoginBtn')?.addEventListener('click', () => {
  const email = document.getElementById('overlayEmail')?.value.trim();
  const pass  = document.getElementById('overlayPass')?.value;
  if (!email || !pass) return;
  signInWithEmailAndPassword(auth, email, pass).catch(err => {
    console.error(err);
  });
});

// Logout
document.getElementById('authBtn')?.addEventListener('click', () => {
  stopFirebaseBindings();
  signOut(auth);
});

// Legacy sidebar and theme logic removed; handled by sidebar.js

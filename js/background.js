/**
 * ESPower – background.js
 * Lógica global para ejecutar automatizaciones y programaciones sin importar en qué página se encuentre el usuario.
 */

import { auth, db } from "./firebase-config.js";
import {
  telemetryField,
  deviceOutput,
  deviceHistory,
  schedulesDevice,
  automationsRoot,
} from "./firebase-paths.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { ref, onValue, set, push } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";

const METRIC_LABELS = { power: 'Potencia (W)', voltage: 'Voltaje (V)', current: 'Corriente (A)' };
const DEVICES = [
  { id: 'led',  fbKey: 'led' },
  { id: 'led1', fbKey: 'led1' },
  { id: 'led2', fbKey: 'led2' },
  { id: 'led3', fbKey: 'led3' },
];

let uid = null;
let schedules = {};
let automations = {};
let deviceStates = {};
let metrics = { power: 0, voltage: 0, current: 0 };
let unsubs = [];

function isoNow() { return new Date().toLocaleString('es-NI', { hour12: false }); }

function toggleDeviceBG(deviceId, val, trigger, details) {
  if (!uid) return;
  const d = DEVICES.find(x => x.id === deviceId);
  if (!d) return;

  // Optimistic update
  deviceStates[deviceId] = val;
  set(ref(db, deviceOutput(uid, d.fbKey)), val).catch(console.error);

  const action = val ? 'on' : 'off';
  const entry = { ts: isoNow(), action, trigger, details };
  push(ref(db, deviceHistory(uid, deviceId)), entry).catch(console.error);
}

// ── SCHEDULES EXECUTOR ──
function checkSchedules() {
  if (!uid) return;
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  const day = now.getDay();

  DEVICES.forEach(d => {
    const map = schedules[d.id] || {};
    Object.entries(map).forEach(([, s]) => {
      if (s.enabled === false) return;
      if (s.hour !== h || s.minute !== m) return;
      if (s.days && s.days.length && !s.days.includes(day)) return;

      const desiredVal = s.action === 'on' ? 1 : 0;
      if (deviceStates[d.id] !== desiredVal) {
        toggleDeviceBG(d.id, desiredVal, 'schedule', `${s.action === 'on' ? 'Encendido' : 'Apagado'} por horario`);
      }
    });
  });
}
// Run every minute
setInterval(checkSchedules, 60000);

// ── AUTOMATIONS EXECUTOR ──
function checkAutomations() {
  if (!uid) return;
  Object.entries(automations).forEach(([, rule]) => {
    if (!rule.enabled) return;
    const val = metrics[rule.metric];
    if (!Number.isFinite(val)) return;

    const triggered = rule.operator === '>' ? val > rule.threshold :
                      rule.operator === '<' ? val < rule.threshold : false;

    if (!triggered) return;

    const d = DEVICES.find(x => x.id === rule.deviceId);
    if (!d) return;

    const desiredVal = rule.action === 'on' ? 1 : 0;
    if (deviceStates[d.id] !== desiredVal) {
      const metricLabel = METRIC_LABELS[rule.metric] || rule.metric;
      const detail = `${rule.action === 'on' ? 'Encendido' : 'Apagado'} — ${metricLabel} ${rule.operator} ${rule.threshold}`;
      toggleDeviceBG(d.id, desiredVal, 'automation', detail);
    }
  });
}

function startBindings() {
  stopBindings();
  // DEVICE STATES
  DEVICES.forEach(d => {
    unsubs.push(onValue(ref(db, deviceOutput(uid, d.fbKey)), s => {
      deviceStates[d.id] = Number(s.val());
    }));
  });

  // SCHEDULES
  DEVICES.forEach(d => {
    unsubs.push(onValue(ref(db, schedulesDevice(uid, d.id)), s => {
      schedules[d.id] = s.val() || {};
    }));
  });

  // AUTOMATIONS
  unsubs.push(onValue(ref(db, automationsRoot(uid)), s => {
    automations = s.val() || {};
  }));

  // METRICS
  unsubs.push(onValue(ref(db, telemetryField(uid, 'potencia')), s => {
    metrics.power = Number(s.val()) || 0;
    // Check automations dynamically when power changes
    checkAutomations();
  }));
  unsubs.push(onValue(ref(db, telemetryField(uid, 'voltaje')), s => {
    metrics.voltage = Number(s.val()) || 0;
    checkAutomations();
  }));
  unsubs.push(onValue(ref(db, telemetryField(uid, 'corriente')), s => {
    metrics.current = Number(s.val()) || 0;
    checkAutomations();
  }));
}

function stopBindings() {
  unsubs.forEach(fn => { try { fn(); } catch { } });
  unsubs = [];
}

onAuthStateChanged(auth, user => {
  if (user) {
    uid = user.uid;
    startBindings();
  } else {
    uid = null;
    stopBindings();
  }
});

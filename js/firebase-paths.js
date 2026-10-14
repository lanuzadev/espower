/**
 * Rutas de Firebase Realtime Database (un solo lugar para web + ESP32).
 *
 * Telemetría (lo que escribe el ESP32) — valores numéricos:
 *   UsersData/{uid}/telemetry/voltaje
 *   UsersData/{uid}/telemetry/corriente
 *   UsersData/{uid}/telemetry/potencia
 *   UsersData/{uid}/telemetry/kwh
 *
 * {uid} = UID del usuario en Firebase Authentication (mismo que al iniciar sesión en la web).
 *
 * Envío desde ESP32 (recomendado):
 * - Cliente oficial (Firebase-ESP32 / similar) con `setFloat`, `set`, o JSON.
 * - REST: PATCH `https://<project>-default-rtdb.firebaseio.com/UsersData/<UID>/telemetry.json`
 *   con cuerpo JSON; la reglas de seguridad deben permitir escritura en ese nodo (token, reglas, etc.).
 */

const ROOT = 'UsersData';

export function userRoot(uid) {
  return `${ROOT}/${uid}`;
}

/** Nodo de lecturas en vivo del medidor / ESP32 */
export function telemetryRoot(uid) {
  return `${userRoot(uid)}/telemetry`;
}

export function telemetryField(uid, key) {
  return `${telemetryRoot(uid)}/${key}`;
}

export function configurePath(uid) {
  return `${userRoot(uid)}/configure`;
}

export function configureField(uid, key) {
  return `${configurePath(uid)}/${key}`;
}

export function datalogRoot(uid) {
  return `${userRoot(uid)}/datalog`;
}

export function datalogDay(uid, dayKey) {
  return `${datalogRoot(uid)}/${dayKey}`;
}

export function datalogEntry(uid, dayKey, timeKey) {
  return `${datalogRoot(uid)}/${dayKey}/${timeKey}`;
}

export function monthlyRoot(uid) {
  return `${userRoot(uid)}/monthly`;
}

export function monthlyMonth(uid, yyyyMm) {
  return `${monthlyRoot(uid)}/${yyyyMm}`;
}

export function monthStart(uid, yyyyMm) {
  return `${userRoot(uid)}/monthStart/${yyyyMm}`;
}

/** All month-start snapshots: { "YYYY-MM": number, ... } */
export function monthStartRoot(uid) {
  return `${userRoot(uid)}/monthStart`;
}

export function chartsPath(uid) {
  return `${userRoot(uid)}/charts`;
}

export function deviceOutput(uid, fbKey) {
  return `${userRoot(uid)}/${fbKey}`;
}

export function deviceHistory(uid, deviceId) {
  return `${userRoot(uid)}/deviceHistory/${deviceId}`;
}

export function deviceNamesRoot(uid) {
  return `${userRoot(uid)}/deviceNames`;
}

export function deviceNameField(uid, id) {
  return `${deviceNamesRoot(uid)}/${id}`;
}

export function deviceIconsRoot(uid) {
  return `${userRoot(uid)}/deviceIcons`;
}

export function deviceIconField(uid, id) {
  return `${deviceIconsRoot(uid)}/${id}`;
}

export function schedulesDevice(uid, deviceId) {
  return `${userRoot(uid)}/schedules/${deviceId}`;
}

export function scheduleEntryEnabled(uid, deviceId, entryKey) {
  return `${userRoot(uid)}/schedules/${deviceId}/${entryKey}/enabled`;
}

export function scheduleEntry(uid, deviceId, entryKey) {
  return `${userRoot(uid)}/schedules/${deviceId}/${entryKey}`;
}

export function automationsRoot(uid) {
  return `${userRoot(uid)}/automations`;
}

export function automationEnabled(uid, key) {
  return `${userRoot(uid)}/automations/${key}/enabled`;
}

export function automationEntry(uid, key) {
  return `${userRoot(uid)}/automations/${key}`;
}

/**
 * Orden remota de reinicio ESP32 (la web escribe aquí; el firmware debe escuchar y llamar esp_restart()).
 * Ruta: UsersData/{uid}/commands/restart  → número (timestamp ms) u objeto { t, source }
 */
export function espRestartCommandPath(uid) {
  return `${userRoot(uid)}/commands/restart`;
}

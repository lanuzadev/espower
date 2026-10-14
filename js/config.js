import "./background.js";
import { auth, db } from "./firebase-config.js";
import { configurePath, userRoot, espRestartCommandPath } from "./firebase-paths.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { ref, get, set, remove } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";

let uid = null;

function lucideRefresh() {
  if (window.lucide) window.lucide.createIcons();
}

function setSidebarIdentity(email = "") {
  const sidebarEmail = document.getElementById("sidebarUserEmail");
  if (sidebarEmail) sidebarEmail.textContent = email || "Sin autenticar";
}

function setSystemStatus(text) {
  const el = document.getElementById("systemStatusText");
  if (el) el.textContent = text;
}

function initSidebar() {
  const shell = document.getElementById("appShell");
  const openBtn = document.getElementById("sidebarToggle");
  const closeBtn = document.getElementById("sidebarClose");
  const backdrop = document.getElementById("sidebarBackdrop");

  function closeSidebar() {
    shell?.classList.remove("sidebar-open");
  }
  function openSidebar() {
    shell?.classList.add("sidebar-open");
  }

  openBtn?.addEventListener("click", openSidebar);
  closeBtn?.addEventListener("click", closeSidebar);
  backdrop?.addEventListener("click", closeSidebar);
}



function numVal(id) {
  return Number.parseFloat(document.getElementById(id)?.value || "");
}

function showMessage(text, ok = false) {
  const msg = document.getElementById("configMsg");
  if (!msg) return;
  msg.textContent = text;
  msg.style.color = ok ? "#22c55e" : "#ef4444";
}

async function loadConfigure() {
  if (!uid) return;
  const snap = await get(ref(db, configurePath(uid)));
  const data = snap.exists() ? snap.val() : {};

  const defaultMinutes = Math.max(
    1,
    Math.round((Number(localStorage.getItem("displayIntervalMs")) || 15 * 60 * 1000) / 60000),
  );

  document.getElementById("cfgDataloggerMinutes").value = String(Number(data.dataloggerMinutes) || defaultMinutes);
  document.getElementById("cfgLimitKwh").value = String(Number(data.limitKwh) || 100);
  document.getElementById("cfgTarifa").value = String(Number(data.tarifa) || Number(localStorage.getItem("costPerKwh")) || 6.85);
  document.getElementById("cfgCcal").value = String(Number(data.ccalibrate) || Number(localStorage.getItem("ccalibrate")) || 1);
  document.getElementById("cfgVcal").value = String(Number(data.vcalibrate) || Number(localStorage.getItem("vcalibrate")) || 1);
  document.getElementById("cfgWmeter").value = String(Number(data.wmeter) || Number(localStorage.getItem("wmeter")) || 1);
}

async function applyConfig() {
  if (!uid) {
    showMessage("Debes iniciar sesión para guardar.");
    return;
  }

  const dataloggerMinutes = numVal("cfgDataloggerMinutes");
  const limitKwh = numVal("cfgLimitKwh");
  const tarifa = numVal("cfgTarifa");
  const ccalibrate = numVal("cfgCcal");
  const vcalibrate = numVal("cfgVcal");
  const wmeter = numVal("cfgWmeter");

  if (!Number.isFinite(dataloggerMinutes) || dataloggerMinutes < 1 || dataloggerMinutes > 1440) {
    showMessage("El rango del datalogger debe estar entre 1 y 1440 minutos.");
    return;
  }
  if (!Number.isFinite(limitKwh) || limitKwh < 10 || limitKwh > 1000) {
    showMessage("El límite de consumo debe estar entre 10 y 1000 kWh.");
    return;
  }
  if (!Number.isFinite(tarifa) || tarifa <= 0) {
    showMessage("La tarifa debe ser mayor a 0.");
    return;
  }
  if (!Number.isFinite(ccalibrate) || ccalibrate <= 0 || !Number.isFinite(vcalibrate) || vcalibrate <= 0) {
    showMessage("ccalibrate y vcalibrate deben ser mayores a 0.");
    return;
  }
  if (!Number.isFinite(wmeter) || wmeter <= 0) {
    showMessage("wmeter debe ser mayor a 0.");
    return;
  }

  const configure = {
    dataloggerMinutes: Math.round(dataloggerMinutes),
    limitKwh: Math.round(limitKwh),
    tarifa: Number(tarifa.toFixed(2)),
    ccalibrate,
    vcalibrate,
    wmeter,
  };

  await set(ref(db, configurePath(uid)), configure);

  localStorage.setItem("displayIntervalMs", String(configure.dataloggerMinutes * 60 * 1000));
  localStorage.setItem("costPerKwh", String(configure.tarifa));
  localStorage.setItem("ccalibrate", String(configure.ccalibrate));
  localStorage.setItem("vcalibrate", String(configure.vcalibrate));
  localStorage.setItem("wmeter", String(configure.wmeter));

  showMessage("Configuración aplicada correctamente.", true);
}

function setActionButtonsEnabled(enabled) {
  document.getElementById("espRestartBtn")?.toggleAttribute("disabled", !enabled);
  document.getElementById("wipeDbBtn")?.toggleAttribute("disabled", !enabled);
}

async function requestEspRestart() {
  if (!uid) {
    showMessage("Iniciá sesión para usar esta acción.");
    return;
  }
  const ok = window.confirm(
    "¿Enviar orden de reinicio al ESP32?\n\n" +
      "Se escribirá un valor en Firebase en UsersData/tu_usuario/commands/restart. " +
      "El firmware debe estar programado para leer esta ruta y reiniciar el chip.",
  );
  if (!ok) return;

  const btn = document.getElementById("espRestartBtn");
  btn?.setAttribute("disabled", "disabled");
  try {
    await set(ref(db, espRestartCommandPath(uid)), Date.now());
    showMessage("Orden de reinicio enviada. El ESP32 debe procesarla en el firmware.", true);
  } catch (e) {
    console.error(e);
    showMessage("No se pudo enviar la orden. Revisá permisos en Firebase o la conexión.");
  } finally {
    if (uid) btn?.removeAttribute("disabled");
  }
}

async function wipeUserDatabase() {
  if (!uid) {
    showMessage("Iniciá sesión para usar esta acción.");
    return;
  }
  const ok = window.confirm(
    "¿Borrar todos los datos de Firebase para tu cuenta?\n\n" +
      "Se eliminará telemetría, historial (datalog), consumos mensuales, programaciones, automatizaciones, estados de salidas, nombres de dispositivos y la configuración guardada.\n\n" +
      "Esta acción no se puede deshacer.",
  );
  if (!ok) return;

  const sure = window.confirm('Confirmá escribiendo mentalmente "sí": ¿proceder con el borrado completo?');
  if (!sure) return;

  const btn = document.getElementById("wipeDbBtn");
  btn?.setAttribute("disabled", "disabled");
  try {
    await remove(ref(db, userRoot(uid)));
    ["displayIntervalMs", "costPerKwh", "ccalibrate", "vcalibrate", "wmeter", "limitKwh"].forEach((k) =>
      localStorage.removeItem(k),
    );
    showMessage("Datos eliminados. Recargá el dashboard o volvé a aplicar la configuración aquí.", true);
  } catch (e) {
    console.error(e);
    showMessage("No se pudo borrar. Revisá las reglas de seguridad de Realtime Database (escritura en tu ruta).");
  } finally {
    if (uid) btn?.removeAttribute("disabled");
  }
}

function initAuth() {
  const authBtn = document.getElementById("authBtn");
  authBtn?.addEventListener("click", async () => {
    await signOut(auth).catch(() => {});
  });

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      uid = null;
      setSidebarIdentity("Sin autenticar");
      setSystemStatus("No autenticado");
      document.getElementById("applyConfigBtn").disabled = true;
      setActionButtonsEnabled(false);
      showMessage("Inicia sesión en el dashboard para configurar.");
      return;
    }

    uid = user.uid;
    setSidebarIdentity(user.email || "Sesión iniciada");
    setSystemStatus("Conectado");
    document.getElementById("applyConfigBtn").disabled = false;
    setActionButtonsEnabled(true);
    showMessage("");
    await loadConfigure();
  });
}

function boot() {
  initSidebar();
  initAuth();
  document.getElementById("applyConfigBtn")?.addEventListener("click", () => {
    applyConfig().catch(() => showMessage("No se pudo guardar. Intenta de nuevo."));
  });
  document.getElementById("espRestartBtn")?.addEventListener("click", () => {
    requestEspRestart().catch(() => showMessage("Error al enviar la orden."));
  });
  document.getElementById("wipeDbBtn")?.addEventListener("click", () => {
    wipeUserDatabase().catch(() => showMessage("Error al borrar datos."));
  });
  lucideRefresh();
}

document.addEventListener("DOMContentLoaded", boot);

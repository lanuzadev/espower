import "./background.js";
import { auth } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

function lucideRefresh() {
  if (window.lucide) window.lucide.createIcons();
}

function setSidebarIdentity(email = "", attempt = 0) {
  const sidebarEmail = document.getElementById("sidebarUserEmail");
  if (sidebarEmail) {
    sidebarEmail.textContent = email || "Sin autenticar";
    return;
  }
  if (attempt < 12) {
    requestAnimationFrame(() => setSidebarIdentity(email, attempt + 1));
  }
}

function setSystemStatus(text) {
  const el = document.getElementById("systemStatusText");
  if (el) el.textContent = text;
}

function initAuth() {
  const authBtn = document.getElementById("authBtn");
  authBtn?.addEventListener("click", async () => {
    await signOut(auth).catch(() => {});
  });

  onAuthStateChanged(auth, (user) => {
    if (!user) {
      setSidebarIdentity("Sin autenticar");
      setSystemStatus("No autenticado");
      return;
    }

    setSidebarIdentity(user.email || "Sesión iniciada");
    setSystemStatus("Conectado");

    // Llenar automáticamente el email en el formulario si está vacío
    const emailInput = document.getElementById("cfEmail");
    if (emailInput && !emailInput.value) {
      emailInput.value = user.email || "";
    }
  });
}

function boot() {
  initAuth();
  lucideRefresh();
}

document.addEventListener("DOMContentLoaded", boot);

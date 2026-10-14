/**
 * ESPower – sidebar.js
 * Generates and injects the shared sidebar into any page.
 * Include this script BEFORE the page-specific module so that
 * #sidebarUserEmail, #authBtn, #themeToggle are in the DOM
 * when Firebase auth callbacks run.
 *
 * Usage in any HTML:
 *   <aside class="sidebar" id="sidebar"></aside>
 *   <div class="sidebar-backdrop" id="sidebarBackdrop"></div>
 *   <script src="sidebar.js"></script>
 */
(function () {
  'use strict';

  /* ── Detect current page for active link ── */
  const currentFile = window.location.pathname.split('/').pop() || 'index.html';
  const isRoot = window.location.pathname.endsWith('index.html') || window.location.pathname.endsWith('/') || window.location.pathname === '';

  const pfx = isRoot ? 'html/' : '';
  const rootPfx = isRoot ? '' : '../';

  const NAV_LINKS = [
    { href: rootPfx + 'index.html',   icon: 'layout-dashboard', label: 'Dashboard'      },
    { href: pfx + 'devices.html', icon: 'toggle-left',       label: 'Dispositivos'   },
    { href: pfx + 'charts.html',  icon: 'bar-chart-3',       label: 'Gráficos'       },
    { href: pfx + 'config.html',  icon: 'settings',          label: 'Configuración'  },
    { href: pfx + 'contact.html', icon: 'mail',              label: 'Contacto'       },
  ];

  function navHTML() {
    return NAV_LINKS.map(({ href, icon, label }) => {
      const active = (href.endsWith(currentFile) || (currentFile === '' && href.endsWith('index.html')))
        ? ' is-active' : '';
      return `<a class="sidebar-link${active}" href="${href}">` +
             `<i data-lucide="${icon}"></i><span>${label}</span></a>`;
    }).join('');
  }

  const SIDEBAR_HTML = `
    <div class="sidebar-head">
      <a href="${rootPfx}index.html" class="sidebar-brand" aria-label="ESPower inicio">
        <div class="sidebar-logo-wrap">
          <img src="${rootPfx}assets/E.png" alt="Logo ESPower" class="sidebar-logo" />
        </div>
        <div>
          <h1 class="sidebar-title">ESPower</h1>
          <p class="sidebar-subtitle">Gestión energética</p>
        </div>
      </a>
      <button id="sidebarClose" class="icon-btn sidebar-close" type="button" aria-label="Cerrar menú">
        <i data-lucide="x"></i>
      </button>
    </div>

    <div class="sidebar-panel">
      <nav class="sidebar-nav" aria-label="Navegación principal">
        ${navHTML()}
      </nav>
    </div>

    <div class="sidebar-foot">
      <div class="sidebar-account" style="margin-bottom: 1rem">
        <div class="sidebar-user-card">
          <div class="sidebar-user-icon"><i data-lucide="shield-check"></i></div>
          <div class="sidebar-user-info">
            <div class="small muted">Sesión actual</div>
            <div class="sidebar-user-email" id="sidebarUserEmail">Sin autenticar</div>
          </div>
        </div>
        <div class="sidebar-account-actions"></div>
      </div>
      <div class="system-status sidebar-status-box">
        <p class="status-title">Estado del Sistema</p>
        <div class="status-line">
          <span class="pulse-dot" aria-hidden="true"></span>
          <span id="systemStatusText" class="muted small">—</span>
        </div>
      </div>
      <div class="sidebar-foot-row">
        <button id="themeToggle" class="sidebar-action-btn sidebar-foot-btn" type="button" aria-label="Cambiar tema" style="justify-content: center">
          <i id="themeIcon" data-lucide="sun"></i>
        </button>
        <button id="authBtn" class="sidebar-foot-btn sidebar-logout-btn" type="button" title="Cerrar sesión">
          <i data-lucide="log-out"></i>
          <span>Salir</span>
        </button>
      </div>
    </div>`;

  /* ── Inject HTML ── */
  const aside = document.getElementById('sidebar');
  if (aside) aside.innerHTML = SIDEBAR_HTML;

  /* ── Wire interactions ── */
  function initSidebar() {
    const shell    = document.getElementById('appShell');
    const backdrop = document.getElementById('sidebarBackdrop');
    const closeBtn = document.getElementById('sidebarClose');

    // Support both id conventions used across pages
    const openBtn  = document.getElementById('sidebarToggle') ||
                     document.getElementById('sidebarOpen');

    const open  = () => shell?.classList.add('sidebar-open');
    const close = () => shell?.classList.remove('sidebar-open');

    openBtn?.addEventListener('click', open);
    closeBtn?.addEventListener('click', close);
    backdrop?.addEventListener('click', close);
  }

  /* ── Theme toggle (works on all pages, even without Firebase) ── */
  function initTheme() {
    const btn  = document.getElementById('themeToggle');
    const icon = document.getElementById('themeIcon');

    function syncIcon() {
      const dark = document.documentElement.classList.contains('dark');
      icon?.setAttribute('data-lucide', dark ? 'moon' : 'sun');
      if (window.lucide) window.lucide.createIcons();
    }

    syncIcon(); // sync on inject

    btn?.addEventListener('click', () => {
      const nowDark = !document.documentElement.classList.contains('dark');
      document.documentElement.classList.toggle('dark', nowDark);
      localStorage.setItem('theme', nowDark ? 'dark' : 'light');
      syncIcon();
      window.dispatchEvent(new Event('themeChanged'));
    });
  }

  function boot() {
    initSidebar();
    initTheme();
    if (window.lucide) window.lucide.createIcons();
  }

  /* Run after DOM is ready */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();

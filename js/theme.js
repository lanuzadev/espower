/**
 * ESPower – theme.js
 * Script inicial para aplicar el modo claro/oscuro antes de renderizar la página.
 * Evita el parpadeo de contenido sin estilos (FOUC).
 */
(function () {
  const saved = localStorage.getItem('theme');
  if (saved === 'light') {
    document.documentElement.classList.remove('dark');
  } else if (saved === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    // Si no hay preferencia guardada, pero el usuario quiere que sea siempre constante o predeterminado
    // Por defecto, lo pondremos claro si el sistema es claro, o si no hay matchMedia, oscuro como pedía antes.
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (prefersDark) {
      document.documentElement.classList.add('dark');
    } else {
      // Como dijeron "en dispositivo siempre está claro", tal vez querían que por defecto fuera claro
      // O tal vez querían que el dark mode guardado funcionara en el dispositivo.
      // El script anterior forzaba dark si no había nada ('else add dark').
      // Lo dejaremos como estaba, pero con soporte al sistema si es posible.
      document.documentElement.classList.remove('dark');
    }
  }
})();

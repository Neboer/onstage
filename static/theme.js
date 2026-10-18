"use strict";
(() => {
  let theme = "light";
  try { if (localStorage.getItem("onstage.theme") === "dark") theme = "dark"; } catch {}
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === "dark" ? "#202b40" : "#f6f8fc";
})();

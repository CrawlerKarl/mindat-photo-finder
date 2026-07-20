// ==UserScript==
// @name         Mindat Multi-Mineral Finder
// @namespace    https://crawlerkarl.github.io/mindat-photo-finder/
// @version      1.0.0
// @description  Adds a button on mindat.org that opens the multi-mineral specimen finder (photos whose species list contains ALL the minerals you name).
// @author       Andrew Robbins
// @license      MIT
// @match        https://www.mindat.org/*
// @match        https://mindat.org/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* Userscript wrapper for browsers where bookmarklets are awkward or impossible
 * (Firefox for Android + Tampermonkey, iOS Safari + the "Userscripts"
 * extension, desktop userscript managers). It only adds a small floating
 * button; the finder itself loads on demand from the same repo the
 * bookmarklet uses, so both delivery paths stay in sync. */
(() => {
  "use strict";
  if (window.top !== window.self) return; // no iframes
  const BTN_ID = "mmf-launch";
  if (document.getElementById(BTN_ID)) return;

  const btn = document.createElement("button");
  btn.id = BTN_ID;
  btn.textContent = "◆ Finder";
  btn.title = "Multi-mineral specimen finder";
  btn.style.cssText = [
    "position:fixed", "bottom:18px", "right:18px", "z-index:2147482000",
    "background:#A585E8", "color:#17151C", "border:none", "border-radius:999px",
    "padding:12px 18px", "font:600 14px/1 system-ui,sans-serif", "cursor:pointer",
    "box-shadow:0 6px 24px rgba(0,0,0,.4)",
  ].join(";");
  btn.addEventListener("click", () => {
    btn.remove(); // the panel brings its own restore button
    const s = document.createElement("script");
    s.src = "https://crawlerkarl.github.io/mindat-photo-finder/intersect.js?v=" + Date.now();
    (document.body || document.documentElement).appendChild(s);
  });
  (document.body || document.documentElement).appendChild(btn);
})();

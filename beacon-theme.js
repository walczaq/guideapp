/* ────────────────────────────────────────────────────────────────────
   FIELDNOTE · BEACON THEME TOGGLE                          v1 · 2026-06
   Manual appearance control: 'auto' | 'light' | 'dark', persisted in
   localStorage. Pairs with beacon.css:

     <html class="">                       auto  (passenger follows phone,
                                                  guide defaults to dark)
     <html class="theme-light">            forced light (both roles)
     <html class="theme-dark">             forced dark  (passenger; the
                                                  guide console is already
                                                  dark unless theme-light)

   INSTALL
   1. <script src="/beacon-theme.js"></script> in <head>, after the
      beacon.css link (it must run before first paint to avoid a flash).
   2. Add an "Appearance" row to the burger menu (inside .menu-list):

        <button class="menu-item" id="menu-theme">
          <span class="menu-icon" aria-hidden="true">◐</span>
          <span class="menu-label">Appearance</span>
          <span class="menu-sub" id="menu-theme-value">Auto</span>
        </button>

      and wire it wherever menu handlers are bound:

        const themeBtn = document.getElementById('menu-theme');
        if (themeBtn) themeBtn.addEventListener('click', () => {
          document.getElementById('menu-theme-value').textContent =
            window.fieldnoteTheme.cycle();
        });

      On menu open, sync the label once:
        document.getElementById('menu-theme-value').textContent =
          window.fieldnoteTheme.label();
   ──────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  var KEY = 'fieldnote.theme';                 // 'auto' | 'light' | 'dark'
  var ORDER = ['auto', 'light', 'dark'];
  var mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function get() {
    var v = null;
    try { v = localStorage.getItem(KEY); } catch (e) {}
    return ORDER.indexOf(v) >= 0 ? v : 'auto';
  }

  /* The effective appearance, resolving 'auto' per role. */
  function effective() {
    var v = get();
    var guide = document.documentElement.classList.contains('role-guide');
    if (v !== 'auto') return v;
    if (guide) return 'dark';                          // console defaults dark
    return (mql && mql.matches) ? 'dark' : 'light';    // passenger follows phone
  }

  function themeColor() {
    var guide = document.documentElement.classList.contains('role-guide');
    if (effective() === 'dark') return guide ? '#15181a' : '#1a1814';
    return guide ? '#edefe9' : '#f1ece0';
  }

  function apply() {
    var v = get();
    var el = document.documentElement;
    el.classList.toggle('theme-light', v === 'light');
    el.classList.toggle('theme-dark', v === 'dark');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', themeColor());
  }

  function set(v) {
    if (ORDER.indexOf(v) < 0) v = 'auto';
    try { localStorage.setItem(KEY, v); } catch (e) {}
    apply();
    return v;
  }

  function cycle() {
    var next = ORDER[(ORDER.indexOf(get()) + 1) % ORDER.length];
    set(next);
    return label();
  }

  function label() {
    var v = get();
    return v === 'auto' ? 'Auto' : v === 'light' ? 'Light' : 'Dark';
  }

  if (mql && mql.addEventListener) mql.addEventListener('change', apply);

  window.fieldnoteTheme = { get: get, set: set, cycle: cycle, label: label, effective: effective, apply: apply };
  apply();   // run at parse time, before first paint
})();

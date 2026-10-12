/* =====================================================================
   utils.js — shared helpers: formatting, dates, storage, DOM, motion.
   No dashboard logic lives here.
   ===================================================================== */
(function (global) {
  'use strict';

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const nfCache = {};

  /** Indian-grouped number formatter with fixed max decimals (cached). */
  function fmtNum(n, maxDec = 1) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    const key = maxDec;
    if (!nfCache[key]) nfCache[key] = new Intl.NumberFormat('en-IN', { maximumFractionDigits: maxDec, minimumFractionDigits: 0 });
    return nfCache[key].format(n);
  }
  const fmtKg = (n, d = 1) => `${fmtNum(n, d)} KG`;
  const fmtPct = (n, d = 1) => `${(isFinite(n) ? n : 0).toFixed(d)}%`;
  function fmtCompact(n) {
    if (Math.abs(n) >= 1e5) return (n / 1e3).toFixed(0) + 'k';
    if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1) + 'k';
    return fmtNum(n, 1);
  }

  /* ---------- Dates ----------
     Records keep dates as ISO keys (YYYY-MM-DD) for sorting/filtering
     and are displayed as DD-Mon-YYYY. Source sheets use DD/MM/YYYY. */
  const pad = (n) => String(n).padStart(2, '0');
  const isoFromParts = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  function validParts(y, m, d) {
    if (!(y > 1900 && y < 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
    const dt = new Date(y, m - 1, d);
    return dt.getMonth() === m - 1;
  }

  /**
   * Parse any Excel date representation to an ISO key or '' when blank/invalid.
   * Handles Date objects, Excel serial numbers and common text formats
   * (DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, DD-Mon-YYYY, YYYY-MM-DD, with optional time).
   */
  function parseDate(v) {
    if (v === null || v === undefined || v === '') return '';
    if (v instanceof Date && !isNaN(v)) {
      // SheetJS builds Dates near local midnight, sometimes a few seconds early; nudge forward
      const d = new Date(v.getTime() + 90000);
      return isoFromParts(d.getFullYear(), d.getMonth() + 1, d.getDate());
    }
    if (typeof v === 'number' && isFinite(v)) {
      if (v > 20000 && v < 80000 && global.XLSX && XLSX.SSF) {
        const p = XLSX.SSF.parse_date_code(v);
        if (p && validParts(p.y, p.m, p.d)) return isoFromParts(p.y, p.m, p.d);
      }
      return '';
    }
    const s = String(v).trim();
    if (!s) return '';
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m && validParts(+m[1], +m[2], +m[3])) return isoFromParts(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (m) {
      let y = +m[3]; if (y < 100) y += 2000;
      if (validParts(y, +m[2], +m[1])) return isoFromParts(y, +m[2], +m[1]);         // DD/MM/YYYY (default)
      if (validParts(y, +m[1], +m[2])) return isoFromParts(y, +m[1], +m[2]);         // fallback MM/DD/YYYY
    }
    m = s.match(/^(\d{1,2})[-\s/]([A-Za-z]{3,})[-\s/,]*(\d{2,4})/);
    if (m) {
      const mi = MONTHS.findIndex((x) => x.toLowerCase() === m[2].slice(0, 3).toLowerCase());
      let y = +m[3]; if (y < 100) y += 2000;
      if (mi >= 0 && validParts(y, mi + 1, +m[1])) return isoFromParts(y, mi + 1, +m[1]);
    }
    if (/^\d+(\.\d+)?$/.test(s)) return parseDate(Number(s));
    return '';
  }

  /** ISO key → "09-Oct-2026" */
  function fmtDate(iso) {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-');
    return `${d}-${MONTHS[+m - 1]}-${y}`;
  }
  /** ISO key → "09 Oct" for chart axes */
  function fmtDateShort(iso) {
    if (!iso) return '—';
    const [, m, d] = iso.split('-');
    return `${d} ${MONTHS[+m - 1]}`;
  }
  function fmtDateTime(dt) {
    const d = dt instanceof Date ? dt : new Date(dt);
    if (isNaN(d)) return '—';
    return `${pad(d.getDate())}-${MONTHS[d.getMonth()]}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /* ---------- Misc ---------- */
  function debounce(fn, ms = 200) {
    let t;
    return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
  }
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const reducedMotion = () => global.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** localStorage wrapper that never throws (private mode, blocked storage, sandbox). */
  const store = {
    get(key, fallback = null) {
      try { const v = localStorage.getItem('awbdash:' + key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, val) {
      try { localStorage.setItem('awbdash:' + key, JSON.stringify(val)); return true; } catch (e) { return false; }
    },
    remove(key) { try { localStorage.removeItem('awbdash:' + key); } catch (e) { /* ignore */ } },
  };

  /** Animate a number inside an element (respects reduced motion). */
  function animateNumber(el, to, { decimals = 0, duration = 700, suffix = '' } = {}) {
    const from = parseFloat(el.dataset.v || '0') || 0;
    el.dataset.v = to;
    const render = (v) => { el.innerHTML = fmtNum(v, decimals) + suffix; };
    if (reducedMotion() || from === to) { render(to); return; }
    const t0 = performance.now();
    cancelAnimationFrame(el._raf);
    const step = (t) => {
      const p = Math.min(1, (t - t0) / duration);
      const e = 1 - Math.pow(1 - p, 3);
      render(from + (to - from) * e);
      if (p < 1) el._raf = requestAnimationFrame(step);
    };
    el._raf = requestAnimationFrame(step);
  }

  let toastTimer;
  function toast(msg, type = 'ok', ms = 3200) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast ' + type;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  /** Sum helper for Map<string, {kg,count}> style aggregations sorted by kg desc. */
  function sortedEntries(map, key = 'kg') {
    return Array.from(map.entries()).sort((a, b) => b[1][key] - a[1][key] || String(a[0]).localeCompare(String(b[0])));
  }

  global.U = {
    fmtNum, fmtKg, fmtPct, fmtCompact, parseDate, fmtDate, fmtDateShort, fmtDateTime,
    debounce, esc, $, $$, cssVar, reducedMotion, store, animateNumber, toast, sortedEntries, MONTHS,
  };
})(window);

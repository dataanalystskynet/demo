/* =====================================================================
   app.js — application controller. Wires the data service, filters,
   dashboard, exports and the header controls together.

   Flow:  loadExcelData() → normalizeData() → filterData()
          → calculateKPIs() → updateCharts() / updateTables()
   ===================================================================== */
(function (global) {
  'use strict';
  const { $, fmtNum, fmtDateTime, store, toast } = U;

  const App = {
    raw: null,          // last raw dataset { fileName, headers, rows, loadedAt }
    data: null,         // normalized { records, quality, ... }
    allAgg: null,       // aggregation of the full file
    filtered: [],
    lastFile: null,     // File handle for "Refresh Data"
  };

  /* ------------------------------ Theme ------------------------------ */
  const root = document.documentElement;
  const effectiveTheme = () => root.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  function setThemeIcon() { $('#themeIcon use').setAttribute('href', effectiveTheme() === 'dark' ? '#i-sun' : '#i-moon'); }
  function repaintCharts() {
    Charts.applyDefaults();
    if (App.data) recompute();
  }
  function initTheme() {
    const saved = store.get('theme');
    if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
    setThemeIcon();
    $('#btnTheme').addEventListener('click', () => {
      root.dataset.theme = effectiveTheme() === 'dark' ? 'light' : 'dark';
      store.set('theme', root.dataset.theme);
      setThemeIcon(); repaintCharts();
    });
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (!root.dataset.theme) { setThemeIcon(); repaintCharts(); } });
  }

  /** Run fn with the light theme applied to charts (used by PDF + print), then restore. */
  async function withLightCharts(fn) {
    const prev = root.dataset.theme;
    root.dataset.theme = 'light';
    Charts.applyDefaults(); Charts.setAnimate(false); Dashboard.updateCharts();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try { return await fn(); } finally {
      if (prev) root.dataset.theme = prev; else delete root.dataset.theme;
      Charts.applyDefaults(); Dashboard.updateCharts(); Charts.setAnimate(true);
    }
  }

  /* ---------------------------- Data flow ---------------------------- */
  /** Apply a raw dataset: normalize, rebuild filters/options, render. */
  function applyDataset(raw, { persist = false } = {}) {
    const data = DataService.normalizeData(raw);   // throws on missing columns
    App.raw = raw;
    App.data = data;
    App.allAgg = null;

    // full-file aggregation drives stable colours + "of total" comparisons
    const allAgg = Dashboard.calculateKPIs(data.records);
    App.allAgg = Object.assign({}, allAgg);
    Charts.setEntitySlots('hub', allAgg.hubRows.map((r) => r[0]));
    Charts.setEntitySlots('state', allAgg.stateRows.slice().sort((x, y) => y[1].count - x[1].count).map((r) => r[0]));

    Filters.setOptionsFrom(data.records);
    Dashboard.setCustomerOptions(Filters.controls.customer.options);

    $('#metaFile').textContent = data.fileName || '—';
    $('#metaUpdated').textContent = fmtDateTime(data.loadedAt);

    if (persist) {
      try {
        const json = JSON.stringify(raw);
        if (json.length < 4.5e6) store.set('dataset', raw); else store.remove('dataset');
      } catch (e) { /* ignore */ }
    }
    recompute();
  }

  /** Filter + render. Called on every filter change (no page reload). */
  function recompute() {
    if (!App.data) return;
    App.filtered = filterData(App.data.records, Filters);
    Dashboard.render(App.filtered, App.allAgg);
    renderFilterChips();
    const desc = Filters.describe();
    $('#printFilters').textContent = 'Applied filters: ' + (desc.length ? desc.map((d) => `${d.label}: ${d.full || d.text}`).join(' | ') : 'None (all records)');
    $('#printDate').textContent = 'Report date: ' + fmtDateTime(new Date()) + ' · Source: ' + (App.data.fileName || '');
  }

  /** Upload handler — loadExcelData() + applyDataset(). */
  async function handleFile(file) {
    if (!file) return;
    document.body.classList.add('busy');
    try {
      const raw = await DataService.loadExcelData({ type: 'file', file });
      raw.loadedAt = new Date().toISOString();
      Filters.resetAll();
      applyDataset(raw, { persist: true });
      App.lastFile = file;
      toast(`${fmtNum(App.data.records.length, 0)} records loaded from ${file.name}`);
    } catch (err) {
      showError(err, file.name);
    } finally {
      document.body.classList.remove('busy');
      $('#fileInput').value = '';
    }
  }

  function showError(err, name) {
    const what = err && err.missing
      ? `${name || 'This file'} cannot be used. Missing column${err.missing.length > 1 ? 's' : ''}: ${err.missing.join(', ')}. Your old data is still shown.`
      : `Could not load ${name || 'the file'}. ${err && err.message ? err.message : String(err)}`;
    toast(what, 'err', 9000);
  }

  /* ----------------------- Folder auto-load -----------------------
     When the page is opened through "Start Dashboard.bat" (server.ps1),
     the newest Excel file in the dashboard folder is loaded by itself,
     and again whenever a newer file is copied into the folder. */
  const AUTO_MS = 5000;
  const served = /^https?:$/.test(location.protocol);
  let autoSig = null;
  let autoBusy = false;
  function setAuto(on, text) {
    const el = $('#metaAuto');
    el.hidden = false; el.classList.toggle('on', on); el.textContent = text;
  }
  async function checkFolder({ force = false } = {}) {
    if (!served || autoBusy) return false;
    autoBusy = true;
    try {
      let info;
      try {
        const res = await fetch('api/latest', { cache: 'no-store' });
        if (!res.ok) throw new Error(res.statusText);
        info = await res.json();
      } catch (e) { setAuto(false, 'Auto-update stopped · run Start Dashboard.bat again'); return false; }
      setAuto(true, 'Auto-update ON · watching this folder');
      if (!info.name) return false;
      const sig = `${info.name}|${info.stamp}|${info.size}`;
      if (sig === autoSig && !force) return false;
      let buf;
      try {
        const res = await fetch('api/file?name=' + encodeURIComponent(info.name), { cache: 'no-store' });
        if (!res.ok) throw new Error(res.statusText);
        buf = await res.arrayBuffer();
      } catch (e) { return false; }   // file is still being copied; the next check tries again
      autoSig = sig;
      try {
        const raw = DataService.parseWorkbook(buf, info.name);
        raw.loadedAt = new Date().toISOString();
        Filters.resetAll();
        applyDataset(raw);
        App.lastFile = null;
        toast(`${fmtNum(App.data.records.length, 0)} records loaded from ${info.name}`);
        return true;
      } catch (err) { showError(err, info.name); return false; }
    } finally { autoBusy = false; }
  }

  /** Refresh: re-read the folder / the last uploaded file if possible, else recalculate. */
  async function refresh() {
    if (!App.lastFile && await checkFolder({ force: true })) return;
    if (App.lastFile) {
      try {
        const raw = await DataService.loadExcelData({ type: 'file', file: App.lastFile });
        raw.loadedAt = new Date().toISOString();
        applyDataset(raw, { persist: true });
        toast('Data updated from ' + App.lastFile.name);
        return;
      } catch (e) {
        toast('Could not read the file again. Please upload it again.', 'err', 4200);
        return;
      }
    }
    if (App.raw) {
      App.raw.loadedAt = new Date().toISOString();
      applyDataset(App.raw);
      toast('Dashboard updated');
    }
  }

  /* --------------------------- Upload wiring --------------------------- */
  function initUpload() {
    const input = $('#fileInput');
    const open = () => input.click();
    $('#btnUpload').addEventListener('click', open);
    input.addEventListener('change', () => handleFile(input.files[0]));

    // page-wide drag & drop
    const veil = $('#dragVeil');
    let depth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; veil.hidden = false; });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) veil.hidden = true; });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; veil.hidden = true;
      handleFile(e.dataTransfer.files[0]);
    });
  }

  /* ---------------------------- Header ---------------------------- */
  function initHeader() {
    $('#btnRefresh').addEventListener('click', refresh);
    $('#btnFullscreen').addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch (e) { toast('Full screen does not work here', 'err'); }
    });
    document.addEventListener('fullscreenchange', () => $('#btnFullscreen use').setAttribute('href', '#i-expand'));

    $('#btnExportReport').addEventListener('click', async () => {
      if (!App.filtered.length) { toast('There is no data to export. Change the filters first.', 'err'); return; }
      document.body.classList.add('busy');
      toast('Making the PDF report…', 'ok', 8000);
      try {
        await Exporter.exportPDF({
          agg: Dashboard.last.agg, records: App.filtered, filters: Filters.describe(), fileName: App.data.fileName,
          captureCharts: () => withLightCharts(async () => {
            const out = {};
            Object.entries(Charts.instances).forEach(([id, ch]) => {
              if (ch.canvas && ch.canvas.width) out[id] = { img: ch.toBase64Image('image/png', 1), w: ch.canvas.width, h: ch.canvas.height };
            });
            return out;
          }),
        });
      } catch (e) { console.error(e); toast('Could not make the PDF: ' + e.message, 'err', 5000); }
      finally { document.body.classList.remove('busy'); }
    });

    // Print: the browser dialog is unavailable inside embedded previews; hide there.
    const framed = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();
    const printBtn = $('#btnPrint');
    if (framed) printBtn.hidden = true;
    printBtn.addEventListener('click', () => window.print());
    let printPrev = null;
    window.addEventListener('beforeprint', () => {
      printPrev = root.dataset.theme || '';
      root.dataset.theme = 'light'; Charts.applyDefaults(); Charts.setAnimate(false); Dashboard.updateCharts();
      Object.values(Charts.instances).forEach((c) => c.resize());
    });
    window.addEventListener('afterprint', () => {
      if (printPrev) root.dataset.theme = printPrev; else delete root.dataset.theme;
      Charts.applyDefaults(); Dashboard.updateCharts(); Charts.setAnimate(true);
      Object.values(Charts.instances).forEach((c) => c.resize());
    });

    $('#btnExportXlsx').addEventListener('click', () => Exporter.exportFilteredData('xlsx', App.filtered));
    $('#btnExportCsv').addEventListener('click', () => Exporter.exportFilteredData('csv', App.filtered));
  }

  /* ---------------------- Chart click-to-filter ---------------------- */
  const KIND_TO_FILTER = { hub: 'hub', dest: 'dest', customer: 'customer', state: 'state' };
  const KIND_LABEL = { hub: 'Origin Hub', dest: 'Destination', customer: 'Customer', state: 'AWB State' };
  function onChartClick(kind, value) {
    const id = KIND_TO_FILTER[kind];
    const c = Filters.controls[id];
    const clearing = c.selected.has(value) && c.selected.size === 1;
    Filters.toggle(id, value);
    toast(clearing ? `${KIND_LABEL[kind]} filter removed` : `Showing only ${KIND_LABEL[kind]} ${value}. Click again to remove.`);
  }
  function initClickFilter() {
    const sw = $('#clickFilterToggle');
    sw.checked = store.get('clickFilter', true) !== false;
    const apply = () => { Charts.setClickHandler(sw.checked ? onChartClick : null); store.set('clickFilter', sw.checked); };
    sw.addEventListener('change', apply);
    apply();
    $('#matrixTable').addEventListener('click', (e) => {
      const td = e.target.closest('td[data-hub]');
      if (!td || !sw.checked) return;
      const h = Filters.controls.hub; const d = Filters.controls.dest;
      h.selected = new Set([td.dataset.hub]); d.selected = new Set([td.dataset.dest]);
      h.renderButton(); d.renderButton();
      recompute();
      toast(`Showing only ${td.dataset.hub} to ${td.dataset.dest}`);
    });
  }

  /* ------------------------------ Boot ------------------------------ */
  function boot() {
    initTheme();
    Charts.applyDefaults();
    Dashboard.buildKpiCards();
    Dashboard.buildTables();
    Filters.init(recompute);
    Dashboard.initViewControls(() => { Dashboard.updateCharts(); });
    initUpload();
    initHeader();
    initClickFilter();
    $('#btnResetFilters').addEventListener('click', () => { Filters.resetAll(); recompute(); toast('All filters removed'); });
    $('#btnEmptyReset').addEventListener('click', () => { Filters.resetAll(); recompute(); });

    if (!global.Chart || !global.XLSX) {
      toast('Some parts did not load. Charts and Excel reading need the internet. Please connect and reload the page.', 'err', 9000);
    }

    // Initial dataset: newest Excel in the folder (when served), else the last upload
    // saved in this browser, else the bundled Excel snapshot
    if (served) {
      setInterval(checkFolder, AUTO_MS);
      checkFolder().then(() => { if (!App.data) loadInitial(); });
    } else {
      setAuto(false, 'Auto-update OFF · open with Start Dashboard.bat');
      loadInitial();
    }
  }

  function loadInitial() {
    const saved = store.get('dataset');
    const initial = saved && saved.rows && saved.headers ? saved : global.SEED_DATASET;
    if (!initial) { toast('Upload an Excel file to start.'); return; }
    if (!initial.loadedAt) initial.loadedAt = new Date().toISOString();
    try { applyDataset(initial); }
    catch (e) {
      store.remove('dataset');
      if (global.SEED_DATASET && initial !== global.SEED_DATASET) applyDataset(global.SEED_DATASET);
      else showError(e, initial.fileName);
    }
  }

  // Public API (useful for future connectors / debugging)
  global.App = Object.assign(App, { applyDataset, recompute, refresh, handleFile, checkFolder });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(window);

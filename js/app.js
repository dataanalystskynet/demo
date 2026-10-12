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
  const served = /^https?:$/.test(location.protocol);
  let autoSig = null;
  let autoBusy = false;
  function setAuto(on, text) {
    const el = $('#metaAuto');
    el.hidden = false; el.classList.toggle('on', on); el.textContent = text;
  }

  /* On GitHub Pages there is no server.ps1, so the newest Excel file is found in the
     GitHub repository itself (public repos only). The repository is worked out from the
     page address (name.github.io/repo); set window.DASH_GITHUB_REPO = 'owner/repo' in
     index.html when the page uses its own domain. */
  const GH_API = 'https://api.github.com/repos/';
  let ghRepo = null;
  function githubRepos() {
    if (ghRepo) return [ghRepo];
    if (global.DASH_GITHUB_REPO) return [String(global.DASH_GITHUB_REPO)];
    const m = /^([^.]+)\.github\.io$/i.exec(location.hostname);
    if (!m) return [];
    const first = location.pathname.split('/')[1];
    return (first ? [`${m[1]}/${first}`] : []).concat(`${m[1]}/${m[1]}.github.io`);
  }
  const onGithub = () => githubRepos().length > 0;
  // GitHub allows 60 requests an hour without sign-in, so the repository is checked less often
  const AUTO_MS = onGithub() ? 120000 : 5000;

  /** "…12-Oct-2026-11-46-AM.xlsx" → time value; 0 when the name has no date. */
  function nameStamp(name) {
    const m = /(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:-(\d{1,2})-(\d{2})-?(AM|PM)?)?/i.exec(name);
    if (!m) return 0;
    const mi = U.MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
    if (mi < 0) return 0;
    let h = +(m[4] || 0);
    if (m[6]) h = (h % 12) + (/pm/i.test(m[6]) ? 12 : 0);
    return Date.UTC(+m[3], mi, +m[1], h, +(m[5] || 0));
  }

  /** Newest Excel file: { name, sig, url, init } or { name: null } when there is none. */
  async function latestFromGithub() {
    for (const repo of githubRepos()) {
      const res = await fetch(`${GH_API}${repo}/git/trees/HEAD?recursive=1`);
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(res.statusText);
      ghRepo = repo;
      const files = ((await res.json()).tree || [])
        .filter((t) => t.type === 'blob' && /\.(xlsx|xls)$/i.test(t.path) && !/(^|\/)~\$/.test(t.path))
        .map((t) => ({ sha: t.sha, name: t.path.split('/').pop(), stamp: nameStamp(t.path) }))
        .sort((a, b) => b.stamp - a.stamp || b.name.localeCompare(a.name));
      if (!files.length) return { name: null };
      return { name: files[0].name, sig: files[0].sha, url: `${GH_API}${repo}/git/blobs/${files[0].sha}`, init: { headers: { Accept: 'application/vnd.github.raw' } } };
    }
    throw new Error('Repository not found');
  }
  async function latestFromFolder() {
    const res = await fetch('api/latest', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.statusText);
    const info = await res.json();
    if (!info.name) return { name: null };
    return { name: info.name, sig: `${info.name}|${info.stamp}|${info.size}`, url: 'api/file?name=' + encodeURIComponent(info.name), init: { cache: 'no-store' } };
  }

  async function checkFolder({ force = false } = {}) {
    if (!served || autoBusy) return false;
    autoBusy = true;
    const github = onGithub();
    try {
      let info;
      try { info = await (github ? latestFromGithub() : latestFromFolder()); }
      catch (e) {
        setAuto(false, github ? 'Auto-update stopped · could not read the GitHub repository' : 'Auto-update stopped · run Start Dashboard.bat again');
        return false;
      }
      setAuto(true, github ? 'Auto-update ON · watching the GitHub repository' : 'Auto-update ON · watching this folder');
      if (!info.name) return false;
      if (info.sig === autoSig && !force) return false;
      let buf;
      try {
        const res = await fetch(info.url, info.init);
        if (!res.ok) throw new Error(res.statusText);
        buf = await res.arrayBuffer();
      } catch (e) { return false; }   // file is still being copied; the next check tries again
      autoSig = info.sig;
      try {
        const raw = DataService.parseWorkbook(buf, info.name);
        raw.loadedAt = new Date().toISOString();
        Filters.resetAll();
        applyDataset(raw);
        App.lastFile = null;
        toast(`${fmtNum(App.data.records.length, 0)} records loaded from ${info.name}`);
        // keep data/seed-data.js in step, so index.html opened directly shows this file too
        if (!github) fetch('api/seed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(raw) }).catch(() => {});
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
    const seed = global.SEED_DATASET;
    let initial = saved && saved.rows && saved.headers ? saved : seed;
    // a folder snapshot newer than the last upload wins
    if (initial === saved && seed && seed.loadedAt && !(saved.loadedAt >= seed.loadedAt)) initial = seed;
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

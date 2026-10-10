/* =====================================================================
   charts.js — Chart.js wrappers. Charts are created once and then
   updated in place (no destroy/re-create on every filter change).
   Colors are read from CSS tokens so both themes stay in sync.
   ===================================================================== */
(function (global) {
  'use strict';
  const { fmtNum, fmtKg, fmtPct, fmtCompact, cssVar, reducedMotion } = U;

  const instances = {};
  /** Stable entity → palette slot maps (color follows the entity, not its rank). */
  const slotMaps = { hub: new Map(), state: new Map() };
  let clickHandler = null;      // (kind, value) => void
  let animate = true;

  /* ---------- Theme ---------- */
  function theme() {
    return {
      fg: cssVar('--fg'), fg2: cssVar('--fg-2'), fg3: cssVar('--fg-3'),
      line: cssVar('--line'), lineStrong: cssVar('--line-strong'),
      accent: cssVar('--accent'), accent2: cssVar('--accent-2'), brand: cssVar('--brand'),
      surface: cssVar('--surface-solid'),
      series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => cssVar('--s' + i)),
      mono: cssVar('--font-mono') || 'monospace',
      body: cssVar('--font-body') || 'sans-serif',
    };
  }

  function applyDefaults() {
    if (!global.Chart) return;
    const t = theme();
    Chart.defaults.font.family = t.body;
    Chart.defaults.font.size = 12;
    Chart.defaults.color = t.fg2;
    Chart.defaults.borderColor = t.line;
    Chart.defaults.maintainAspectRatio = false;
    Chart.defaults.responsive = true;
    Chart.defaults.animation.duration = reducedMotion() ? 0 : 650;
  }

  /** Assign palette slots from the FULL dataset ranking (called on each data load). */
  function setEntitySlots(kind, orderedValues) {
    const m = new Map();
    orderedValues.forEach((v, i) => m.set(v, i));
    slotMaps[kind] = m;
  }
  function colorFor(kind, value, t = theme()) {
    const i = slotMaps[kind].get(value);
    if (i === undefined || i > 7) return t.fg3;
    return t.series[i];
  }

  /* ---------- Colour ramps (value → colour) ---------- */
  const RAMPS = {
    cool: ['--c-teal', '--c-blue', '--c-violet', '--c-pink'],     // destinations, matrix
    warm: ['--c-amber', '--c-orange', '--c-red', '--c-pink'],      // customers
    band: ['--c-green', '--c-teal', '--c-blue', '--c-violet', '--c-pink', '--c-orange', '--c-red'], // weight ranges
  };
  function toRgb(col) {
    col = (col || '').trim();
    if (col.startsWith('#')) { let h = col.slice(1); if (h.length === 3) h = h.split('').map((c) => c + c).join(''); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
    const m = col.match(/\d+(\.\d+)?/g); return m ? m.slice(0, 3).map(Number) : [128, 128, 128];
  }
  /** t in [0,1] → colour along a named ramp; optional alpha */
  function ramp(t, name = 'cool', alpha = 1) {
    const stops = RAMPS[name].map((v) => toRgb(cssVar(v)));
    t = Math.max(0, Math.min(1, isFinite(t) ? t : 0));
    const x = t * (stops.length - 1); const i = Math.min(stops.length - 2, Math.floor(x)); const f = x - i;
    const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
    return alpha >= 1 ? `rgb(${c.join(',')})` : `rgba(${c.join(',')},${alpha})`;
  }
  const tooltip = (t, extra = {}) => Object.assign({
    backgroundColor: t.surface,
    borderColor: t.lineStrong,
    borderWidth: 1,
    titleColor: t.fg,
    bodyColor: t.fg2,
    footerColor: t.fg3,
    titleFont: { weight: '700', size: 13 },
    bodyFont: { family: t.mono, size: 12 },
    padding: 10,
    cornerRadius: 10,
    boxPadding: 4,
    usePointStyle: true,
  }, extra);

  const axisX = (t, extra = {}) => Object.assign({ grid: { display: false }, border: { color: t.lineStrong }, ticks: { color: t.fg2 } }, extra);
  const axisY = (t, extra = {}) => Object.assign({
    beginAtZero: true, grid: { color: t.line }, border: { display: false },
    ticks: { color: t.fg3, callback: (v) => fmtCompact(v) },
  }, extra);

  /* ---------- Small plugins ---------- */
  /** Draws a soft drop shadow under donut arcs for a lifted, 3D feel. */
  const depthPlugin = {
    id: 'depth',
    beforeDatasetsDraw(chart) { const c = chart.ctx; c.save(); c.shadowColor = 'rgba(0,0,0,0.35)'; c.shadowBlur = 16; c.shadowOffsetY = 7; },
    afterDatasetsDraw(chart) { chart.ctx.restore(); },
  };
  /** Text in the hole of a donut: options.plugins.centerText = { title, value } */
  const centerTextPlugin = {
    id: 'centerText',
    afterDraw(chart, _args, opts) {
      if (!opts || !opts.value) return;
      const meta = chart.getDatasetMeta(0);
      if (!meta || !meta.data || !meta.data[0]) return;
      const { x, y } = meta.data[0];
      const inner = meta.data[0].innerRadius || 60;
      const c = chart.ctx; const t = theme();
      c.save();
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillStyle = t.fg3;
      c.font = `700 ${Math.max(9, inner * 0.16)}px ${t.body}`;
      c.fillText(opts.title || '', x, y - inner * 0.28);
      c.fillStyle = t.fg;
      c.font = `700 ${Math.max(14, inner * 0.36)}px "Barlow Condensed", ${t.body}`;
      c.fillText(opts.value, x, y + inner * 0.06);
      if (opts.sub) { c.fillStyle = t.fg3; c.font = `600 ${Math.max(9, inner * 0.15)}px ${t.body}`; c.fillText(opts.sub, x, y + inner * 0.4); }
      c.restore();
    },
  };

  const DL = () => (global.ChartDataLabels ? [global.ChartDataLabels] : []);

  /** Create or update a chart in place. */
  function upsert(id, build) {
    const canvas = document.getElementById(id);
    if (!canvas || !global.Chart) return null;
    const cfg = build();
    let ch = instances[id];
    if (ch && ch.config.type === cfg.type) {
      ch.data = cfg.data;
      ch.options = cfg.options;
      ch.update(animate ? undefined : 'none');
    } else {
      if (ch) ch.destroy();
      ch = new Chart(canvas, cfg);
      instances[id] = ch;
    }
    return ch;
  }

  function clickable(kind, labelsOrFn) {
    return {
      onClick: (_e, els, chart) => {
        if (!els.length || !clickHandler) return;
        const i = els[0].index;
        const v = typeof labelsOrFn === 'function' ? labelsOrFn(els[0], chart) : labelsOrFn[i];
        if (v !== undefined) clickHandler(kind, v);
      },
      onHover: (e, els) => { e.native && (e.native.target.style.cursor = els.length && clickHandler ? 'pointer' : 'default'); },
    };
  }

  /* =================== Individual charts =================== */

  /** Origin hub bar — rows: [[hub,{kg,count}]] sorted desc */
  function hubBar(rows) {
    upsert('chHubBar', () => {
      const t = theme();
      const labels = rows.map((r) => r[0]);
      return {
        type: 'bar',
        plugins: DL(),
        data: { labels, datasets: [{
          label: 'Chargeable Weight (KG)',
          data: rows.map((r) => r[1].kg),
          backgroundColor: labels.map((h) => colorFor('hub', h, t)),
          borderRadius: { topLeft: 6, topRight: 6 }, borderSkipped: 'bottom',
          maxBarThickness: 90, categoryPercentage: 0.7,
        }] },
        options: Object.assign({
          layout: { padding: { top: 26 } },
          plugins: {
            legend: { display: false },
            tooltip: tooltip(t, { callbacks: {
              label: (c) => ` ${fmtKg(c.raw)}`,
              afterLabel: (c) => { const r = rows[c.dataIndex][1]; return ` ${fmtNum(r.count, 0)} AWBs · avg ${fmtKg(r.kg / r.count)}`; },
            } }),
            datalabels: { anchor: 'end', align: 'end', offset: 2, color: t.fg, font: { weight: '700', family: t.mono, size: 12 }, formatter: (v) => fmtKg(v) },
          },
          scales: { x: axisX(t, { ticks: { color: t.fg, font: { weight: '700', size: 13 } } }), y: axisY(t, { title: { display: true, text: 'Chargeable Weight KG', color: t.fg3 } }) },
        }, clickable('hub', labels)),
      };
    });
  }

  /** Hub donut with total in the centre */
  function hubDonut(rows, total) {
    upsert('chHubDonut', () => {
      const t = theme();
      const labels = rows.map((r) => r[0]);
      return {
        type: 'doughnut',
        plugins: [depthPlugin, centerTextPlugin, ...DL()],
        data: { labels, datasets: [{
          data: rows.map((r) => r[1].kg),
          backgroundColor: labels.map((h) => colorFor('hub', h, t)),
          borderColor: t.surface, borderWidth: 3, hoverOffset: 12, spacing: 2,
        }] },
        options: Object.assign({
          cutout: '64%',
          layout: { padding: 12 },
          plugins: {
            legend: { position: 'bottom', labels: { color: t.fg2, usePointStyle: true, pointStyle: 'rectRounded', padding: 14,
              generateLabels: (ch) => ch.data.labels.map((l, i) => ({
                text: `${l}  ${fmtPct(total ? (ch.data.datasets[0].data[i] / total) * 100 : 0)}`,
                fillStyle: ch.data.datasets[0].backgroundColor[i], strokeStyle: 'transparent', fontColor: t.fg2,
                hidden: !ch.getDataVisibility(i), index: i,
              })) } },
            tooltip: tooltip(t, { callbacks: { label: (c) => ` ${fmtKg(c.raw)} · ${fmtPct(total ? (c.raw / total) * 100 : 0)}` } }),
            centerText: { title: 'TOTAL KG', value: fmtNum(total, 1), sub: `${rows.length} hub${rows.length === 1 ? '' : 's'}` },
            datalabels: {
              color: '#fff', font: { weight: '700', size: 12 },
              formatter: (v) => { const p = total ? (v / total) * 100 : 0; return p >= 6 ? fmtPct(p, 0) : ''; },
            },
          },
        }, clickable('hub', labels)),
      };
    });
  }

  /** Destination bar — rows desc; total for % */
  function destBar(rows, total) {
    const box = document.getElementById('destBox');
    if (box) box.style.minWidth = Math.max(0, rows.length * 34 + 80) + 'px';
    upsert('chDestBar', () => {
      const t = theme();
      const labels = rows.map((r) => r[0]);
      return {
        type: 'bar',
        plugins: DL(),
        data: { labels, datasets: [{
          label: 'Chargeable Weight (KG)', data: rows.map((r) => r[1].kg),
          backgroundColor: rows.map((r) => ramp(Math.sqrt(r[1].kg / (rows[0] ? rows[0][1].kg : 1)), 'cool')),
          hoverBackgroundColor: rows.map(() => cssVar('--c-amber')),
          borderRadius: { topLeft: 5, topRight: 5 }, borderSkipped: 'bottom', maxBarThickness: 40, categoryPercentage: 0.82,
        }] },
        options: Object.assign({
          layout: { padding: { top: 24 } },
          plugins: {
            legend: { display: false },
            tooltip: tooltip(t, { callbacks: {
              title: (c) => `Destination ${c[0].label}`,
              label: (c) => { const r = rows[c.dataIndex][1]; return [` AWB Count: ${fmtNum(r.count, 0)}`, ` Chargeable Wt: ${fmtKg(r.kg)}`, ` Average Wt: ${fmtKg(r.kg / r.count, 2)}`, ` Share: ${fmtPct(total ? (r.kg / total) * 100 : 0)}`]; },
            } }),
            datalabels: { display: (c) => c.dataIndex < 10, anchor: 'end', align: 'end', offset: 1, color: t.fg2, font: { family: t.mono, size: 10.5 }, formatter: (v) => fmtCompact(v) },
          },
          scales: { x: axisX(t, { ticks: { color: t.fg, font: { weight: '600' }, autoSkip: false, maxRotation: 0 } }), y: axisY(t) },
        }, clickable('dest', labels)),
      };
    });
  }

  /** Customer horizontal bar — rows desc */
  function custBar(rows, total) {
    const box = document.getElementById('custBox');
    if (box) box.style.height = Math.max(220, rows.length * 28 + 50) + 'px';
    upsert('chCustBar', () => {
      const t = theme();
      const labels = rows.map((r) => r[0]);
      return {
        type: 'bar',
        plugins: DL(),
        data: { labels, datasets: [{
          label: 'Chargeable Weight (KG)', data: rows.map((r) => r[1].kg),
          backgroundColor: rows.map((r) => ramp(1 - Math.sqrt(r[1].kg / (rows[0] ? rows[0][1].kg : 1)), 'warm')),
          hoverBackgroundColor: rows.map(() => cssVar('--c-violet')),
          borderRadius: { topRight: 5, bottomRight: 5 }, borderSkipped: 'left', maxBarThickness: 26, categoryPercentage: 0.72, barPercentage: 0.9,
        }] },
        options: Object.assign({
          indexAxis: 'y',
          layout: { padding: { right: 64 } },
          plugins: {
            legend: { display: false },
            tooltip: tooltip(t, { callbacks: {
              label: (c) => { const r = rows[c.dataIndex][1]; return [` ${fmtKg(r.kg)} · ${fmtPct(total ? (r.kg / total) * 100 : 0)}`, ` ${fmtNum(r.count, 0)} AWBs · avg ${fmtKg(r.kg / r.count, 2)}`]; },
            } }),
            datalabels: { anchor: 'end', align: 'end', offset: 4, color: t.fg2, font: { family: t.mono, size: 11 }, formatter: (v) => fmtKg(v) },
          },
          scales: {
            y: { grid: { display: false }, border: { color: t.lineStrong }, ticks: { color: t.fg, autoSkip: false, font: { size: 11.5 },
              callback(v) { const l = this.getLabelForValue(v); return l.length > 26 ? l.slice(0, 25) + '…' : l; } } },
            x: axisY(t, { position: 'top', title: { display: true, text: 'Chargeable Weight KG', color: t.fg3 } }),
          },
        }, clickable('customer', labels)),
      };
    });
  }

  /** Weight distribution buckets — [{label,count,kg}] ; metric 'count'|'kg' */
  function buckets(rows, metric) {
    upsert('chBucket', () => {
      const t = theme();
      const isKg = metric === 'kg';
      return {
        type: 'bar',
        plugins: DL(),
        data: { labels: rows.map((r) => r.label), datasets: [{
          label: isKg ? 'Total KG' : 'AWB Count', data: rows.map((r) => (isKg ? r.kg : r.count)),
          backgroundColor: rows.map((_r, i) => ramp(rows.length > 1 ? i / (rows.length - 1) : 0, 'band')),
          borderRadius: { topLeft: 6, topRight: 6 }, borderSkipped: 'bottom', maxBarThickness: 64,
        }] },
        options: {
          layout: { padding: { top: 24 } },
          plugins: {
            legend: { display: false },
            tooltip: tooltip(t, { callbacks: { label: (c) => { const r = rows[c.dataIndex]; return [` AWB Count: ${fmtNum(r.count, 0)}`, ` Total Wt: ${fmtKg(r.kg)}`]; } } }),
            datalabels: { anchor: 'end', align: 'end', offset: 2, color: t.fg, font: { family: t.mono, weight: '600', size: 11.5 }, formatter: (v) => (v ? (isKg ? fmtCompact(v) : fmtNum(v, 0)) : '') },
          },
          scales: { x: axisX(t, { title: { display: true, text: 'Weight range', color: t.fg3 } }), y: axisY(t, { title: { display: true, text: isKg ? 'Total KG' : 'AWB Count', color: t.fg3 } }) },
        },
      };
    });
  }

  /** AWB state donut (count share) */
  function stateDonut(rows, totalCount) {
    const sorted = rows.slice().sort((a, b) => b[1].count - a[1].count);
    upsert('chStateDonut', () => {
      const t = theme();
      const labels = sorted.map((r) => r[0]);
      return {
        type: 'doughnut',
        plugins: [depthPlugin, centerTextPlugin],
        data: { labels, datasets: [{ data: sorted.map((r) => r[1].count), backgroundColor: labels.map((s) => colorFor('state', s, t)), borderColor: t.surface, borderWidth: 2, hoverOffset: 10, spacing: 1 }] },
        options: Object.assign({
          cutout: '62%', layout: { padding: 8 },
          plugins: {
            legend: { position: 'bottom', labels: { color: t.fg2, usePointStyle: true, pointStyle: 'rectRounded', padding: 8, font: { size: 10.5 }, boxWidth: 8 } },
            tooltip: tooltip(t, { callbacks: { label: (c) => ` ${fmtNum(c.raw, 0)} AWBs · ${fmtPct(totalCount ? (c.raw / totalCount) * 100 : 0)}` } }),
            centerText: { title: 'AWBs', value: fmtNum(totalCount, 0) },
          },
        }, clickable('state', labels)),
      };
    });
  }

  /** AWB state bar (KG, desc) */
  function stateBar(rows, total) {
    upsert('chStateBar', () => {
      const t = theme();
      const labels = rows.map((r) => r[0]);
      return {
        type: 'bar',
        plugins: DL(),
        data: { labels, datasets: [{ label: 'Chargeable KG', data: rows.map((r) => r[1].kg), backgroundColor: labels.map((s) => colorFor('state', s, t)), borderRadius: { topRight: 4, bottomRight: 4 }, borderSkipped: 'left', maxBarThickness: 22, categoryPercentage: 0.72, barPercentage: 0.9 }] },
        options: Object.assign({
          indexAxis: 'y', layout: { padding: { right: 52 } },
          plugins: {
            legend: { display: false },
            tooltip: tooltip(t, { callbacks: { label: (c) => { const r = rows[c.dataIndex][1]; return [` ${fmtKg(r.kg)} · ${fmtPct(total ? (r.kg / total) * 100 : 0)}`, ` ${fmtNum(r.count, 0)} AWBs`]; } } }),
            datalabels: { anchor: 'end', align: 'end', offset: 3, color: t.fg2, font: { family: t.mono, size: 10.5 }, formatter: (v) => fmtCompact(v) },
          },
          scales: {
            y: { grid: { display: false }, border: { color: t.lineStrong }, ticks: { color: t.fg, font: { size: 10.5 }, autoSkip: false } },
            x: axisY(t, { ticks: { color: t.fg3, maxTicksLimit: 4, callback: (v) => fmtCompact(v) } }),
          },
        }, clickable('state', labels)),
      };
    });
  }

  global.Charts = {
    applyDefaults, setEntitySlots, colorFor, theme, ramp,
    hubBar, hubDonut, destBar, custBar, buckets, stateDonut, stateBar,
    setClickHandler(fn) { clickHandler = fn; },
    setAnimate(v) { animate = v; },
    instances,
    /** Re-theme every chart (after light/dark switch) by re-running the last render. */
    destroyAll() { Object.keys(instances).forEach((k) => { instances[k].destroy(); delete instances[k]; }); },
  };
})(window);

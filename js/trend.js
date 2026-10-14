/* =====================================================================
   trend.js — "Weight Inscanned per Day" chart. Groups records by inscan
   date, fills empty days with 0, and fits a straight trend line so it is
   easy to see whether daily inscan weight is going up or down.
   The date range here is its own; the other filters still apply.
   ===================================================================== */
(function (global) {
  'use strict';
  const { $, fmtNum, fmtKg, fmtDate, esc, store } = U;

  const view = Object.assign({ type: 'bar', metric: 'kg', range: 'month', from: '', to: '' }, store.get('trend', {}));
  const save = () => store.set('trend', view);
  let lastRecords = [];

  const pad = (n) => String(n).padStart(2, '0');
  const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayAt = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (iso, n) => { const d = dayAt(iso); d.setDate(d.getDate() + n); return isoOf(d); };
  const todayIso = () => isoOf(new Date());

  /** Selected range → { from, to } ISO keys ('' = open end). */
  function rangeBounds(records) { return rangeFor(view.range, view.from, view.to, records); }

  /** Named date range (today, yesterday, week, month, prevMonth, custom, all) → { from, to }. */
  function rangeFor(range, cFrom, cTo, records) {
    const today = todayIso();
    switch (range) {
      case 'today': return { from: today, to: today };
      case 'yesterday': { const y = addDays(today, -1); return { from: y, to: y }; }
      case 'week': return { from: addDays(today, -6), to: today };
      case 'month': return { from: addDays(today, -29), to: today };
      case 'prevMonth': {
        const d = new Date(); const first = new Date(d.getFullYear(), d.getMonth() - 1, 1); const last = new Date(d.getFullYear(), d.getMonth(), 0);
        return { from: isoOf(first), to: isoOf(last) };
      }
      case 'custom': return { from: cFrom || '', to: cTo || '' };
      default: {
        const days = records.map((r) => r.inscanDate).filter(Boolean).sort();
        return { from: days[0] || '', to: days[days.length - 1] || '' };
      }
    }
  }

  /**
   * Daily totals over every calendar day in the range (empty days = 0).
   * The range is cut to the dates the file covers, so days before the file
   * starts do not show as 0 and bend the trend line.
   */
  function dailySeries(records, from, to) {
    const m = new Map();
    let first = '', last = '';
    for (const r of records) {
      const k = r.inscanDate;
      if (!k) continue;
      if (!first || k < first) first = k;
      if (k > last) last = k;
      if ((from && k < from) || (to && k > to)) continue;
      let o = m.get(k); if (!o) m.set(k, (o = { kg: 0, count: 0 }));
      o.kg += r.wt; o.count++;
    }
    const start = from && from > first ? from : first;
    const end = to && to < last ? to : last;
    if (!start || !end || start > end) return [];
    const out = [];
    for (let k = start, n = 0; k <= end && n < 1500; k = addDays(k, 1), n++) {
      const o = m.get(k) || { kg: 0, count: 0 };
      out.push({ iso: k, kg: o.kg, count: o.count });
    }
    return out;
  }

  /** Least-squares straight line through the daily values. */
  function fitLine(values) {
    const n = values.length;
    if (n < 2) return null;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    values.forEach((y, x) => { sx += x; sy += y; sxy += x * y; sxx += x * x; });
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
    const icpt = (sy - slope * sx) / n;
    return { slope, points: values.map((_v, x) => Math.max(0, icpt + slope * x)) };
  }

  function render(records) {
    if (records) lastRecords = records;
    const { from, to } = rangeBounds(lastRecords);
    const days = dailySeries(lastRecords, from, to);
    const isKg = view.metric === 'kg';
    const values = days.map((d) => (isKg ? d.kg : d.count));
    const fit = fitLine(values);
    const total = days.reduce((s, d) => s + d.kg, 0);
    const count = days.reduce((s, d) => s + d.count, 0);
    const active = days.filter((d) => d.count > 0);

    $('#trendEmpty').hidden = count > 0;
    Charts.trend(days, view.type, view.metric, fit ? fit.points : null);

    const fmtV = (v) => (isKg ? fmtKg(v) : `${fmtNum(v, 0)} AWBs`);
    const stats = [];
    stats.push(`<span>Dates <b>${days.length ? (days.length === 1 ? fmtDate(days[0].iso) : `${fmtDate(days[0].iso)} – ${fmtDate(days[days.length - 1].iso)}`) : '—'}</b></span>`);
    stats.push(`<span>Total <b>${fmtKg(total)}</b> · <b>${fmtNum(count, 0)}</b> AWBs</span>`);
    if (active.length) {
      const avg = (isKg ? total : count) / active.length;
      const peak = active.reduce((a, d) => ((isKg ? d.kg : d.count) > (isKg ? a.kg : a.count) ? d : a));
      const low = active.reduce((a, d) => ((isKg ? d.kg : d.count) < (isKg ? a.kg : a.count) ? d : a));
      stats.push(`<span>Avg per inscan day <b>${fmtV(avg)}</b></span>`);
      stats.push(`<span>Highest <b>${esc(fmtDate(peak.iso))}</b> ${fmtV(isKg ? peak.kg : peak.count)}</span>`);
      if (active.length > 1) stats.push(`<span>Lowest <b>${esc(fmtDate(low.iso))}</b> ${fmtV(isKg ? low.kg : low.count)}</span>`);
    }
    if (fit && active.length > 1) {
      const mean = values.reduce((s, v) => s + v, 0) / values.length || 1;
      const flat = Math.abs(fit.slope) < mean * 0.01;
      const cls = flat ? 'flat' : fit.slope > 0 ? 'up' : 'down';
      const word = flat ? 'Steady' : fit.slope > 0 ? 'Going up' : 'Going down';
      const per = isKg ? `${fit.slope > 0 ? '+' : ''}${fmtNum(fit.slope, 1)} KG a day` : `${fit.slope > 0 ? '+' : ''}${fmtNum(fit.slope, 1)} AWBs a day`;
      stats.push(`<span class="trend-dir ${cls}">Trend <b>${word}</b> ${flat ? '' : per}</span>`);
    }
    $('#trendStats').innerHTML = stats.join('');
  }

  function syncButtons() {
    [['#trendType', 'type'], ['#trendMetric', 'metric'], ['#trendRange', 'range']].forEach(([sel, key]) => {
      document.querySelectorAll(`${sel} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === view[key]));
    });
    $('#trendCustom').hidden = view.range !== 'custom';
  }

  function init() {
    [['#trendType', 'type'], ['#trendMetric', 'metric'], ['#trendRange', 'range']].forEach(([sel, key]) => {
      $(sel).addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]'); if (!b) return;
        view[key] = b.dataset.v;
        // first time on Custom: start with the last 14 days
        if (key === 'range' && view.range === 'custom' && !view.from && !view.to) { view.from = addDays(todayIso(), -13); view.to = todayIso(); }
        save(); syncButtons();
        $('#trendFrom').value = view.from; $('#trendTo').value = view.to;
        render();
      });
    });
    const onDate = () => {
      view.from = $('#trendFrom').value; view.to = $('#trendTo').value;
      if (view.from && view.to && view.from > view.to) { const x = view.from; view.from = view.to; view.to = x; $('#trendFrom').value = view.from; $('#trendTo').value = view.to; }
      save(); render();
    };
    $('#trendFrom').addEventListener('change', onDate);
    $('#trendTo').addEventListener('change', onDate);
    $('#trendFrom').value = view.from; $('#trendTo').value = view.to;
    syncButtons();
  }

  global.Trend = { init, render, view, dailySeries, fitLine, rangeFor, todayIso, addDays };
})(window);

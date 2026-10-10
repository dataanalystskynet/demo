/* =====================================================================
   dashboard.js — calculations + rendering of KPIs, summary, matrix,
   charts and tables. All numbers come from the records
   passed in; nothing is hard-coded.
   ===================================================================== */
(function (global) {
  'use strict';
  const { fmtNum, fmtKg, fmtPct, fmtDate, esc, $, sortedEntries, animateNumber } = U;

  const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 200];

  /** View-level settings (chart toggles) — persisted per browser. */
  const view = Object.assign({
    bucketMetric: 'count',
    custTopN: '10',
    buckets: DEFAULT_BUCKETS.slice(),
  }, U.store.get('view', {}));
  const saveView = () => U.store.set('view', view);

  let custCustom = null;     // MultiSelect for the customer chart "Custom" mode
  let destHub = 'ALL';       // hub tab selected on the destination chart
  let tables = {};
  let last = { records: [], agg: null };
  let aggCache = { ref: null, agg: null };

  /* ------------------------------------------------------------------
     calculateKPIs — one pass over the records builds every aggregation
     the dashboard needs. Cached by array identity.
     ------------------------------------------------------------------ */
  function calculateKPIs(records) {
    if (aggCache.ref === records) return aggCache.agg;
    const add = (map, k, wt) => { let o = map.get(k); if (!o) { o = { kg: 0, count: 0 }; map.set(k, o); } o.kg += wt; o.count++; return o; };
    const a = {
      count: records.length, total: 0, min: Infinity, max: -Infinity, maxRec: null, minRec: null,
      customers: new Map(), hubs: new Map(), dests: new Map(), states: new Map(),
      inscanDays: new Map(),
      matrix: new Map(), lanes: new Map(),
    };
    for (const r of records) {
      const w = r.wt;
      a.total += w;
      if (w > a.max) { a.max = w; a.maxRec = r; }
      if (w < a.min) { a.min = w; a.minRec = r; }
      add(a.customers, r.customer, w);
      add(a.hubs, r.hub, w);
      add(a.dests, r.dest, w);
      add(a.states, r.state, w);
      if (r.inscanDate) add(a.inscanDays, r.inscanDate, w);
      let mx = a.matrix.get(r.hub); if (!mx) a.matrix.set(r.hub, (mx = new Map()));
      mx.set(r.dest, (mx.get(r.dest) || 0) + w);
      add(a.lanes, r.hub + ' → ' + r.dest, w);
    }
    if (!records.length) { a.min = 0; a.max = 0; }
    a.avg = a.count ? a.total / a.count : 0;
    a.hubRows = sortedEntries(a.hubs);
    a.destRows = sortedEntries(a.dests);
    a.custRows = sortedEntries(a.customers);
    a.stateRows = sortedEntries(a.states);
    a.laneRows = sortedEntries(a.lanes);
    aggCache = { ref: records, agg: a };
    return a;
  }

  /* ------------------------------ KPIs ------------------------------ */
  const KPI_DEFS = [
    { id: 'total', label: 'Total Chargeable Weight', hero: true, tone: 'red', icon: 'i-kg' },
    { id: 'awbs', label: 'Total AWBs', tone: 'blue', icon: 'i-box' },
    { id: 'avg', label: 'Average Weight', tone: 'teal', icon: 'i-avg' },
    { id: 'max', label: 'Maximum Weight', tone: 'orange', icon: 'i-up' },
    { id: 'min', label: 'Minimum Weight', tone: 'green', icon: 'i-down' },
    { id: 'customers', label: 'Customers', tone: 'violet', icon: 'i-users' },
    { id: 'hubs', label: 'Origin Hubs', tone: 'pink', icon: 'i-hub' },
    { id: 'dests', label: 'Destinations', tone: 'cyan', icon: 'i-globe' },
    { id: 'states', label: 'AWB States', tone: 'amber', icon: 'i-flag' },
  ];

  function buildKpiCards() {
    const grid = $('#kpiGrid');
    grid.innerHTML = KPI_DEFS.map((k) => `
      <article class="kpi${k.hero ? ' hero' : ''}" data-kpi="${k.id}" style="--kc:var(--c-${k.tone})">
        ${k.hero ? '' : `<span class="kpi-icon"><svg><use href="#${k.icon}"/></svg></span>`}
        <div>
          ${k.hero ? '<div class="hero-top">' : ''}<div class="kpi-label"><i></i>${esc(k.label)}</div>${k.hero ? '<div class="hero-date"><span>Inscan Date</span><b data-inscan>—</b></div></div>' : ''}
          <div class="kpi-value" data-val>0</div>
          <div class="kpi-sub" data-sub></div>
        </div>
        ${k.hero ? '<div><div class="hero-split" data-split></div><div class="hero-legend" data-legend></div></div>' : ''}
      </article>`).join('');
    // subtle 3D tilt that follows the pointer
    if (!U.reducedMotion()) {
      grid.querySelectorAll('.kpi').forEach((card) => {
        card.addEventListener('pointermove', (e) => {
          const r = card.getBoundingClientRect();
          const px = (e.clientX - r.left) / r.width - 0.5; const py = (e.clientY - r.top) / r.height - 0.5;
          const amp = card.classList.contains('hero') ? 3 : 7;
          card.style.transform = `translateY(-4px) rotateX(${(-py * amp).toFixed(2)}deg) rotateY(${(px * amp).toFixed(2)}deg)`;
          card.style.setProperty('--mx', `${(px + 0.5) * 100}%`); card.style.setProperty('--my', `${(py + 0.5) * 100}%`);
        });
        card.addEventListener('pointerleave', () => { card.style.transform = ''; });
        card.addEventListener('pointerenter', () => {
          const el = card.querySelector('[data-val]'); const v = parseFloat(el.dataset.v || '0');
          el.dataset.v = 0; animateNumber(el, v, { decimals: +el.dataset.dec || 0, suffix: el.dataset.suffix || '', duration: 450 });
        });
      });
    }
  }

  function setKpi(id, value, { decimals = 0, unit = '', sub = '' } = {}) {
    const card = document.querySelector(`[data-kpi="${id}"]`);
    if (!card) return;
    const el = card.querySelector('[data-val]');
    const suffix = unit ? `<small>${unit}</small>` : '';
    el.dataset.dec = decimals; el.dataset.suffix = suffix;
    animateNumber(el, value, { decimals, suffix });
    card.querySelector('[data-sub]').innerHTML = sub;
  }

  function updateKPIs(a, all) {
    const pctOfAll = all && all.total ? (a.total / all.total) * 100 : 100;
    setKpi('total', a.total, { decimals: 1, unit: 'KG', sub: a.count === (all ? all.count : a.count) ? 'All records' : `${fmtPct(pctOfAll)} of the total ${fmtKg(all.total)}` });
    setKpi('awbs', a.count, { sub: all && a.count !== all.count ? `out of ${fmtNum(all.count, 0)} in total` : 'Shipments scanned' });
    setKpi('avg', a.avg, { decimals: 2, unit: 'KG', sub: 'For each AWB' });
    setKpi('max', a.max, { decimals: 1, unit: 'KG', sub: a.maxRec ? `AWB ${esc(a.maxRec.awb)}` : '' });
    setKpi('min', a.min, { decimals: 1, unit: 'KG', sub: a.minRec ? `AWB ${esc(a.minRec.awb)}` : '' });
    setKpi('customers', a.customers.size, { sub: a.custRows[0] ? `Top: ${esc(a.custRows[0][0])}` : '' });
    setKpi('hubs', a.hubs.size, { sub: a.hubRows.map((h) => h[0]).slice(0, 4).join(' · ') });
    setKpi('dests', a.dests.size, { sub: a.destRows[0] ? `Top: ${esc(a.destRows[0][0])}` : '' });
    setKpi('states', a.states.size, { sub: a.stateRows[0] ? `Most weight: ${esc(a.stateRows[0][0])}` : '' });

    // hero: inscan date (or first – last date) of the shown records, then split bar by hub
    const hero = document.querySelector('[data-kpi="total"]');
    const days = Array.from(a.inscanDays.keys()).sort();
    hero.querySelector('[data-inscan]').textContent = !days.length ? '—'
      : days.length === 1 ? fmtDate(days[0]) : `${fmtDate(days[0])} – ${fmtDate(days[days.length - 1])}`;
    const t = Charts.theme();
    hero.querySelector('[data-split]').innerHTML = a.hubRows.map(([h, o]) => `<span title="${esc(h)} ${fmtKg(o.kg)}" style="flex:${o.kg || 0.0001};background:${Charts.colorFor('hub', h, t)}"></span>`).join('');
    hero.querySelector('[data-legend]').innerHTML = a.hubRows.slice(0, 6).map(([h, o]) => `<span><i style="background:${Charts.colorFor('hub', h, t)}"></i>${esc(h)} <b>${fmtKg(o.kg)}</b></span>`).join('');

    $('#metaFilteredCount').textContent = fmtNum(a.count, 0);
    $('#metaFilteredKg').textContent = fmtKg(a.total);
  }

  /* -------------------------- Executive summary -------------------------- */
  function updateSummary(a) {
    if (!a.count) { $('#summaryList').innerHTML = ''; return; }
    const pct = (v) => fmtPct(a.total ? (v / a.total) * 100 : 0);
    const [hub, hubO] = a.hubRows[0];
    const [cust, custO] = a.custRows[0];
    const [dest, destO] = a.destRows[0];
    const [lane, laneO] = a.laneRows[0];
    const [stateTop, stateO] = a.stateRows.slice().sort((x, y) => y[1].count - x[1].count)[0];
    const top10 = a.custRows.slice(0, 10).reduce((s, r) => s + r[1].kg, 0);
    const heavy = (last.records || []).filter((r) => r.wt >= 100).length;
    const items = [
      ['Total', `Total weight is <b>${fmtKg(a.total)}</b> from <b>${fmtNum(a.count, 0)} AWBs</b>. Average weight is <b>${fmtKg(a.avg, 2)}</b> per AWB.`],
      ['Hub', `<b>${esc(hub)}</b> hub has the most weight: <b>${fmtKg(hubO.kg)}</b> (${pct(hubO.kg)}) from ${fmtNum(hubO.count, 0)} AWBs.`],
      ['Customer', `The top customer is <b>${esc(cust)}</b> with <b>${fmtKg(custO.kg)}</b> from ${fmtNum(custO.count, 0)} AWBs (${pct(custO.kg)}).`],
      ['Destination', `<b>${esc(dest)}</b> is the top destination with <b>${fmtKg(destO.kg)}</b> (${pct(destO.kg)}) from ${fmtNum(destO.count, 0)} AWBs.`],
      ['Heaviest', `The heaviest AWB is <b>${esc(a.maxRec.awb)}</b> with <b>${fmtKg(a.max)}</b>. Customer: ${esc(a.maxRec.customer)}. Route: ${esc(a.maxRec.hub)} to ${esc(a.maxRec.dest)}.`],
      ['Route', `The busiest route is <b>${esc(lane.replace(' → ', ' to '))}</b> with <b>${fmtKg(laneO.kg)}</b> (${pct(laneO.kg)}).`],
      ['Top ' + Math.min(10, a.custRows.length), `The top ${Math.min(10, a.custRows.length)} customers give <b>${pct(top10)}</b> of all weight. ${fmtNum(heavy, 0)} AWB${heavy === 1 ? ' is' : 's are'} 100 KG or more.`],
      ['State', `Most AWBs are in <b>${esc(stateTop)}</b> state: ${fmtNum(stateO.count, 0)} AWBs (${fmtPct((stateO.count / a.count) * 100)}).`],
    ];
    const tones = ['red', 'pink', 'violet', 'cyan', 'orange', 'blue', 'green', 'amber'];
    $('#summaryList').innerHTML = items.map(([t, s], i) => `<li style="--tc:var(--c-${tones[i % tones.length]})"><span class="tag">${t}</span><span>${s}</span></li>`).join('');
  }

  /* ------------------------------ Matrix ------------------------------ */
  function updateMatrix(a) {
    const hubs = a.hubRows.map((r) => r[0]);
    const dests = a.destRows.map((r) => r[0]);
    let max = 0;
    a.matrix.forEach((m) => m.forEach((v) => { if (v > max) max = v; }));
    const tbl = $('#matrixTable');
    const head = `<thead><tr><th>Hub \\ Dest</th>${dests.map((d) => `<th>${esc(d)}</th>`).join('')}<th class="tot">Total</th></tr></thead>`;
    const body = hubs.map((h) => {
      const row = a.matrix.get(h) || new Map();
      return `<tr><th scope="row">${esc(h)}</th>${dests.map((d) => {
        const v = row.get(d) || 0;
        if (!v) return '<td class="zero">·</td>';
        const k = Math.sqrt(v / max);   // sqrt scale keeps small lanes visible
        const bg = Charts.ramp(k, 'cool', 0.28 + k * 0.72);
        const ink = k > 0.45 ? '#ffffff' : 'var(--fg)';
        return `<td style="background:${bg};color:${ink}" data-hub="${esc(h)}" data-dest="${esc(d)}" title="${esc(h)} → ${esc(d)}: ${fmtKg(v)}">${fmtNum(v, 1)}</td>`;
      }).join('')}<td class="tot">${fmtNum(a.hubs.get(h).kg, 1)}</td></tr>`;
    }).join('');
    const foot = `<tr><th class="tot" scope="row">Total</th>${dests.map((d) => `<td class="tot">${fmtNum(a.dests.get(d).kg, 1)}</td>`).join('')}<td class="tot">${fmtNum(a.total, 1)}</td></tr>`;
    tbl.innerHTML = head + `<tbody>${body}${foot}</tbody>`;
    const mm = document.getElementById('matrixMax'); if (mm) mm.textContent = fmtKg(max);
  }

  /* ------------------------------ Charts ------------------------------ */
  function bucketize(records, edges) {
    const e = edges.slice().sort((x, y) => x - y);
    const labels = [];
    for (let i = 0; i <= e.length; i++) {
      const lo = i === 0 ? 0 : e[i - 1];
      labels.push(i === e.length ? `${fmtNum(lo, 1)}+ KG` : `${fmtNum(lo, 1)}–${fmtNum(e[i], 1)} KG`);
    }
    const out = labels.map((l) => ({ label: l, count: 0, kg: 0 }));
    for (const r of records) {
      let i = 0; while (i < e.length && r.wt > e[i]) i++;    // upper edge inclusive: 5 KG falls in 0–5
      out[i].count++; out[i].kg += r.wt;
    }
    return out;
  }

  function customerRows(a) {
    const n = view.custTopN;
    if (n === 'ALL') return a.custRows;
    if (n === 'CUSTOM') {
      const sel = custCustom ? custCustom.selected : new Set();
      return sel.size ? a.custRows.filter((r) => sel.has(r[0])) : a.custRows.slice(0, 10);
    }
    return a.custRows.slice(0, parseInt(n, 10));
  }

  /** Destination rows for the hub tab picked on the destination chart (ALL = every hub). */
  function destView(a, records) {
    if (destHub !== 'ALL' && !a.hubs.has(destHub)) destHub = 'ALL';
    if (destHub === 'ALL') return { rows: a.destRows, total: a.total, count: a.count };
    const m = new Map(); let total = 0; let count = 0;
    for (const r of records) {
      if (r.hub !== destHub) continue;
      let o = m.get(r.dest); if (!o) m.set(r.dest, (o = { kg: 0, count: 0 }));
      o.kg += r.wt; o.count++; total += r.wt; count++;
    }
    return { rows: sortedEntries(m), total, count };
  }

  function updateDestTabs(a) {
    const t = Charts.theme();
    const tab = (v, label, dot) => `<button type="button" role="tab" data-v="${esc(v)}" aria-selected="${destHub === v}" class="${destHub === v ? 'on' : ''}">${dot ? `<i style="background:${dot}"></i>` : ''}${esc(label)}</button>`;
    $('#destHubTabs').innerHTML = tab('ALL', 'All Hubs') + a.hubRows.map(([h]) => tab(h, h, Charts.colorFor('hub', h, t))).join('');
  }

  function updateCharts(a, records) {
    Charts.hubBar(a.hubRows);
    Charts.hubDonut(a.hubRows, a.total);
    const d = destView(a, records);
    updateDestTabs(a);
    Charts.destBar(d.rows, d.total);
    Charts.custBar(customerRows(a), a.total);
    Charts.buckets(bucketize(records, view.buckets), view.bucketMetric);
    Charts.stateDonut(a.stateRows, a.count);
    Charts.stateBar(a.stateRows, a.total);

    $('#destStats').innerHTML = `<span>Destinations <b>${d.rows.length}</b></span><span>AWBs <b>${fmtNum(d.count, 0)}</b></span><span>Total <b>${fmtKg(d.total)}</b></span>${d.rows[0] ? `<span>Top <b>${esc(d.rows[0][0])}</b> ${fmtPct(d.total ? (d.rows[0][1].kg / d.total) * 100 : 0)}</span>` : ''}`;
  }

  /* ------------------------------ Tables ------------------------------ */
  const wtCell = (v, max) => `<div class="wt-cell"><span class="num">${fmtNum(v, 2)}</span><span class="wt-bar"><i style="width:${max ? Math.max(2, (v / max) * 100) : 0}%"></i></span></div>`;
  const rankCell = (n) => `<span class="rank${n <= 3 ? ' top r' + n : ''}">${n}</span>`;

  function buildTables() {
    tables.cust = new DataTable($('#tblCust'), {
      exportName: 'top_customers',
      searchPlaceholder: 'Search customers…',
      defaultSort: { key: 'kg', dir: 'desc' },
      searchKeys: ['name'],
      columns: [
        { key: '_rank', label: 'Rank', render: (r) => rankCell(r._rank) },
        { key: 'name', label: 'Customer Name', cls: 'wrap' },
        { key: 'count', label: 'AWB Count', align: 'r', render: (r) => `<span class="num">${fmtNum(r.count, 0)}</span>` },
        { key: 'kg', label: 'Chargeable Weight KG', align: 'r', render: (r) => wtCell(r.kg, tables.cust._max), exportValue: (r) => +r.kg.toFixed(2) },
        { key: 'avg', label: 'Avg Weight KG', align: 'r', render: (r) => `<span class="num">${fmtNum(r.avg, 2)}</span>`, exportValue: (r) => +r.avg.toFixed(2) },
        { key: 'pct', label: '% Contribution', align: 'r', render: (r) => `<span class="num">${fmtPct(r.pct, 2)}</span>`, exportValue: (r) => +r.pct.toFixed(2) },
      ],
    });
    tables.dest = new DataTable($('#tblDest'), {
      exportName: 'destination_performance',
      searchPlaceholder: 'Search destination…',
      defaultSort: { key: 'kg', dir: 'desc' },
      searchKeys: ['name'],
      pageSize: 10,
      columns: [
        { key: '_rank', label: 'Rank', render: (r) => rankCell(r._rank) },
        { key: 'name', label: 'Destination Code', cls: 'mono' },
        { key: 'count', label: 'Total AWBs', align: 'r', render: (r) => `<span class="num">${fmtNum(r.count, 0)}</span>` },
        { key: 'kg', label: 'Total KG', align: 'r', render: (r) => wtCell(r.kg, tables.dest._max), exportValue: (r) => +r.kg.toFixed(2) },
        { key: 'avg', label: 'Avg Weight KG', align: 'r', render: (r) => `<span class="num">${fmtNum(r.avg, 2)}</span>`, exportValue: (r) => +r.avg.toFixed(2) },
        { key: 'pct', label: '% Contribution', align: 'r', render: (r) => `<span class="num">${fmtPct(r.pct, 2)}</span>`, exportValue: (r) => +r.pct.toFixed(2) },
      ],
    });
    tables.awb = new DataTable($('#tblAwb'), {
      exportName: 'chargeable_weight_analysis',
      searchPlaceholder: 'Search AWB, customer, destination…',
      defaultSort: { key: 'wt', dir: 'desc' },
      pageSizes: [25, 50, 100, 250],
      pageSize: 25,
      searchKeys: ['awb', 'customer', 'dest', 'hub', 'state'],
      columns: [
        { key: '_rank', label: 'Rank', render: (r) => rankCell(r._rank) },
        { key: 'awb', label: 'AWB Number', cls: 'mono', render: (r) => `${esc(r.awb)}${r.dup ? ' <span class="pill" title="This AWB number appears more than once">DUP</span>' : ''}` },
        { key: 'customer', label: 'Customer Name' },
        { key: 'eventDate', label: 'Event Date', cls: 'mono', render: (r) => fmtDate(r.eventDate), exportValue: (r) => fmtDate(r.eventDate) },
        { key: 'state', label: 'AWB State', render: (r) => { const c = Charts.colorFor('state', r.state); return `<span class="pill" style="border-color:${c};background:color-mix(in srgb, ${c} 18%, transparent)"><span class="dot" style="background:${c}"></span>${esc(r.state)}</span>`; } },
        { key: 'inscanDate', label: 'Inscan Date', cls: 'mono', render: (r) => fmtDate(r.inscanDate), exportValue: (r) => fmtDate(r.inscanDate) },
        { key: 'dest', label: 'Destination Code', cls: 'mono' },
        { key: 'hub', label: 'Origin Hub Code', cls: 'mono' },
        { key: 'wt', label: 'Chargeable Wt.(KG.)', align: 'r', render: (r) => wtCell(r.wt, tables.awb._max) },
      ],
    });
  }

  function aggRows(entries, total) {
    return entries.map(([name, o], i) => ({ _rank: i + 1, name, count: o.count, kg: o.kg, avg: o.count ? o.kg / o.count : 0, pct: total ? (o.kg / total) * 100 : 0 }));
  }

  function updateTables(a, records) {
    const cr = aggRows(a.custRows, a.total); tables.cust._max = cr[0] ? cr[0].kg : 0; tables.cust.setRows(cr);
    const d = destView(a, records);
    $('#destTblHint').textContent = destHub === 'ALL' ? '' : `Origin hub ${destHub} only`;
    const dr = aggRows(d.rows, d.total); tables.dest._max = dr[0] ? dr[0].kg : 0; tables.dest.setRows(dr);
    const ar = records.slice().sort((x, y) => y.wt - x.wt || x.awb.localeCompare(y.awb)).map((r, i) => Object.assign({}, r, { _rank: i + 1 }));
    tables.awb._max = ar[0] ? ar[0].wt : 0;
    tables.awb.setRows(ar);
  }

  /* ------------------------------ Wiring ------------------------------ */
  function initViewControls(onChange) {
    document.querySelectorAll('.seg[data-target]').forEach((seg) => {
      const key = seg.dataset.target;
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(view[key]) === b.dataset.v));
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]'); if (!b) return;
        view[key] = b.dataset.v; saveView();
        seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        if (key === 'custTopN') $('#custCustomWrap').hidden = view.custTopN !== 'CUSTOM';
        onChange();
      });
    });
    $('#custCustomWrap').hidden = view.custTopN !== 'CUSTOM';
    // hub tabs on the destination chart: filter that chart and the destination table
    $('#destHubTabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]'); if (!b || !last.agg) return;
      destHub = b.dataset.v;
      updateCharts(last.agg, last.records); updateTables(last.agg, last.records);
    });
    custCustom = new MultiSelect($('#custCustom'), { onChange });
    const bi = $('#bucketInput');
    bi.value = view.buckets.join(',');
    const applyBuckets = () => {
      const edges = bi.value.split(/[,\s]+/).map(Number).filter((n) => isFinite(n) && n > 0);
      const uniq = Array.from(new Set(edges)).sort((x, y) => x - y);
      if (!uniq.length) { U.toast('Enter bucket edges as numbers, e.g. 5,10,25,50', 'err'); return; }
      view.buckets = uniq; bi.value = uniq.join(','); saveView(); onChange();
    };
    $('#btnBucketApply').addEventListener('click', applyBuckets);
    bi.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyBuckets(); });
  }

  /** Full render for a filtered record set. `all` = aggregation of the full file. */
  function render(records, all) {
    last.records = records;
    const a = calculateKPIs(records);
    last.agg = a;
    updateKPIs(a, all);
    const empty = records.length === 0;
    $('#emptyState').hidden = !empty;
    $('#analytics').hidden = empty;
    if (empty) return a;
    updateSummary(a);
    updateMatrix(a);
    updateCharts(a, records);
    updateTables(a, records);
    return a;
  }

  /** Customer option list for the chart's custom picker */
  function setCustomerOptions(options) { if (custCustom) custCustom.setOptions(options); }

  global.Dashboard = {
    view, calculateKPIs, buildKpiCards, buildTables, initViewControls, render,
    updateCharts: () => last.agg && updateCharts(last.agg, last.records),
    updateTables: () => last.agg && updateTables(last.agg, last.records),
    setCustomerOptions, bucketize, customerRows,
    get last() { return last; },
    get tables() { return tables; },
  };
})(window);

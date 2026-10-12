/* =====================================================================
   filters.js — filter state, searchable multi-select control,
   filterData() and active-filter chips.
   ===================================================================== */
(function (global) {
  'use strict';
  const { esc, fmtDate, $ } = U;

  /* ---------------- Searchable multi-select ---------------- */
  let openInstance = null;
  document.addEventListener('click', (e) => {
    if (openInstance && !openInstance.root.contains(e.target)) openInstance.close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openInstance) { const b = openInstance.btn; openInstance.close(); b.focus(); }
  });

  class MultiSelect {
    /**
     * @param {HTMLElement} mount
     * @param {{placeholder?:string, isDate?:boolean, onChange:Function, maxRender?:number}} opts
     */
    constructor(mount, opts) {
      this.opts = Object.assign({ placeholder: 'ALL', isDate: false, maxRender: 400 }, opts);
      this.options = [];           // [{value,label,count}]
      this.selected = new Set();
      this.range = { from: '', to: '' };
      this.query = '';
      this.root = document.createElement('div');
      this.root.className = 'ms';
      this.root.innerHTML = `
        <button type="button" class="ms-btn" aria-haspopup="listbox" aria-expanded="false">
          <span class="ms-text">ALL</span><span class="ms-count" hidden></span><svg><use href="#i-chev"/></svg>
        </button>`;
      mount.appendChild(this.root);
      this.btn = this.root.querySelector('.ms-btn');
      this.btn.addEventListener('click', (e) => { e.stopPropagation(); this.isOpen ? this.close() : this.open(); });
    }

    setOptions(options) {
      this.options = options;
      const valid = new Set(options.map((o) => o.value));
      for (const v of Array.from(this.selected)) if (!valid.has(v)) this.selected.delete(v);
      this.renderButton();
      if (this.isOpen) this.renderList();
    }

    get isActive() { return this.selected.size > 0 || !!this.range.from || !!this.range.to; }

    renderButton() {
      const text = this.root.querySelector('.ms-text');
      const count = this.root.querySelector('.ms-count');
      let label = 'ALL';
      if (this.selected.size === 1) {
        const v = Array.from(this.selected)[0];
        label = this.opts.isDate ? fmtDate(v) : v;
      } else if (this.selected.size > 1) {
        label = `${this.selected.size} selected`;
      }
      if (this.opts.isDate && (this.range.from || this.range.to)) {
        const r = `${this.range.from ? fmtDate(this.range.from) : '…'} → ${this.range.to ? fmtDate(this.range.to) : '…'}`;
        label = this.selected.size ? `${label} · ${r}` : r;
      }
      text.textContent = label;
      count.hidden = this.selected.size < 2;
      count.textContent = this.selected.size;
      this.root.classList.toggle('active', this.isActive);
    }

    open() {
      if (openInstance && openInstance !== this) openInstance.close();
      openInstance = this;
      this.isOpen = true;
      this.root.classList.add('open');
      this.btn.setAttribute('aria-expanded', 'true');
      const p = document.createElement('div');
      p.className = 'ms-panel';
      const dates = this.options.map((o) => o.value).filter(Boolean).sort();
      p.innerHTML = `
        ${this.opts.isDate ? `<div class="ms-range">
            <label>From<input type="date" class="ms-from" value="${this.range.from}" min="${dates[0] || ''}" max="${dates[dates.length - 1] || ''}"></label>
            <label>To<input type="date" class="ms-to" value="${this.range.to}" min="${dates[0] || ''}" max="${dates[dates.length - 1] || ''}"></label>
          </div>` : ''}
        <input type="search" class="ms-search" placeholder="Type to search" value="${esc(this.query)}" aria-label="Search options">
        <div class="ms-actions"><button type="button" data-a="all">Select all</button><button type="button" data-a="clear">Clear</button></div>
        <div class="ms-list" role="listbox" aria-multiselectable="true"></div>`;
      p.addEventListener('click', (e) => e.stopPropagation());
      this.root.appendChild(p);
      this.panel = p;
      // keep panel on-screen
      const rect = p.getBoundingClientRect();
      if (rect.right > window.innerWidth - 8) p.classList.add('align-right');

      const search = p.querySelector('.ms-search');
      search.addEventListener('input', U.debounce(() => { this.query = search.value; this.renderList(); }, 120));
      p.querySelector('[data-a="all"]').addEventListener('click', () => {
        this.visible().forEach((o) => this.selected.add(o.value));
        this.changed();
      });
      p.querySelector('[data-a="clear"]').addEventListener('click', () => {
        this.selected.clear(); this.range = { from: '', to: '' };
        p.querySelectorAll('input[type=date]').forEach((i) => (i.value = ''));
        this.changed();
      });
      p.querySelector('.ms-list').addEventListener('change', (e) => {
        const cb = e.target.closest('input[type=checkbox]');
        if (!cb) return;
        cb.checked ? this.selected.add(cb.value) : this.selected.delete(cb.value);
        this.changed(false);
      });
      if (this.opts.isDate) {
        p.querySelector('.ms-from').addEventListener('change', (e) => { this.range.from = e.target.value; this.changed(false); });
        p.querySelector('.ms-to').addEventListener('change', (e) => { this.range.to = e.target.value; this.changed(false); });
      }
      this.renderList();
      if (!matchMedia('(pointer: coarse)').matches) search.focus();
    }

    visible() {
      const q = this.query.trim().toLowerCase();
      if (!q) return this.options;
      return this.options.filter((o) => o.label.toLowerCase().includes(q) || String(o.value).toLowerCase().includes(q));
    }

    renderList() {
      if (!this.panel) return;
      const list = this.panel.querySelector('.ms-list');
      const vis = this.visible();
      const shown = vis.slice(0, this.opts.maxRender);
      list.innerHTML = shown.map((o) => `
        <label class="ms-opt"><input type="checkbox" value="${esc(o.value)}" ${this.selected.has(o.value) ? 'checked' : ''}>
        <span>${esc(o.label)}</span><em>${o.count != null ? U.fmtNum(o.count, 0) : ''}</em></label>`).join('')
        + (vis.length > shown.length ? `<div class="ms-more">${vis.length - shown.length} more. Type to search.</div>` : '')
        + (vis.length === 0 ? '<div class="ms-more">Nothing found</div>' : '');
    }

    changed(rerenderList = true) {
      this.renderButton();
      if (rerenderList) this.renderList();
      this.opts.onChange && this.opts.onChange();
    }

    close() {
      this.isOpen = false;
      this.root.classList.remove('open');
      this.btn.setAttribute('aria-expanded', 'false');
      if (this.panel) { this.panel.remove(); this.panel = null; }
      if (openInstance === this) openInstance = null;
    }

    clear(silent = true) {
      this.selected.clear(); this.range = { from: '', to: '' }; this.query = '';
      this.renderButton(); if (this.isOpen) this.close();
      if (!silent) this.opts.onChange && this.opts.onChange();
    }

    /** Programmatic toggle (used by chart click-to-filter). */
    toggleValue(v) {
      if (this.selected.has(v) && this.selected.size === 1) this.selected.clear();
      else { this.selected.clear(); this.selected.add(v); }
      this.changed();
    }
  }

  /* ---------------- Filter definitions ---------------- */
  // field = record property; label used in chips/report
  const FIELDS = [
    { id: 'customer', field: 'customer', label: 'Customer', mount: '#fCustomer' },
    { id: 'eventDate', field: 'eventDate', label: 'Event Date', mount: '#fEventDate', isDate: true },
    { id: 'state', field: 'state', label: 'AWB State', mount: '#fState' },
    { id: 'inscanDate', field: 'inscanDate', label: 'Inscan Date', mount: '#fInscanDate', isDate: true },
    { id: 'dest', field: 'dest', label: 'Destination', mount: '#fDest' },
    { id: 'hub', field: 'hub', label: 'Origin Hub', mount: '#fHub' },
  ];

  const Filters = {
    controls: {},
    ranking: 'ALL',
    rankCustom: null,
    search: '',
    onChange: null,

    /** Build all filter controls once. */
    init(onChange) {
      this.onChange = onChange;
      const fire = () => this.onChange && this.onChange();
      FIELDS.forEach((f) => {
        this.controls[f.id] = new MultiSelect($(f.mount), { isDate: !!f.isDate, onChange: fire });
      });
      this.rankCustom = new MultiSelect($('#fRankCustom'), { onChange: fire });
      const rankSel = $('#fRanking');
      rankSel.addEventListener('change', () => {
        this.ranking = rankSel.value;
        $('#fRankCustomWrap').hidden = this.ranking !== 'CUSTOM';
        fire();
      });
      const search = $('#globalSearch');
      search.addEventListener('input', U.debounce(() => { this.search = search.value.trim().toLowerCase(); fire(); }, 220));
    },

    /** Rebuild option lists from the full dataset (values + counts). */
    setOptionsFrom(records) {
      const maps = {};
      FIELDS.forEach((f) => (maps[f.id] = new Map()));
      for (const r of records) for (const f of FIELDS) {
        const v = r[f.field];
        if (!v) continue;
        maps[f.id].set(v, (maps[f.id].get(v) || 0) + 1);
      }
      FIELDS.forEach((f) => {
        let entries = Array.from(maps[f.id].entries());
        entries.sort(f.isDate ? (a, b) => (a[0] < b[0] ? 1 : -1) : (a, b) => String(a[0]).localeCompare(String(b[0])));
        this.controls[f.id].setOptions(entries.map(([v, c]) => ({ value: v, label: f.isDate ? fmtDate(v) : v, count: c })));
      });
      this.rankCustom.setOptions(this.controls.customer.options);
    },

    resetAll() {
      Object.values(this.controls).forEach((c) => c.clear());
      this.rankCustom.clear();
      this.ranking = 'ALL';
      $('#fRanking').value = 'ALL';
      $('#fRankCustomWrap').hidden = true;
      this.search = '';
      $('#globalSearch').value = '';
    },

    /** Snapshot of current state (plain object) — handy for exports and connectors. */
    getState() {
      const s = { search: this.search, ranking: this.ranking, rankCustom: Array.from(this.rankCustom.selected) };
      FIELDS.forEach((f) => {
        const c = this.controls[f.id];
        s[f.id] = { values: Array.from(c.selected), from: c.range.from, to: c.range.to };
      });
      return s;
    },

    /** Human-readable list of applied filters [{id,label,text}] */
    describe() {
      const out = [];
      FIELDS.forEach((f) => {
        const c = this.controls[f.id];
        if (c.selected.size) {
          const vals = Array.from(c.selected).map((v) => (f.isDate ? fmtDate(v) : v));
          out.push({ id: f.id, label: f.label, text: vals.length > 3 ? `${vals.slice(0, 3).join(', ')} +${vals.length - 3}` : vals.join(', '), full: vals.join(', ') });
        }
        if (f.isDate && (c.range.from || c.range.to)) {
          out.push({ id: f.id + ':range', label: f.label + ' range', text: `${c.range.from ? fmtDate(c.range.from) : '…'} → ${c.range.to ? fmtDate(c.range.to) : '…'}` });
        }
      });
      if (this.ranking !== 'ALL') {
        const t = this.ranking === 'CUSTOM' ? `Custom (${this.rankCustom.selected.size || 'none'})` : `Top ${this.ranking}`;
        out.push({ id: 'ranking', label: 'Ranking', text: t });
      }
      if (this.search) out.push({ id: 'search', label: 'Search', text: `"${this.search}"` });
      return out;
    },

    clearOne(id) {
      if (id === 'ranking') { this.ranking = 'ALL'; $('#fRanking').value = 'ALL'; $('#fRankCustomWrap').hidden = true; this.rankCustom.clear(); }
      else if (id === 'search') { this.search = ''; $('#globalSearch').value = ''; }
      else if (id.endsWith(':range')) { const c = this.controls[id.split(':')[0]]; c.range = { from: '', to: '' }; c.renderButton(); }
      else if (this.controls[id]) this.controls[id].clear();
      this.onChange && this.onChange();
    },

    /** Click-to-filter from a chart: single-select toggle on a field. */
    toggle(id, value) { if (this.controls[id]) this.controls[id].toggleValue(value); },
  };

  /**
   * filterData — pure-ish filtering over the record array.
   * Field filters + date ranges + search first, then the customer-ranking cut
   * (Top N by chargeable weight within the already-filtered set, or a custom list).
   */
  function filterData(records, F = Filters) {
    const sets = {};
    const ranges = {};
    FIELDS.forEach((f) => {
      const c = F.controls[f.id];
      if (c.selected.size) sets[f.field] = c.selected;
      if (f.isDate && (c.range.from || c.range.to)) ranges[f.field] = c.range;
    });
    const setKeys = Object.keys(sets);
    const rangeKeys = Object.keys(ranges);
    const q = F.search;

    let out = records.filter((r) => {
      for (let i = 0; i < setKeys.length; i++) if (!sets[setKeys[i]].has(r[setKeys[i]])) return false;
      for (let i = 0; i < rangeKeys.length; i++) {
        const k = rangeKeys[i]; const v = r[k]; const rg = ranges[k];
        if (!v) return false;
        if (rg.from && v < rg.from) return false;
        if (rg.to && v > rg.to) return false;
      }
      if (q && r._s.indexOf(q) === -1) return false;
      return true;
    });

    if (F.ranking === 'CUSTOM') {
      const sel = F.rankCustom.selected;
      if (sel.size) out = out.filter((r) => sel.has(r.customer));
    } else if (F.ranking !== 'ALL') {
      const n = parseInt(F.ranking, 10);
      const kg = new Map();
      for (const r of out) kg.set(r.customer, (kg.get(r.customer) || 0) + r.wt);
      const top = new Set(Array.from(kg.entries()).sort((a, b) => b[1] - a[1]).slice(0, n).map((e) => e[0]));
      out = out.filter((r) => top.has(r.customer));
    }
    return out;
  }

  /** Render removable chips for active filters. */
  function renderChips() {
    const box = $('#activeChips');
    const list = Filters.describe();
    box.innerHTML = list.map((c) => `<span class="chip" title="${esc(c.full || c.text)}"><b>${esc(c.label)}</b><span>${esc(c.text)}</span>
      <button type="button" data-clear="${esc(c.id)}" aria-label="Remove ${esc(c.label)} filter"><svg><use href="#i-x"/></svg></button></span>`).join('');
  }
  $('#activeChips') && $('#activeChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-clear]');
    if (b) Filters.clearOne(b.dataset.clear);
  });

  global.MultiSelect = MultiSelect;
  global.Filters = Filters;
  global.filterData = filterData;
  global.renderFilterChips = renderChips;
})(window);

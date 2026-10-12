/* =====================================================================
   excel-reader.js — DATA SERVICE LAYER
   ---------------------------------------------------------------------
   Everything that turns a data source into clean records lives here.
   The dashboard only ever calls:
       DataService.loadExcelData(source)  → raw { fileName, headers, rows }
       DataService.normalizeData(raw)     → { records, quality, ... }

   To connect OneDrive / SharePoint / Excel Online / Google Sheets later,
   register a new source adapter that returns the same raw shape
   ({ fileName, headers: string[], rows: any[][] }), e.g.

       DataService.registerSource('graph', async ({ driveId, itemId, token }) => {
         const res = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/content`,
                                 { headers: { Authorization: `Bearer ${token}` } });
         return DataService.parseWorkbook(await res.arrayBuffer(), 'OneDrive workbook');
       });
       const raw = await DataService.loadExcelData({ type: 'graph', driveId, itemId, token });

   No other file needs to change.
   ===================================================================== */
(function (global) {
  'use strict';

  /** Canonical column definitions. `key` is the record property. */
  const REQUIRED_COLUMNS = [
    { name: 'AWB NUMBER', key: 'awb' },
    { name: 'CUSTOMER NAME', key: 'customer' },
    { name: 'EVENT DATE', key: 'eventDate' },
    { name: 'AWB STATE', key: 'state' },
    { name: 'INSCAN DATE', key: 'inscanDate' },
    { name: 'DESTINATION CODE', key: 'dest' },
    { name: 'ORIGIN HUB CODE', key: 'hub' },
    { name: 'CHARGEABLE WT.(KG.)', key: 'wt' },
  ];

  /** "ORIGIN HUB CODE\n" → "ORIGIN HUB CODE" (collapse whitespace, trim, upper-case). */
  const normalizeHeader = (h) => String(h ?? '').replace(/[\s ]+/g, ' ').trim().toUpperCase();
  /** Loose matching key: letters + digits only, so "CHARGEABLE WT (KG)" still matches. */
  const looseKey = (h) => normalizeHeader(h).replace(/[^A-Z0-9]/g, '');
  const REQUIRED_LOOSE = REQUIRED_COLUMNS.map((c) => looseKey(c.name));

  const cleanText = (v) => (v === null || v === undefined ? '' : String(v).replace(/[\s ]+/g, ' ').trim());

  /* ---------------- Source adapters ---------------- */
  const sources = {};

  /** Register a data-source adapter: async (options) => { fileName, headers, rows } */
  function registerSource(type, adapter) { sources[type] = adapter; }

  /** Local File (from <input type=file> or drag & drop). */
  registerSource('file', async ({ file }) => {
    if (!file) throw new Error('No file selected.');
    if (!/\.(xlsx|xls)$/i.test(file.name)) throw new Error(`"${file.name}" is not an Excel file. Please upload a .xlsx or .xls file.`);
    if (!global.XLSX) throw new Error('The Excel reader could not load. Please check your internet and reload the page.');
    let buf;
    try { buf = await file.arrayBuffer(); }
    catch (e) { throw new Error('Could not read this file. If you changed it after choosing it, please upload it again.'); }
    return parseWorkbook(buf, file.name);
  });

  /** Embedded raw dataset (seed / previously saved upload). */
  registerSource('raw', async ({ raw }) => raw);

  /**
   * Parse an ArrayBuffer workbook into the raw shape.
   * Detects the sheet and header row that contain the required columns.
   */
  function parseWorkbook(buffer, fileName = 'workbook.xlsx') {
    const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
    let best = null;
    for (const sheetName of wb.SheetNames) {
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '', blankrows: false });
      // Look for the header row within the first 15 rows
      for (let i = 0; i < Math.min(15, aoa.length); i++) {
        const hits = (aoa[i] || []).filter((h) => REQUIRED_LOOSE.includes(looseKey(h))).length;
        if (!best || hits > best.hits) best = { hits, sheetName, headerRow: i, aoa };
      }
      if (best && best.hits === REQUIRED_COLUMNS.length) break;
    }
    if (!best) throw new Error('This Excel file has no sheets that can be read.');
    const headers = (best.aoa[best.headerRow] || []).map((h) => String(h ?? ''));
    // Date cells → ISO date keys now, so raw data stays JSON-safe and timezone-proof
    const rows = best.aoa.slice(best.headerRow + 1).map((r) => r.map((v) => (v instanceof Date ? U.parseDate(v) : v)));
    return { fileName, sheetName: best.sheetName, headers, rows };
  }

  /** Load raw data from any registered source. */
  async function loadExcelData(source) {
    const type = source && source.type ? source.type : 'file';
    const adapter = sources[type];
    if (!adapter) throw new Error(`Unknown data source "${type}".`);
    return adapter(source);
  }

  /**
   * Validate headers and convert raw rows into clean records + a data-quality report.
   * Throws an Error with `.missing` (array of column names) when columns are absent.
   */
  function normalizeData(raw) {
    const normHeaders = raw.headers.map(normalizeHeader);
    const colIndex = {};
    REQUIRED_COLUMNS.forEach((c) => {
      const idx = normHeaders.findIndex((h) => looseKey(h) === looseKey(c.name));
      colIndex[c.key] = idx;
    });
    const missing = REQUIRED_COLUMNS.filter((c) => colIndex[c.key] < 0).map((c) => c.name);
    if (missing.length) {
      const err = new Error(`These columns are missing: ${missing.join(', ')}`);
      err.missing = missing;
      err.found = normHeaders.filter(Boolean);
      throw err;
    }

    const q = {
      totalRows: 0, validAwbs: 0, duplicateAwbs: 0, missingAwb: 0, missingCustomer: 0,
      missingDest: 0, missingHub: 0, invalidWeight: 0, blankEventDate: 0, blankInscanDate: 0, emptyRowsRemoved: 0,
    };
    const seen = new Map();
    const records = [];

    for (let r = 0; r < raw.rows.length; r++) {
      const row = raw.rows[r] || [];
      // Empty row removal
      if (!row.some((v) => cleanText(v) !== '')) { q.emptyRowsRemoved++; continue; }
      q.totalRows++;

      const get = (k) => row[colIndex[k]];
      const awb = cleanText(get('awb')).toUpperCase();
      const wtRaw = get('wt');
      let wt = typeof wtRaw === 'number' ? wtRaw : parseFloat(cleanText(wtRaw).replace(/,/g, '').replace(/kg/i, ''));
      const wtValid = isFinite(wt) && wt >= 0;
      if (!wtValid) { wt = 0; q.invalidWeight++; }

      const rec = {
        awb,
        customer: cleanText(get('customer')).toUpperCase() || '(BLANK)',
        eventDate: U.parseDate(get('eventDate')),
        state: cleanText(get('state')).toUpperCase() || '(BLANK)',
        inscanDate: U.parseDate(get('inscanDate')),
        dest: cleanText(get('dest')).toUpperCase() || '(BLANK)',
        hub: cleanText(get('hub')).toUpperCase() || '(BLANK)',
        wt: Math.round(wt * 1000) / 1000,
        wtValid,
        dup: false,
      };

      if (!awb) q.missingAwb++;
      if (rec.customer === '(BLANK)') q.missingCustomer++;
      if (rec.dest === '(BLANK)') q.missingDest++;
      if (rec.hub === '(BLANK)') q.missingHub++;
      if (!rec.eventDate) q.blankEventDate++;
      if (!rec.inscanDate) q.blankInscanDate++;

      if (awb) {
        if (seen.has(awb)) {
          q.duplicateAwbs++;
          rec.dup = true;
          records[seen.get(awb)].dup = true;
        } else {
          seen.set(awb, records.length);
        }
      }
      // Search index (lower-cased once, used by the global search)
      rec._s = `${awb} ${rec.customer} ${rec.dest} ${rec.hub} ${rec.state}`.toLowerCase();
      records.push(rec);
    }
    q.validAwbs = seen.size;
    q.blankDates = q.blankEventDate + q.blankInscanDate;

    return {
      fileName: raw.fileName,
      sheetName: raw.sheetName || '',
      records,
      quality: q,
      loadedAt: raw.loadedAt ? new Date(raw.loadedAt) : new Date(),
    };
  }

  global.DataService = {
    REQUIRED_COLUMNS,
    registerSource,
    loadExcelData,
    parseWorkbook,
    normalizeData,
    normalizeHeader,
  };
})(window);

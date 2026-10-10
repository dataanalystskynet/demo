/* =====================================================================
   export.js — CSV / Excel export of any row set, filtered-data export,
   PDF management report (jsPDF + autoTable) and print.
   ===================================================================== */
(function (global) {
  'use strict';
  const { fmtNum, fmtKg, fmtPct, fmtDate, fmtDateTime } = U;

  const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; };

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  /** columns: [{label, value:(row)=>any}] */
  function toMatrix(rows, columns) {
    return [columns.map((c) => c.label), ...rows.map((r) => columns.map((c) => { const v = c.value(r); return v === undefined || v === null ? '' : v; }))];
  }

  function exportCSV(rows, columns, name = 'export') {
    const m = toMatrix(rows, columns);
    const csv = m.map((line) => line.map((v) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\r\n');
    downloadBlob(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), `${name}_${stamp()}.csv`);
    U.toast(`Exported ${fmtNum(rows.length, 0)} rows to CSV`);
  }

  function exportExcel(rows, columns, name = 'export', sheet = 'Data') {
    if (!global.XLSX) { U.toast('Excel library not loaded', 'err'); return; }
    const ws = XLSX.utils.aoa_to_sheet(toMatrix(rows, columns));
    ws['!cols'] = columns.map((c) => ({ wch: Math.max(10, c.label.length + 2) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheet.slice(0, 31));
    XLSX.writeFile(wb, `${name}_${stamp()}.xlsx`);
    U.toast(`Exported ${fmtNum(rows.length, 0)} rows to Excel`);
  }

  /** Columns for raw filtered records — same headers as the source sheet. */
  const RECORD_COLUMNS = [
    { label: 'AWB NUMBER', value: (r) => r.awb },
    { label: 'CUSTOMER NAME', value: (r) => r.customer },
    { label: 'EVENT DATE', value: (r) => fmtDate(r.eventDate) },
    { label: 'AWB STATE', value: (r) => r.state },
    { label: 'INSCAN DATE', value: (r) => fmtDate(r.inscanDate) },
    { label: 'DESTINATION CODE', value: (r) => r.dest },
    { label: 'ORIGIN HUB CODE', value: (r) => r.hub },
    { label: 'CHARGEABLE WT.(KG.)', value: (r) => r.wt },
  ];
  function exportFilteredData(format, records) {
    const sorted = records.slice().sort((a, b) => b.wt - a.wt);
    if (format === 'csv') exportCSV(sorted, RECORD_COLUMNS, 'filtered_awb_data');
    else exportExcel(sorted, RECORD_COLUMNS, 'filtered_awb_data', 'Filtered AWBs');
  }

  /* ---------------------------- PDF report ---------------------------- */
  /**
   * @param {{agg:object, records:object[], filters:{label,text}[], fileName:string, captureCharts:Function}} ctx
   * captureCharts(): Promise<{[canvasId]: {img, w, h}}> renders charts in light theme and returns images.
   */
  async function exportPDF(ctx) {
    const jsPDFCtor = global.jspdf && global.jspdf.jsPDF;
    if (!jsPDFCtor) { U.toast('PDF library not loaded', 'err'); return; }
    const { agg: a, records, filters, fileName } = ctx;
    const images = await ctx.captureCharts();
    const doc = new jsPDFCtor({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const W = doc.internal.pageSize.getWidth(); const H = doc.internal.pageSize.getHeight();
    const M = 12;
    const NAVY = [12, 20, 48]; const RED = [214, 42, 48]; const CYAN = [8, 145, 178]; const GREY = [90, 100, 125];

    const header = (title) => {
      doc.setFillColor(...NAVY); doc.rect(0, 0, W, 22, 'F');
      doc.setFillColor(...RED); doc.rect(0, 22, W, 1.2, 'F');
      try {
        doc.setFillColor(255, 255, 255); doc.roundedRect(M - 2, 4, 40, 14.5, 2, 2, 'F');
        if (global.SKYNET_LOGO_DATA_URI) doc.addImage(global.SKYNET_LOGO_DATA_URI, 'PNG', M, 5, 36, 13.5);
      } catch (e) { /* logo optional */ }
      doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
      doc.text('AWB INSCAN ANALYTICS', M + 44, 11);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
      doc.text(title, M + 44, 16.5);
      doc.text(`Generated ${fmtDateTime(new Date())}`, W - M, 11, { align: 'right' });
      doc.text(`Source: ${fileName || '—'}`, W - M, 16.5, { align: 'right' });
      doc.setTextColor(0, 0, 0);
    };
    const footer = () => {
      const n = doc.internal.getNumberOfPages();
      for (let i = 1; i <= n; i++) {
        doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(...GREY);
        doc.text('SkyNet Worldwide Express - AWB Inscan Analytics', M, H - 6);
        doc.text(`Page ${i} of ${n}`, W - M, H - 6, { align: 'right' });
      }
    };
    const sectionTitle = (t, y) => { doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...NAVY); doc.text(t.toUpperCase(), M, y); doc.setDrawColor(...CYAN); doc.setLineWidth(0.6); doc.line(M, y + 1.5, M + 22, y + 1.5); doc.setTextColor(0, 0, 0); };
    const addChart = (id, x, y, w, h) => {
      const im = images[id]; if (!im) return;
      const r = Math.min(w / im.w, h / im.h);
      doc.addImage(im.img, 'PNG', x + (w - im.w * r) / 2, y, im.w * r, im.h * r);
    };
    const tableTheme = { headStyles: { fillColor: NAVY, textColor: 255, fontStyle: 'bold', fontSize: 8 }, bodyStyles: { fontSize: 7.8 }, alternateRowStyles: { fillColor: [242, 245, 252] }, margin: { left: M, right: M, top: 28 } };

    /* Page 1 — summary */
    header('Management report');
    let y = 30;
    doc.setFontSize(8.5); doc.setTextColor(...GREY);
    const fText = filters.length ? filters.map((f) => `${f.label}: ${f.full || f.text}`).join('   |   ') : 'None (all records)';
    const fLines = doc.splitTextToSize(`Applied filters: ${fText}`, W - 2 * M);
    doc.text(fLines, M, y); y += fLines.length * 4 + 3;

    const kpis = [
      ['Chargeable Wt', fmtKg(a.total)], ['Total AWBs', fmtNum(a.count, 0)], ['Average Wt', fmtKg(a.avg, 2)],
      ['Maximum Wt', fmtKg(a.max)], ['Minimum Wt', fmtKg(a.min)], ['Customers', fmtNum(a.customers.size, 0)],
      ['Origin Hubs', fmtNum(a.hubs.size, 0)], ['Destinations', fmtNum(a.dests.size, 0)], ['AWB States', fmtNum(a.states.size, 0)],
    ];
    const kw = (W - 2 * M - 8 * 3) / 9;
    kpis.forEach(([l, v], i) => {
      const x = M + i * (kw + 3);
      doc.setFillColor(i === 0 ? 253 : 244, i === 0 ? 236 : 247, i === 0 ? 237 : 253);
      doc.setDrawColor(i === 0 ? RED[0] : 210, i === 0 ? RED[1] : 218, i === 0 ? RED[2] : 235);
      doc.roundedRect(x, y, kw, 19, 2, 2, 'FD');
      doc.setFont('helvetica', 'normal'); doc.setFontSize(6.6); doc.setTextColor(...GREY); doc.text(l.toUpperCase(), x + 2.5, y + 5.5);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(i === 0 ? 11 : 10.5); doc.setTextColor(...NAVY); doc.text(v, x + 2.5, y + 13.5);
    });
    y += 27;

    sectionTitle('Executive summary', y); y += 7;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(30, 35, 55);
    document.querySelectorAll('#summaryList li').forEach((li) => {
      const lines = doc.splitTextToSize('•  ' + li.querySelector('span:last-child').textContent.replace(/→/g, '->').replace(/–/g, '-'), W - 2 * M);
      doc.text(lines, M, y); y += lines.length * 4.4 + 1.2;
    });
    y += 3;
    sectionTitle('Origin hub performance', y); y += 4;
    const half = (W - 2 * M - 6) / 2;
    addChart('chHubBar', M, y, half, H - y - 14);
    addChart('chHubDonut', M + half + 6, y, half, H - y - 14);

    /* Page 2 — destination */
    doc.addPage(); header('Destination performance'); y = 30;
    sectionTitle('Destination performance', y); addChart('chDestBar', M, y + 4, W - 2 * M, H - y - 16);

    /* Page 3 — customers + distribution */
    doc.addPage(); header('Customer & distribution analysis'); y = 30;
    sectionTitle('Customer chargeable weight (chart view)', y);
    addChart('chCustBar', M, y + 4, half, H - y - 16);
    const rx = M + half + 6;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...NAVY); doc.text('WEIGHT DISTRIBUTION', rx, y); doc.setTextColor(0, 0, 0);
    addChart('chBucket', rx, y + 4, half, 70);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...NAVY); doc.text('AWB STATE ANALYSIS', rx, y + 82); doc.setTextColor(0, 0, 0);
    addChart('chStateDonut', rx, y + 86, half * 0.42, 78);
    addChart('chStateBar', rx + half * 0.44, y + 86, half * 0.56, 78);

    /* Page 4 — origin hub table */
    doc.addPage(); header('Origin hub table');

    /* Tables */
    const hubBody = a.hubRows.map(([h, o], i) => [i + 1, h, fmtNum(o.count, 0), fmtNum(o.kg, 2), fmtNum(o.kg / o.count, 2), fmtPct((o.kg / a.total) * 100, 2)]);
    doc.autoTable(Object.assign({ startY: 30, head: [['Rank', 'Origin Hub', 'AWBs', 'Chargeable Wt KG', 'Avg KG', '% Contribution']], body: hubBody }, tableTheme, { didDrawPage: () => header('Origin hub table') }));

    doc.addPage(); header('Detail tables');
    doc.autoTable(Object.assign({ startY: 30, head: [['Rank', 'Customer Name', 'AWB Count', 'Chargeable Wt KG', 'Avg Wt KG', '% Contribution']],
      body: a.custRows.slice(0, 20).map(([c, o], i) => [i + 1, c, fmtNum(o.count, 0), fmtNum(o.kg, 2), fmtNum(o.kg / o.count, 2), fmtPct((o.kg / a.total) * 100, 2)]) }, tableTheme,
      { didDrawPage: () => header('Top 20 customers by chargeable weight') }));
    doc.addPage(); header('Destination analysis');
    doc.autoTable(Object.assign({ startY: 30, head: [['Rank', 'Destination', 'AWBs', 'Chargeable Wt KG', 'Avg Wt KG', '% Contribution']],
      body: a.destRows.map(([d, o], i) => [i + 1, d, fmtNum(o.count, 0), fmtNum(o.kg, 2), fmtNum(o.kg / o.count, 2), fmtPct((o.kg / a.total) * 100, 2)]) }, tableTheme,
      { didDrawPage: () => header('Destination analysis') }));

    const LIMIT = 200;
    const awbs = records.slice().sort((p, q) => q.wt - p.wt).slice(0, LIMIT);
    doc.addPage(); header('Chargeable weight analysis');
    doc.autoTable(Object.assign({ startY: 30, head: [['Rank', 'AWB Number', 'Customer Name', 'Event Date', 'AWB State', 'Inscan Date', 'Dest', 'Hub', 'Chargeable Wt KG']],
      body: awbs.map((r, i) => [i + 1, r.awb, r.customer, fmtDate(r.eventDate), r.state, fmtDate(r.inscanDate), r.dest, r.hub, fmtNum(r.wt, 2)]),
      columnStyles: { 8: { halign: 'right', fontStyle: 'bold' } } }, tableTheme, { didDrawPage: () => header('Chargeable weight analysis - highest first') }));
    if (records.length > LIMIT) {
      doc.setFontSize(8); doc.setTextColor(...GREY);
      doc.text(`This shows the ${LIMIT} heaviest of ${fmtNum(records.length, 0)} AWBs. Use Export Excel to get all of them.`, M, doc.lastAutoTable.finalY + 6);
    }

    footer();
    doc.save(`AWB_Inscan_Report_${stamp()}.pdf`);
    U.toast('PDF report exported');
  }

  global.Exporter = { exportCSV, exportExcel, exportFilteredData, exportPDF, RECORD_COLUMNS };
})(window);

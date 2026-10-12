# SkyNet AWB Inscan Analytics

A browser-only analytics dashboard for AWB inscan data at origin hubs: chargeable weight by origin hub, destination, customer, AWB state and date. Built with HTML5, CSS3 and vanilla JavaScript (Chart.js, SheetJS, jsPDF).

## Run it

1. Unzip the folder.
2. Double-click `Start Dashboard.bat`. It opens the dashboard at http://localhost:8765 and keeps a small window open; close that window to stop.
3. An internet connection is needed the first time so the browser can fetch the chart / Excel / PDF libraries from the CDN.

## Auto-update from the folder

While `Start Dashboard.bat` is running, the dashboard loads the newest `.xlsx` / `.xls` file in this folder (or in `data/`) and checks again every 5 seconds. Copy a new Excel file into the folder and the dashboard updates by itself; filters are reset for the new file. The header shows **Auto-update ON** when this is working.

The Excel file can stay open in Excel; the dashboard still reads it (save in Excel to see your edits).

Opening `index.html` directly (double-click) still works, but a browser cannot read a folder on its own, so auto-update is off there and you load files with **Upload Excel** or drag and drop.

Each time the dashboard loads a file from the folder it also saves a snapshot to `data/seed-data.js`, so `index.html` opened directly shows the last file the running dashboard loaded. Upload a new Excel file at any time with **Upload Excel** or by dragging it onto the page. The last upload is remembered in this browser; a newer folder snapshot replaces it.

Your uploaded data is processed locally in your browser. Nothing is sent to any server.

## Auto-update on GitHub Pages

When the dashboard is opened from GitHub Pages (`name.github.io/repo`), it looks in the GitHub repository for the newest `.xlsx` / `.xls` file and loads it, then checks again every 2 minutes. Upload a new Excel file to the repository and the page updates by itself; nothing else needs to be changed. The header shows **Auto-update ON · watching the GitHub repository**.

- The repository must be public.
- The newest file is picked by the date in the file name (`...12-Oct-2026-11-46-AM.xlsx`). Uploading a file with the same name and new content also updates the page.
- GitHub allows 60 checks an hour per network without sign-in. If that runs out, the page shows the snapshot in `data/seed-data.js` until the next hour.
- If the page uses its own domain, add `<script>window.DASH_GITHUB_REPO = 'owner/repo';</script>` before `js/app.js` in `index.html`.

## Excel format

Required columns (any order, any sheet; header row can be in the first 15 rows):

| Column | Notes |
|---|---|
| AWB NUMBER | duplicates are flagged |
| CUSTOMER NAME | |
| EVENT DATE | DD/MM/YYYY text, Excel dates or serial numbers |
| AWB STATE | |
| INSCAN DATE | same as Event Date |
| DESTINATION CODE | |
| ORIGIN HUB CODE | trailing spaces/newlines in the header are cleaned |
| CHARGEABLE WT.(KG.) | non-numeric values are counted as invalid and treated as 0 |

Headers are normalised (whitespace collapsed, trimmed, upper-cased, punctuation-insensitive match). Text values are trimmed; empty rows are removed. If a column is missing the upload panel lists exactly which ones, and the previous data stays on screen.

## Features

- 9 KPI cards (total / avg / max / min weight, AWBs, customers, hubs, destinations, states) with 3D hover tilt and count-up
- Global filters: Customer, Event Date (pick dates and/or From–To range), AWB State, Inscan Date, Destination, Origin Hub, Customer Ranking (All / Top 5 / 10 / 20 / Custom), global search. All searchable multi-selects, removable filter chips, Reset All Filters
- Chart click-to-filter (hub, destination, customer, state, matrix cell). Toggle it off with **Chart click filters**
- Origin hub bar and donut (total KG in centre); inscan date shown on the Total Chargeable Weight card
- Hub × Destination heatmap matrix with totals
- Destination bar + table with origin hub tabs (All Hubs / one tab per hub), customer horizontal bar (Top 5/10/20/All/Custom) + table
- Configurable weight buckets (AWB count or total KG), AWB state donut + bar
- Chargeable weight table, always ranked heaviest first by default; every table has search, sort, pagination, rows-per-page, CSV and Excel export
- Auto-generated executive summary
- Export filtered data (Excel / CSV), PDF management report, print layout, light/dark mode, full screen

## Project structure

```
index.html
css/style.css
js/utils.js          formatting, dates, storage, helpers
js/excel-reader.js   DATA SERVICE LAYER: loadExcelData(), parseWorkbook(), normalizeData()
js/filters.js        filter state, multi-select control, filterData()
js/charts.js         Chart.js wrappers (charts are updated in place, not re-created)
js/table.js          DataTable (search / sort / pagination / export)
js/dashboard.js      calculateKPIs(), updateCharts(), updateTables(), summary, matrix, quality
js/export.js         CSV, Excel, PDF report
js/app.js            controller: upload, folder auto-load, refresh, theme, wiring
server.ps1           local server: serves the folder and reports the newest Excel file
Start Dashboard.bat  starts server.ps1 and opens the dashboard
assets/logo.png      company logo
assets/logo-base64.js logo for the PDF export
data/seed-data.js    snapshot of the newest Excel (rewritten by server.ps1)
data/*.xlsx          the original Excel file
```

## Connecting OneDrive / SharePoint / Excel Online / Google Sheets later

All data enters through `DataService` in `js/excel-reader.js`. Register a new source that returns `{ fileName, headers, rows }` and call `App.applyDataset(raw)`:

```js
DataService.registerSource('graph', async ({ driveId, itemId, token }) => {
  const res = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/content`,
    { headers: { Authorization: `Bearer ${token}` } });
  return DataService.parseWorkbook(await res.arrayBuffer(), 'OneDrive workbook');
});

const raw = await DataService.loadExcelData({ type: 'graph', driveId, itemId, token });
App.applyDataset(raw);                       // filters, KPIs, charts, tables all refresh
setInterval(async () => App.applyDataset(await DataService.loadExcelData({ type: 'graph', driveId, itemId, token })), 5 * 60 * 1000);
```

For Google Sheets, fetch the sheet values (`spreadsheets.values.get`) and return `{ headers: values[0], rows: values.slice(1) }`. Use MSAL.js / Google Identity Services for sign-in; never embed secrets in the page.

## Performance notes

One-pass aggregation (cached by array identity), Set-based filtering, 200 ms debounced search, paginated tables (only the visible page is in the DOM), charts updated in place. Tested with the 599-row file; designed for tens of thousands of rows.

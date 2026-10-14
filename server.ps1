# =====================================================================
# server.ps1 - small local server for the SkyNet dashboard.
# Started by "Start Dashboard.bat". It serves this folder on
# http://localhost:8765 (this computer only) and tells the page which
# Excel file in the folder is the newest, so the dashboard can load it
# by itself whenever a new file is copied in.
#   GET /api/latest          -> { name, stamp, size } of the newest .xlsx / .xls
#   GET /api/file?name=...   -> that Excel file
#   POST /api/seed           -> saves the loaded data as data\seed-data.js
# Excel files are looked for in this folder and in the data\ folder.
# =====================================================================
param([int]$Port = 8765, [switch]$NoBrowser)

$root = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$url = "http://localhost:$Port/"
$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.css' = 'text/css; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.svg' = 'image/svg+xml'; '.ico' = 'image/x-icon'
  '.xlsx' = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; '.xls' = 'application/vnd.ms-excel'
}

# A copied file keeps its old "modified" time, so the newer of created / modified decides.
function Get-Stamp($f) { if ($f.CreationTimeUtc -gt $f.LastWriteTimeUtc) { $f.CreationTimeUtc } else { $f.LastWriteTimeUtc } }
function Get-ExcelFiles {
  Get-ChildItem -LiteralPath $root, (Join-Path $root 'data') -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -match '^\.(xlsx|xls)$' -and $_.Name -notlike '~$*' } |
    Sort-Object { Get-Stamp $_ } -Descending
}

function Send-Bytes($res, [int]$status, [string]$type, [byte[]]$bytes) {
  $res.StatusCode = $status
  $res.ContentType = $type
  $res.Headers['Cache-Control'] = 'no-store'
  $res.ContentLength64 = $bytes.Length
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
}
function Send-Text($res, [int]$status, [string]$text, [string]$type = 'text/plain; charset=utf-8') {
  Send-Bytes $res $status $type ([Text.Encoding]::UTF8.GetBytes($text))
}
# Reads a file even when it is open in Excel. Still fails while a copy into the folder is running.
function Read-Shared([string]$path) {
  $fs = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite, Delete')
  try { $buf = New-Object byte[] $fs.Length; $n = 0; while ($n -lt $buf.Length) { $n += $fs.Read($buf, $n, $buf.Length - $n) }; return ,$buf } finally { $fs.Dispose() }
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($url)
try { $listener.Start() }
catch {
  Write-Host "The dashboard is already running (port $Port is in use). Opening it in the browser."
  if (-not $NoBrowser) { Start-Process $url }
  exit
}

Write-Host ''
Write-Host "  SkyNet dashboard is running at $url"
Write-Host "  Copy a new Excel file into: $root"
Write-Host '  The dashboard picks it up by itself in a few seconds.'
Write-Host ''
Write-Host '  Keep this window open. Close it to stop the dashboard.'
if (-not $NoBrowser) { Start-Process $url }

try {
  while ($listener.IsListening) {
    $task = $listener.GetContextAsync()
    while (-not $task.Wait(300)) { }
    $ctx = $task.Result
    $req = $ctx.Request; $res = $ctx.Response
    try {
      $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart('/')
      if ($path -eq 'api/latest') {
        $f = Get-ExcelFiles | Select-Object -First 1
        $info = if ($f) { @{ name = $f.Name; stamp = (Get-Stamp $f).Ticks.ToString(); size = $f.Length } } else { @{ name = $null } }
        Send-Text $res 200 ($info | ConvertTo-Json -Compress) $mime['.json']
      }
      elseif ($path -eq 'api/file') {
        $name = $req.QueryString['name']
        $f = Get-ExcelFiles | Where-Object { $_.Name -eq $name } | Select-Object -First 1
        if (-not $f) { Send-Text $res 404 'Not found' }
        else {
          try { $bytes = Read-Shared $f.FullName } catch { $bytes = $null }
          if ($null -eq $bytes) { Send-Text $res 503 'File is busy' } else { Send-Bytes $res 200 $mime[$f.Extension.ToLower()] $bytes }
        }
      }
      elseif ($path -eq 'api/seed') {
        # Only the dashboard page itself may save the snapshot (other web sites are refused).
        if ($req.HttpMethod -ne 'POST' -or $req.Headers['Origin'] -ne $url.TrimEnd('/') -or $req.ContentLength64 -gt 50MB) { Send-Text $res 403 'Forbidden' }
        else {
          $reader = New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)
          try { $json = $reader.ReadToEnd().Trim() } finally { $reader.Dispose() }
          if (-not ($json.StartsWith('{') -and $json.EndsWith('}'))) { Send-Text $res 400 'Bad request' }
          else {
            $js = "/* Seed dataset: written by server.ps1 from the newest Excel file in the folder, so index.html`n   shows the latest data even when it is opened without Start Dashboard.bat. */`nwindow.SEED_DATASET = $json;`n"
            [IO.File]::WriteAllText((Join-Path $root 'data\seed-data.js'), $js, (New-Object Text.UTF8Encoding($false)))
            Send-Text $res 200 'OK'
          }
        }
      }
      else {
        if (-not $path) { $path = 'index.html' }
        $full = [IO.Path]::GetFullPath((Join-Path $root $path))
        if (-not $full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) { Send-Text $res 404 'Not found' }
        else {
          $type = $mime[[IO.Path]::GetExtension($full).ToLower()]
          if (-not $type) { $type = 'application/octet-stream' }
          Send-Bytes $res 200 $type (Read-Shared $full)
        }
      }
    }
    catch { try { Send-Text $res 500 'Server error' } catch { } }
    finally { try { $res.Close() } catch { } }
  }
}
finally { $listener.Stop() }

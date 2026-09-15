param([int]$Port = 8325, [string]$Root = "$PSScriptRoot\..",
      [string]$Default = 'AssetManagement.html')

# Static file server for local testing. No Node/Python needed.
#
# KEEP THIS FILE PURE ASCII. Windows PowerShell 5.1 reads a .ps1 without a BOM
# as ANSI, and a UTF-8 em-dash then decodes to a curly quote, which PowerShell
# treats as a string delimiter -- that silently breaks the whole script. Editors
# tend to drop the BOM when rewriting, so ASCII is the safe choice here.

$Root = (Resolve-Path $Root).Path
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "PHCL - Asset Intake serving $Root on http://localhost:$Port/"

$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8';  '.json' = 'application/json; charset=utf-8'
  '.sql'  = 'text/plain; charset=utf-8'; '.md' = 'text/plain; charset=utf-8'
  '.svg'  = 'image/svg+xml'; '.png' = 'image/png'; '.ico' = 'image/x-icon'
}

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $path = '/'
    try {
      $path = [uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
      # The repo deliberately has no index.html; the entry page is AssetManagement.html.
      if ($path -eq '/') { $path = '/' + $Default }
      $file = Join-Path $Root ($path.TrimStart('/') -replace '/', '\')
      $full = [System.IO.Path]::GetFullPath($file)

      # Browsers still request /favicon.ico even though the page declares an
      # icon via a data URI. Answer 204 so the console stays clean.
      if ($path -eq '/favicon.ico' -and -not (Test-Path -LiteralPath $full -PathType Leaf)) {
        $ctx.Response.StatusCode = 204
        $body = New-Object byte[] 0
      }
      elseif (-not $full.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase) -or
              -not (Test-Path -LiteralPath $full -PathType Leaf)) {
        $ctx.Response.StatusCode = 404
        $ctx.Response.ContentType = 'text/plain; charset=utf-8'
        $body = [Text.Encoding]::UTF8.GetBytes("404 $path")
      }
      else {
        $ext = [System.IO.Path]::GetExtension($full).ToLower()
        $ctx.Response.StatusCode = 200
        $ctx.Response.ContentType = $(if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' })
        $ctx.Response.AddHeader('Cache-Control', 'no-store')
        $body = [System.IO.File]::ReadAllBytes($full)
      }

      if ($ctx.Request.HttpMethod -eq 'HEAD') {
        # HEAD (the preview harness probes the port with it): declare the length
        # but write NO body, otherwise .NET throws ProtocolViolationException.
        $ctx.Response.ContentLength64 = $body.Length
        $ctx.Response.Close()
        Write-Host ("{0} HEAD {1}" -f $ctx.Response.StatusCode, $path)
      }
      else {
        # Close(byte[], bool) sets Content-Length itself and closes the stream,
        # so it cannot disagree with the number of bytes actually written.
        $ctx.Response.Close($body, $true)
        Write-Host ("{0} {1} ({2} bytes)" -f $ctx.Response.StatusCode, $path, $body.Length)
      }
    }
    catch {
      # One bad request must never kill the server.
      Write-Host ("ERR {0}: {1}" -f $path, $_.Exception.Message)
      try { $ctx.Response.Abort() } catch {}
    }
  }
}
finally { $listener.Stop(); $listener.Close() }

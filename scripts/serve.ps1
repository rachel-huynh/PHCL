param([int]$Port = 8323, [string]$Root = "$PSScriptRoot\..",
      [string]$Default = 'AssetManagement.html')

$Root = (Resolve-Path $Root).Path
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "asset-intake serving $Root on http://localhost:$Port/"

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
      # Repo cố ý KHÔNG có index.html — trang chính là assetmanagement.html.
      if ($path -eq '/') { $path = '/' + $Default }
      $file = Join-Path $Root ($path.TrimStart('/') -replace '/', '\')
      $full = [System.IO.Path]::GetFullPath($file)

      if (-not $full.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase) -or
          -not (Test-Path -LiteralPath $full -PathType Leaf)) {
        $ctx.Response.StatusCode = 404
        $ctx.Response.ContentType = 'text/plain; charset=utf-8'
        $body = [Text.Encoding]::UTF8.GetBytes("404 $path")
      } else {
        $ext = [System.IO.Path]::GetExtension($full).ToLower()
        $ctx.Response.StatusCode = 200
        $ctx.Response.ContentType = $(if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' })
        $ctx.Response.AddHeader('Cache-Control', 'no-store')
        $body = [System.IO.File]::ReadAllBytes($full)
      }
      if ($ctx.Request.HttpMethod -eq 'HEAD') {
        # HEAD (harness dùng để thăm dò cổng): khai báo độ dài nhưng KHÔNG được
        # ghi body, nếu ghi sẽ ném ProtocolViolationException.
        $ctx.Response.ContentLength64 = $body.Length
        $ctx.Response.Close()
        Write-Host ("{0} HEAD {1}" -f $ctx.Response.StatusCode, $path)
      } else {
        # Close(byte[], bool) tự đặt Content-Length rồi đóng stream — tránh lệch
        # giữa ContentLength64 và số byte thực ghi.
        $ctx.Response.Close($body, $true)
        Write-Host ("{0} {1} ({2} bytes)" -f $ctx.Response.StatusCode, $path, $body.Length)
      }
    } catch {
      # Một request hỏng không được phép giết server.
      Write-Host ("ERR {0}: {1}" -f $path, $_.Exception.Message)
      try { $ctx.Response.Abort() } catch {}
    }
  }
} finally { $listener.Stop(); $listener.Close() }

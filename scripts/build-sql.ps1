param([string]$SqlDir = "$PSScriptRoot\..\sql")

# Gộp các file SQL theo đúng thứ tự chạy thành sql/ALL_IN_ONE.sql
# để dán một lần vào Supabase SQL Editor.
# Chạy lại mỗi khi sửa file gốc.

$SqlDir = (Resolve-Path $SqlDir).Path
$order = @('01_schema.sql', '02_seed_master.sql', '02b_seed_origin.sql',
           '02c_seed_location.sql', '03_functions.sql', '04_rls.sql', '05_alr.sql')

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('-- =====================================================================')
[void]$sb.AppendLine('-- asset-intake — TẤT CẢ TRONG MỘT FILE')
[void]$sb.AppendLine('-- Sinh tự động từ các file 01..05 trong cùng thư mục. Đừng sửa file này,')
[void]$sb.AppendLine('-- sửa file gốc rồi chạy scripts/build-sql.ps1.')
[void]$sb.AppendLine('--')
[void]$sb.AppendLine('-- Dán TOÀN BỘ vào Supabase SQL Editor rồi bấm Run. Chạy lại nhiều lần')
[void]$sb.AppendLine('-- vô hại: mọi lệnh đều if not exists / on conflict do update.')
[void]$sb.AppendLine('-- Sau đó chạy 00_verify.sql để kiểm chứng.')
[void]$sb.AppendLine('-- =====================================================================')
[void]$sb.AppendLine('')

foreach ($f in $order) {
  $p = Join-Path $SqlDir $f
  if (-not (Test-Path -LiteralPath $p)) { throw "Thiếu file $f" }
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine('-- ####################################################################')
  [void]$sb.AppendLine("-- ##  $f")
  [void]$sb.AppendLine('-- ####################################################################')
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine([System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8))
}

$out = Join-Path $SqlDir 'ALL_IN_ONE.sql'
[System.IO.File]::WriteAllText($out, $sb.ToString(), (New-Object System.Text.UTF8Encoding $false))
Write-Host ("Đã ghi {0} ({1:N0} bytes)" -f $out, (Get-Item $out).Length)

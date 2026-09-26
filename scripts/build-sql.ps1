param([string]$SqlDir = "$PSScriptRoot\..\sql")

# Gộp các file SQL theo đúng thứ tự chạy thành sql/ALL_IN_ONE.sql
# để dán một lần vào Supabase SQL Editor.
# Chạy lại mỗi khi sửa file gốc.

$SqlDir = (Resolve-Path $SqlDir).Path
# 06_seed_product.sql must come after 03_functions.sql: it calls am_norm().
$order = @('01_schema.sql', '02_seed_settings.sql',
           '02a_seed_org.sql', '02b_seed_category.sql', '02b2_seed_category_opex.sql',
           '02c_seed_unit.sql',
           '02d_seed_origin.sql', '02e_seed_location.sql',
           '03_functions.sql', '04_rls.sql', '05_alr.sql',
           '06_seed_product.sql', '07_data_source.sql', '08_seed_counters.sql',
           '10_legacy_assets.sql', '11_suggest.sql', '13_suggest_terms.sql',
           '14_undo_intake.sql', '15_bulk_edit.sql', '16_reset_counters.sql',
           '17_auth.sql', '18_pm_budget.sql', '19_pm_workflow.sql',
           '20_pm_notify.sql', '21_pm_payment.sql', '22_admin_tools.sql', '23_pm_pkg_merge.sql', '24_ui_feedback.sql', '25_pm_tender.sql', '26_alr_project.sql', '27_liquidation.sql', '28_liquidation_batch.sql', '29_liquidation_bid.sql', '30_acc_reconcile.sql', '31_asset_ops.sql', '32_price_db.sql')

# Nâng cấp một database ĐANG CHẠY lên đăng nhập bắt buộc. Chỉ gồm các file
# không có seed — ALL_IN_ONE thì có, và chạy lại seed trên dữ liệu thật sẽ ghi
# đè những gì đã sửa trong app (vd văn phòng mặc định của phòng ban).
# 03/13/14/15/16 được đưa vào vì các hàm trong đó nay có kiểm tra quyền.
$migrate17 = @('03_functions.sql', '04_rls.sql', '13_suggest_terms.sql',
               '14_undo_intake.sql', '15_bulk_edit.sql', '16_reset_counters.sql',
               '17_auth.sql')

function Build([string]$name, [string[]]$files, [string[]]$header) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.AppendLine('-- =====================================================================')
  foreach ($h in $header) { [void]$sb.AppendLine("-- $h") }
  [void]$sb.AppendLine('-- Sinh tự động bởi scripts/build-sql.ps1. Đừng sửa file này — sửa file')
  [void]$sb.AppendLine('-- gốc trong sql/ rồi chạy lại script.')
  [void]$sb.AppendLine('-- =====================================================================')
  [void]$sb.AppendLine('')
  foreach ($f in $files) {
    $p = Join-Path $SqlDir $f
    if (-not (Test-Path -LiteralPath $p)) { throw "Thiếu file $f" }
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('-- ####################################################################')
    [void]$sb.AppendLine("-- ##  $f")
    [void]$sb.AppendLine('-- ####################################################################')
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine([System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8))
  }
  $out = Join-Path $SqlDir $name
  [System.IO.File]::WriteAllText($out, $sb.ToString(), (New-Object System.Text.UTF8Encoding $false))
  Write-Host ("Đã ghi {0} ({1:N0} bytes)" -f $out, (Get-Item $out).Length)
}

Build 'ALL_IN_ONE.sql' $order @(
  'asset-intake — TẤT CẢ TRONG MỘT FILE — dùng cho database MỚI.',
  'Dán TOÀN BỘ vào Supabase SQL Editor rồi bấm Run.',
  '⚠ Database đang chạy thật: dùng MIGRATE_17.sql, KHÔNG dùng file này —',
  '  seed ở đây ghi đè master data đã sửa trong app.')

Build 'MIGRATE_17.sql' $migrate17 @(
  'MIGRATE_17 — BẬT ĐĂNG NHẬP BẮT BUỘC cho database đang chạy.',
  'Làm theo đúng thứ tự trong phần đầu của 17_auth.sql (tạo tài khoản',
  'trước, chạy file này, bootstrap admin, rồi mới push app mới).',
  'Chạy lại nhiều lần vô hại.')

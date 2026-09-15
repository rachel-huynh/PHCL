param($s, $out)
. "$s\xl.ps1"
$locs=@{}
foreach($f in @('bbkk-fin.xlsx','bbkk-ADM.xlsx','bbkk-SMD.xlsx','bbkk-all.xlsx')){
  $p="$s\$f"; if(-not (Test-Path $p)){ continue }
  foreach($sh in (Show-Sheets $p)){
    $t=($sh -split "`t")[1]
    foreach($ln in (Dump-Sheet $p $t 300)){
      foreach($m in [regex]::Matches($ln,'([^|=,]{2,80}?)\s-\s(S[B]?[0-9][0-9A-Z\-]{1,8})\s\((Kiểm kê|Nội bộ)\)')){
        $code=$m.Groups[2].Value.Trim()
        $nm=($m.Groups[1].Value -replace '^\s*Bộ phận:\s*','').Trim()
        if(-not $locs.ContainsKey($code)){ $locs[$code]=$nm }
      }
    }
  }
}
# Toà nhà gốc
$locs['S']='Sofitel Saigon Plaza Building / Toà nhà Sofitel Saigon Plaza'

# Office mặc định của phòng ban: chỉ nhận khi CHÍNH TÊN vị trí nói rõ phòng ban
$office=@{ 'S0103B0'='ITD'; 'SB120B0'='FIN'; 'SB124B0'='SEC'; 'SB117B0'='HKD';
           'SB142B0'='FBD'; 'S0302B0'='SMD'; 'SB121'='ADM'; 'S0111B0'='KIT';
           'SB141B0'='ENG' }

function Get-Parent($c){
  if($c -eq 'S'){ return @($null,'building',$false) }
  if($c -match '^S(\d{2})00$'){ return @('S','floor',$false) }
  if($c -match '^SB(\d)00$'){ return @('S','floor',$false) }
  if($c -match '^S(\d{2})(\d{2})'){ return @("S$($Matches[1])00",'room',$false) }
  if($c -match '^SB(\d)(\d{2})'){ return @("SB$($Matches[1])00",'room',$false) }
  return @('S','area',$true)
}
function Q($t){ if($null -eq $t){ return 'null' } return "'" + ($t -replace "'","''") + "'" }

$sb=New-Object System.Text.StringBuilder
[void]$sb.Append(@"
-- =====================================================================
-- asset-intake — Seed vị trí (HỆ MÃ DÀI, theo lựa chọn của user 2026-09-15)
-- Nguồn: dòng "Bộ phận:" trong các file
--   ...\ASSET COUNT\Kiểm kê 07.2025\bien-ban-kiem-ke-{FIN,ADM,SMD}.xlsx
--   ...\ASSET COUNT\BBKK-FIN, SMD, ADM.xlsx
-- Cây suy ra từ chính mã: S -> S<tầng>00 / SB<hầm>00 -> phòng.
-- SINH TỰ ĐỘNG - đừng sửa tay, sửa scripts/genloc.ps1 rồi chạy lại.
-- Chạy SAU 02_seed_master.sql (cần am_org đã có).
-- =====================================================================

insert into am_location (code, name, kind, parent_code, dept_code, is_dept_office) values

"@)
$rows=@()
foreach($c in ($locs.Keys | Sort-Object { if($_ -eq 'S'){'0'} else { $_ } })){
  $p=Get-Parent $c
  $dept = $office[$c]
  $rows += "  ({0}, {1}, {2}, {3}, {4}, {5})" -f (Q $c), (Q $locs[$c]), (Q $p[1]), (Q $p[0]), (Q $dept), $(if($dept){'true'}else{'false'})
}
[void]$sb.Append(($rows -join ",`n"))
[void]$sb.Append(@"

on conflict (code) do update
  set name = excluded.name, kind = excluded.kind, parent_code = excluded.parent_code;

-- Mã không theo quy luật -> gắn tạm vào toà nhà, cần xác nhận:
--   S203   "Le 17 Bistro restaurant"  (nhiều khả năng là S0203, trùng tầng với
--          S0203P0 "Mezz restaurant")
--   SB121  "HR office" vs SB121B0 "Receiving office" — cùng số phòng, khác hậu tố
-- Phòng ban FOD chưa có office mặc định: danh sách vị trí không có "Front office".
"@)
[System.IO.File]::WriteAllText($out, $sb.ToString(), (New-Object System.Text.UTF8Encoding $false))
"wrote $out  ($($rows.Count) vị trí)"

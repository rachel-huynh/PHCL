Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-Sst($zip){
  $e = $zip.GetEntry('xl/sharedStrings.xml'); $r = New-Object System.Collections.ArrayList
  if($null -eq $e){ return $r }
  $sr = New-Object System.IO.StreamReader($e.Open())
  $xml = [xml]$sr.ReadToEnd(); $sr.Close()
  foreach($si in $xml.DocumentElement.ChildNodes){
    $sb = New-Object System.Text.StringBuilder
    foreach($n in $si.SelectNodes('.//*')){ if($n.LocalName -eq 't'){ [void]$sb.Append($n.InnerText) } }
    [void]$r.Add($sb.ToString())
  }
  return $r
}
function Show-Sheets($path){
  $zip = [System.IO.Compression.ZipFile]::OpenRead($path)
  $sr = New-Object System.IO.StreamReader($zip.GetEntry('xl/_rels/workbook.xml.rels').Open())
  $rx = [xml]$sr.ReadToEnd(); $sr.Close()
  $rel = @{}; foreach($n in $rx.DocumentElement.ChildNodes){ $rel[$n.Id] = $n.Target }
  $sr = New-Object System.IO.StreamReader($zip.GetEntry('xl/workbook.xml').Open())
  $wx = [xml]$sr.ReadToEnd(); $sr.Close()
  foreach($sh in $wx.workbook.sheets.ChildNodes){
    $rid = $sh.GetAttribute('id','http://schemas.openxmlformats.org/officeDocument/2006/relationships')
    "{0}`t{1}`t{2}" -f $sh.name, $rel[$rid], $sh.state
  }
  $zip.Dispose()
}
function Dump-Sheet($path,$target,$maxRow){
  $zip = [System.IO.Compression.ZipFile]::OpenRead($path)
  $sst = Get-Sst $zip
  $t = $target.TrimStart('/'); if($t -notlike 'xl/*'){ $t = 'xl/' + $t }
  $e = $zip.GetEntry($t); if($null -eq $e){ "NOENTRY $t"; $zip.Dispose(); return }
  $sr = New-Object System.IO.StreamReader($e.Open())
  $xml = [xml]$sr.ReadToEnd(); $sr.Close()
  $rows = $xml.worksheet.sheetData.ChildNodes; $i=0
  foreach($row in $rows){
    $i++; if($i -gt $maxRow){ break }
    $line = "R$($row.r)|"
    foreach($c in $row.ChildNodes){
      $v = $null
      foreach($ch in $c.ChildNodes){ if($ch.LocalName -eq 'v'){ $v = $ch.InnerText } elseif($ch.LocalName -eq 'is'){ $v = $ch.InnerText } }
      if($null -eq $v -or $v -eq ''){ continue }
      if($c.t -eq 's'){ $ix=[int]$v; if($ix -lt $sst.Count){ $v = $sst[$ix] } }
      $line += "$($c.r)=$($v -replace "`n",' ')|"
    }
    if($line.Length -gt 4){ $line }
  }
  $zip.Dispose()
}

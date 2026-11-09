# Measures Buddy's CPU use while idle: starts a separate copy (its own profile, no API calls), lets it settle, then
# samples each of its processes over a quiet window. Keep the mouse still while it runs; moving it is real work
# (Buddy's pointer follows the cursor) and shows up in the numbers.
#   powershell -File scripts/measure-idle.ps1 [-Seconds 60] [-Budget 1.0]
# Exits 1 when the total is over -Budget (percent of one core).
param([int]$Seconds = 60, [double]$Budget = 0)

$app = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path ([IO.Path]::GetTempPath()) "buddy-idle-$PID"
$env:ANTHROPIC_API_KEY = "sk-not-used-while-idle"
$env:BUDDY_MODELS_DIR = Join-Path $env:APPDATA "desktop-buddy\models"
$electron = Join-Path $app "node_modules\electron\dist\electron.exe"

Start-Process -FilePath $electron -ArgumentList @("`"$app`"", "--user-data-dir=`"$profileDir`"") | Out-Null
Start-Sleep -Seconds 12
$procs = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -match [regex]::Escape("buddy-idle-$PID") }
$kind = @{}
foreach ($p in $procs) {
  $kind[$p.ProcessId] = if ($p.CommandLine -match '--type=([a-z-]+)') { $Matches[1] } else { "main" }
}
$before = @{}
foreach ($id in $kind.Keys) { $before[$id] = (Get-Process -Id $id -ErrorAction SilentlyContinue).CPU }
Start-Sleep -Seconds $Seconds
$rows = foreach ($id in $kind.Keys) {
  $after = (Get-Process -Id $id -ErrorAction SilentlyContinue).CPU
  [pscustomobject]@{ type = $kind[$id]; pct = (($after - $before[$id]) / $Seconds) * 100 }
}
$procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1
Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue

$total = ($rows | Measure-Object pct -Sum).Sum
"Idle CPU over {0} s: {1:N2}% of one core" -f $Seconds, $total
$rows | Group-Object type | ForEach-Object { "  {0,-12} {1,6:N2}%" -f $_.Name, ($_.Group | Measure-Object pct -Sum).Sum }
if ($Budget -gt 0 -and $total -gt $Budget) {
  "Over budget ({0:N2}% > {1:N2}%)" -f $total, $Budget
  exit 1
}

<#
  dsh-usage-cost —— 装好之后的自检（不需要浏览器）
  跑法：powershell -ExecutionPolicy Bypass -File .\verify.ps1
#>
$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:19387'

function Probe([string]$path) {
  try {
    $r = Invoke-WebRequest -Uri ($base + $path) -UseBasicParsing -TimeoutSec 8
    return @{ ok = $true; status = [int]$r.StatusCode; body = $r.Content }
  } catch {
    return @{ ok = $false; status = ($_.Exception.Response.StatusCode.value__); body = '' }
  }
}

Write-Host '== 1) profile 是否声明了这个 bundle =='
$profilePkg = 'E:\deepseekharness\.dsh\profiles\desktop\package.json'
if (Test-Path $profilePkg) {
  $j = Get-Content $profilePkg -Raw | ConvertFrom-Json
  $bundles = @($j.dsh.profile.bundles)
  Write-Host ('   bundles: ' + ($bundles -join ', '))
  if ($bundles -contains 'dsh-usage-cost') { Write-Host '   ✓ 已声明' } else { Write-Host '   ✗ 没有 dsh-usage-cost，先跑 install.ps1' }
}
else { Write-Host "   ✗ 找不到 $profilePkg" }

Write-Host '== 2) 宿主半是否活着 =='
$h = Probe '/dsh-usage-cost/health'
if ($h.ok) {
  Write-Host "   ✓ /dsh-usage-cost/health -> $($h.status)"
  $health = $h.body | ConvertFrom-Json
  Write-Host ('   pid=' + $health.pid + '  clientFileExists=' + $health.clientFileExists)
  Write-Host ('   counters: ' + ($health.counters | ConvertTo-Json -Compress))
  if ($health.counters.clientJsServed -gt 0) { Write-Host '   ✓ 页面已经来取过浏览器半（说明注入生效）' }
  else { Write-Host '   · 页面还没取过浏览器半 → 桌面端请完全退出并重开；浏览器请刷新页面' }
}
else {
  Write-Host "   ✗ /dsh-usage-cost/health -> $($h.status)（宿主半没加载：确认已重启 DSH）"
}

Write-Host '== 3) 浏览器半是否可服务 =='
$c = Probe '/dsh-usage-cost/client.js'
if ($c.ok) { Write-Host "   ✓ /dsh-usage-cost/client.js -> $($c.status)，约 $([math]::Round($c.body.Length/1024,1)) KB" }
else { Write-Host "   ✗ /dsh-usage-cost/client.js -> $($c.status)" }

Write-Host '== 4) 页面回执 =='
$rep = Probe '/dsh-usage-cost/report'
if ($rep.ok) {
  $d = $rep.body | ConvertFrom-Json
  Write-Host "   reportFile: $($d.reportFile)"
  if (@($d.reports).Count -eq 0) { Write-Host '   · 还没有回执（页面里的脚本还没跑）' }
  else {
    foreach ($line in @($d.reports) | Select-Object -Last 3) {
      foreach ($b in @($line.batch)) {
        $c2 = $b.census
        Write-Host ('   [' + $b.kind + '] url=' + $c2.url + ' turnTails=' + $c2.turnTails + ' turnPanels=' + $c2.turnPanels + ' statsPanels=' + $c2.statsPanels + ' composerStats=' + $c2.composerStats)
        if ($b.kind -eq 'decorate') { Write-Host ('        via=' + $b.via + ' model=' + $b.fact.model + ' total=' + $b.fact.totalText + ' rows=' + (@($b.fact.money | ForEach-Object { $_.role + ':' + $_.text }) -join ' ')) }
      }
    }
  }
}
else { Write-Host "   ✗ /dsh-usage-cost/report -> $($rep.status)" }

Write-Host ''
Write-Host '离线探针：node tools/probe-syntax.mjs ; node tools/probe-pricing.mjs ; node tools/probe-decorate.mjs'

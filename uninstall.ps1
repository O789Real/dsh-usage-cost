<#
  dsh-usage-cost —— 卸载/回滚脚本
  与 install.ps1 相反：把 profile 的 bundles 里那一行去掉，并删掉包目录。
  用法：powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 [-WhatIf]
#>
param(
  [string]$ProfileDir = 'E:\deepseekharness\.dsh\profiles\desktop',
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$PLUGIN = 'dsh-usage-cost'
$dst = Join-Path (Join-Path $ProfileDir 'node_modules') $PLUGIN
$profilePkg = Join-Path $ProfileDir 'package.json'

Write-Host '== 1) 从 profile bundles 摘掉 =='
$json = Get-Content $profilePkg -Raw | ConvertFrom-Json
$bundles = @($json.dsh.profile.bundles)
if ($bundles -notcontains $PLUGIN) {
  Write-Host "   bundles 里本来就没有 $PLUGIN"
}
elseif ($WhatIf) {
  Write-Host "   [WhatIf] 会移除 $PLUGIN"
}
else {
  Copy-Item $profilePkg ($profilePkg + '.bak-usage-cost-uninstall') -Force
  $json.dsh.profile.bundles = @($bundles | Where-Object { $_ -ne $PLUGIN })
  $text = (($json | ConvertTo-Json -Depth 20) -replace "`r`n", "`n") + "`n"
  [System.IO.File]::WriteAllText($profilePkg, $text, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "   已移除，剩余：" + (@($json.dsh.profile.bundles) -join ', ')
}

Write-Host '== 2) 删除包目录 =='
if (-not (Test-Path $dst)) { Write-Host "   本来就不存在：$dst" }
elseif ($WhatIf) { Write-Host "   [WhatIf] 会删除 $dst" }
else {
  $resolved = (Resolve-Path -LiteralPath $dst).Path
  if ($resolved -ne $dst) { throw "解析出的路径与预期不符，已中止：$resolved" }
  Remove-Item -LiteralPath $resolved -Recurse -Force
  Write-Host "   已删除：$resolved"
}

Write-Host ''
Write-Host '完成。重启 DeepSeek Harness 后生效。'
Write-Host '（DSH 数据目录里的 usage-cost-report.jsonl / usage-cost-host.log 是排障产物，可留可删）'

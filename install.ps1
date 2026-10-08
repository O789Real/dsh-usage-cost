<#
  dsh-usage-cost —— 安装/更新脚本
  ---------------------------------------------------------------------------
  做两件事（都可重复执行，幂等）：
    ① 把包本体同步到 <profile>\node_modules\dsh-usage-cost\
    ② 把 "dsh-usage-cost" 加进 <profile>\package.json 的 dsh.profile.bundles

  之后需要让 DSH 重新加载：桌面端要重启应用（它的注入表在宿主启动时一次性收集）；
  如果是浏览器里打开 http://127.0.0.1:19387/ ，刷新页面即可。

  用法：
    powershell -ExecutionPolicy Bypass -File .\install.ps1
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -ProfileDir "E:\...\profiles\web"
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -WhatIf
#>
param(
  [string]$ProfileDir = 'E:\deepseekharness\.dsh\profiles\desktop',
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$PLUGIN = 'dsh-usage-cost'
$src = $PSScriptRoot
$dst = Join-Path (Join-Path $ProfileDir 'node_modules') $PLUGIN
$profilePkg = Join-Path $ProfileDir 'package.json'

Write-Host '== 1) 同步包本体 =='
if (-not (Test-Path $ProfileDir)) { throw "找不到 profile 目录：$ProfileDir" }
Write-Host "   源：$src"
Write-Host "   目标：$dst"
if ($WhatIf) {
  Write-Host '   [WhatIf] 会先删旧目录再整包复制'
}
else {
  if (Test-Path $dst) { Remove-Item -LiteralPath $dst -Recurse -Force }
  New-Item -ItemType Directory -Path $dst -Force | Out-Null
  foreach ($item in 'lib', 'assets', 'tools', 'cordis.patch.yml', 'package.json', 'README.md') {
    $from = Join-Path $src $item
    if (-not (Test-Path $from)) { Write-Host "   · 跳过（不存在）：$item"; continue }
    Copy-Item -LiteralPath $from -Destination $dst -Recurse -Force
    Write-Host "   · 已复制：$item"
  }
}

Write-Host '== 2) 注册到 profile bundles =='
if (-not (Test-Path $profilePkg)) { throw "找不到 $profilePkg" }
$json = Get-Content $profilePkg -Raw | ConvertFrom-Json
$bundles = @($json.dsh.profile.bundles)
if ($bundles -contains $PLUGIN) {
  Write-Host "   bundles 里已有 $PLUGIN，无需改动"
}
elseif ($WhatIf) {
  Write-Host "   [WhatIf] 会追加 $PLUGIN → " + (@($bundles + $PLUGIN) -join ', ')
}
else {
  Copy-Item $profilePkg ($profilePkg + '.bak-before-usage-cost') -Force
  $json.dsh.profile.bundles = @($bundles + $PLUGIN)
  # 注意：Windows PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写 BOM，
  # 而 DSH 读这个 package.json 时 JSON.parse 会因 BOM 直接失败（本插件踩过）。
  $text = (($json | ConvertTo-Json -Depth 20) -replace "`r`n", "`n") + "`n"
  [System.IO.File]::WriteAllText($profilePkg, $text, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "   已追加 $PLUGIN → " + (@($json.dsh.profile.bundles) -join ', ')
  Write-Host "   备份：$profilePkg.bak-before-usage-cost"
}

Write-Host ''
Write-Host '完成。接下来：'
Write-Host '  · 桌面端：完全退出并重开 DeepSeek Harness（注入表在宿主启动时收集）'
Write-Host '  · 浏览器打开 http://127.0.0.1:19387/ ：刷新页面即可'
Write-Host '  · 自检：http://127.0.0.1:19387/dsh-usage-cost/health'

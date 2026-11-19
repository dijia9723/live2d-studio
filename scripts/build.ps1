param([ValidateSet('desktop','server')][string]$Target = 'desktop', [switch]$SkipInstall)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Push-Location (Join-Path $taskRoot 'frontend')
try {
  if (-not $SkipInstall) { npm ci; if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败' } }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw '前端构建失败' }
  New-Item -ItemType File -Force -Path (Join-Path $taskRoot 'server/internal/webui/dist/.gitkeep') | Out-Null
} finally { Pop-Location }
$taskBin = Join-Path $taskRoot 'bin'
New-Item -ItemType Directory -Force -Path $taskBin | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $taskBin 'configs') | Out-Null
Copy-Item -LiteralPath (Join-Path $taskRoot 'server/configs/config.example.yaml') -Destination (Join-Path $taskBin 'configs/config.example.yaml')
# 初始模型随数据目录分发，不打包进二进制；存在时就随构建复制一份。
$assets = Join-Path $taskRoot 'server/data/assets'
if (Test-Path $assets) {
  New-Item -ItemType Directory -Force -Path (Join-Path $taskBin 'data/assets') | Out-Null
  Copy-Item -Recurse -Force (Join-Path $assets '*') (Join-Path $taskBin 'data/assets')
}
Push-Location $taskRoot
try {
  if ($Target -eq 'server') { go build -tags headless -trimpath -ldflags '-s -w' -o (Join-Path $taskBin 'studio-server.exe') . }
  else { go build -trimpath -ldflags '-s -w -H windowsgui' -o (Join-Path $taskBin 'Live2DStudio.exe') . }
  if ($LASTEXITCODE -ne 0) { throw 'Go 构建失败' }
} finally { Pop-Location }
Write-Host "构建完成：$taskBin"

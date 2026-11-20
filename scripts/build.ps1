param(
  [ValidateSet('desktop','server')][string]$Target = 'desktop',
  [switch]$SkipInstall,
  [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskBin = if ($OutputDirectory) {
  $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
} else {
  Join-Path $taskRoot 'bin'
}
Push-Location (Join-Path $taskRoot 'frontend')
try {
  if (-not $SkipInstall) { npm ci; if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败' } }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw '前端构建失败' }
  New-Item -ItemType File -Force -Path (Join-Path $taskRoot 'server/internal/webui/dist/.gitkeep') | Out-Null
} finally { Pop-Location }
New-Item -ItemType Directory -Force -Path $taskBin | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $taskBin 'configs') | Out-Null
Copy-Item -LiteralPath (Join-Path $taskRoot 'server/configs/config.example.yaml') -Destination (Join-Path $taskBin 'configs/config.example.yaml')
# 只复制两个初始模型的运行时资源和随附说明。
$assets = Join-Path $taskRoot 'server/data/assets'
foreach ($model in 'mao_pro', 'shizuku') {
  $manifest = Join-Path $assets "$model/runtime/$model.model3.json"
  if (!(Test-Path -LiteralPath $manifest -PathType Leaf)) { continue }

  $destination = Join-Path $taskBin "data/assets/$model"
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  Copy-Item -Recurse -Force -LiteralPath (Join-Path $assets "$model/runtime") -Destination $destination
  $readme = Join-Path $assets "$model/ReadMe.txt"
  if (Test-Path -LiteralPath $readme -PathType Leaf) {
    Copy-Item -Force -LiteralPath $readme -Destination $destination
  }
}
$previousGoOS = $env:GOOS
Push-Location $taskRoot
try {
  $env:GOOS = 'windows'
  if ($Target -eq 'server') { go build -tags headless -trimpath -ldflags '-s -w' -o (Join-Path $taskBin 'studio-server.exe') . }
  else { go build -trimpath -ldflags '-s -w -H windowsgui' -o (Join-Path $taskBin 'Live2DStudio.exe') . }
  if ($LASTEXITCODE -ne 0) { throw 'Go 构建失败' }
} finally {
  $env:GOOS = $previousGoOS
  Pop-Location
}
Write-Host "构建完成：$taskBin"

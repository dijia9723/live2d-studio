$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
  wails3 dev
  if ($LASTEXITCODE -ne 0) { throw 'wails3 dev 启动失败' }
} finally { Pop-Location }

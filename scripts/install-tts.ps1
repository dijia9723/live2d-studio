[CmdletBinding()]
param(
    [ValidateSet('low', 'medium', 'high', 'all')]
    [string]$Tier = 'all',
    [string]$Destination = (Join-Path $PSScriptRoot '../server/tts-models'),
    [string]$Python = 'python',
    [string]$CacheDir
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Force -Path $root | Out-Null

$venv = Join-Path $root '.venv'
$runtime = if ($IsWindows -or $env:OS -eq 'Windows_NT') {
    Join-Path $venv 'Scripts/python.exe'
} else {
    Join-Path $venv 'bin/python'
}
if (-not (Test-Path -LiteralPath $runtime -PathType Leaf)) {
    & $Python -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw '创建 Python 虚拟环境失败' }
}
& $runtime -m pip install --disable-pip-version-check --only-binary=:all: 'sherpa-onnx==1.13.6'
if ($LASTEXITCODE -ne 0) { throw '安装 sherpa-onnx 失败' }
& $runtime -I -c 'import sherpa_onnx'
if ($LASTEXITCODE -ne 0) { throw '无法载入 sherpa-onnx 推理环境' }

$models = @(
    @{ tier = 'low'; folder = 'vits-icefall-zh-aishell3'; weights = 'model.onnx'; sha256 = 'AB468DB3A3308CDD861495E0DB2F25D79418A0C00639F74944C7CDF5DD8C6EC1' },
    @{ tier = 'medium'; folder = 'vits-zh-hf-fanchen-C'; weights = 'vits-zh-hf-fanchen-C.onnx'; sha256 = '523AAE3E6CF1BEF3C05E2B0105D1EE15D53987A3BB559F78BA84FB7C4F990BD6' },
    @{ tier = 'high'; folder = 'kokoro-multi-lang-v1_0'; weights = 'model.onnx'; sha256 = '60703707BC05CCD48D60E1EB723F38B07D6E474795A0B6A588D7220400E0F7A4' }
)
$source = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models'
foreach ($model in $models) {
    if ($Tier -ne 'all' -and $model.tier -ne $Tier) { continue }
    $target = Join-Path $root $model.folder
    if (Test-Path -LiteralPath (Join-Path $target $model.weights) -PathType Leaf) {
        Write-Host "$($model.folder) 已安装"
        continue
    }
    if (Test-Path -LiteralPath $target) { throw "目标目录不完整，请移走后重试。$target" }

    $stage = Join-Path $root ('.install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage | Out-Null
    try {
        $name = $model.folder + '.tar.bz2'
        $archive = Join-Path $stage $name
        if ($CacheDir -and (Test-Path -LiteralPath (Join-Path $CacheDir $name) -PathType Leaf)) {
            $archive = Join-Path $CacheDir $name
        } else {
            Write-Host "正在下载 $name"
            Invoke-WebRequest -Uri "$source/$name" -OutFile $archive
        }
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $model.sha256) {
            throw "$name 校验失败"
        }
        tar -xf $archive -C $stage
        $extracted = Join-Path $stage $model.folder
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $extracted $model.weights) -PathType Leaf)) {
            throw "$name 解压失败"
        }
        [IO.Directory]::Move($extracted, $target)
        Write-Host "$($model.folder) 已安装"
    } finally {
        $resolved = (Resolve-Path -LiteralPath $stage).ProviderPath
        if ((Split-Path -Parent $resolved) -eq $root -and (Split-Path -Leaf $resolved) -match '^\.install-[\da-f]{32}$') {
            Remove-Item -LiteralPath $resolved -Force -Recurse
        }
    }
}

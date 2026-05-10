#requires -Version 5.1
<#
.SYNOPSIS
    Faz download das bibliotecas CDN para self-hosting no repo Eventos.

.DESCRIPTION
    O admin Eventos usa SheetJS (xlsx) + JSZip via CDN (cdn.jsdelivr.net).
    Para resiliência (caso o CDN caia, esteja bloqueado pelo IT, ou para
    funcionamento offline), este script:
      1. Faz download das versões pinned para assets/lib/
      2. Actualiza index.html para apontar para os ficheiros locais
      3. Adiciona os ficheiros ao SHELL do service worker (sw.js)

    Idempotente — pode correr várias vezes.

.PARAMETER RepoPath
    Caminho para a pasta Eventos. Default: directório do script (..).

.EXAMPLE
    .\Download-Libs.ps1
    .\Download-Libs.ps1 -RepoPath "C:\repos\Eventos"
#>

[CmdletBinding()]
param(
    [string]$RepoPath = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

# Versões pinned — manter sincronizadas com index.html.
$Libs = @(
    @{
        Name    = 'xlsx'
        Version = '0.18.5'
        Url     = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'
        Local   = 'assets/lib/xlsx.full.min.js'
    },
    @{
        Name    = 'jszip'
        Version = '3.10.1'
        Url     = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js'
        Local   = 'assets/lib/jszip.min.js'
    }
)

Write-Host ""
Write-Host "RSB Eventos - Self-host libs" -ForegroundColor Cyan
Write-Host "Repo: $RepoPath"
Write-Host ""

if (-not (Test-Path $RepoPath)) {
    throw "RepoPath nao existe: $RepoPath"
}

$libDir = Join-Path $RepoPath 'assets\lib'
if (-not (Test-Path $libDir)) {
    New-Item -ItemType Directory -Path $libDir -Force | Out-Null
    Write-Host "Criada pasta: $libDir"
}

# 1. Download
foreach ($lib in $Libs) {
    $dest = Join-Path $RepoPath $lib.Local
    if (Test-Path $dest) {
        $size = (Get-Item $dest).Length
        Write-Host "[skip] $($lib.Name) v$($lib.Version) ja existe ($size bytes)"
        continue
    }
    Write-Host "[get ] $($lib.Name) v$($lib.Version) ..." -NoNewline
    try {
        Invoke-WebRequest -Uri $lib.Url -OutFile $dest -UseBasicParsing
        $size = (Get-Item $dest).Length
        Write-Host " OK ($size bytes)" -ForegroundColor Green
    } catch {
        Write-Host " FALHA: $($_.Exception.Message)" -ForegroundColor Red
        throw
    }
}

# 2. Patch index.html
$indexHtml = Join-Path $RepoPath 'index.html'
if (Test-Path $indexHtml) {
    $content = Get-Content $indexHtml -Raw -Encoding utf8
    $changed = $false
    foreach ($lib in $Libs) {
        $cdnSrc   = $lib.Url
        $localSrc = $lib.Local
        if ($content -match [regex]::Escape($cdnSrc)) {
            $content = $content -replace [regex]::Escape($cdnSrc), $localSrc
            Write-Host "[edit] index.html: $($lib.Name) -> $localSrc" -ForegroundColor Yellow
            $changed = $true
        } elseif ($content -match [regex]::Escape($localSrc)) {
            Write-Host "[skip] index.html: $($lib.Name) ja aponta para local"
        } else {
            Write-Warning "index.html nao tem referencia conhecida para $($lib.Name) - confirmar manualmente."
        }
    }
    if ($changed) {
        Set-Content -Path $indexHtml -Value $content -Encoding utf8 -NoNewline
        Write-Host "[save] index.html actualizado" -ForegroundColor Green
    }
} else {
    Write-Warning "index.html nao encontrado em $indexHtml"
}

# 3. Patch sw.js (acrescenta ao SHELL)
$swJs = Join-Path $RepoPath 'sw.js'
if (Test-Path $swJs) {
    $content = Get-Content $swJs -Raw -Encoding utf8
    $entriesNeeded = @()
    foreach ($lib in $Libs) {
        $entry = "'./$($lib.Local)'"
        if ($content -notmatch [regex]::Escape($entry)) {
            $entriesNeeded += $entry
        }
    }
    if ($entriesNeeded.Count -gt 0) {
        # Insere entradas antes do fecho ']' do array SHELL
        $insert = "  " + ($entriesNeeded -join ",`r`n  ") + ","
        $content = $content -replace "(const SHELL = \[)", "`$1`r`n$insert"
        Set-Content -Path $swJs -Value $content -Encoding utf8 -NoNewline
        Write-Host "[save] sw.js: acrescentadas $($entriesNeeded.Count) entrada(s) ao SHELL" -ForegroundColor Green
    } else {
        Write-Host "[skip] sw.js: SHELL ja contem as libs"
    }
} else {
    Write-Warning "sw.js nao encontrado em $swJs"
}

Write-Host ""
Write-Host "Concluido. Proximos passos:" -ForegroundColor Cyan
Write-Host "  1. Bump CACHE_VERSION em sw.js (ex.: rsb-eventos-v1 -> v2) para forcar refresh"
Write-Host "  2. git add assets/lib index.html sw.js && git commit -m 'self-host CDN libs'"
Write-Host "  3. git push"
Write-Host ""

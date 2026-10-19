param([switch]$CheckLayout)
$ErrorActionPreference = 'Stop'
try {
    $package = (Get-Item -LiteralPath (Join-Path $PSScriptRoot '..')).FullName
    foreach ($required in @('__init__.py', 'requirements.txt', 'Installers\install_dependencies.py', 'Installers\dependencies.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $package $required) -PathType Leaf)) {
            throw "Incomplete package: missing $required. Download and extract the complete ZIP, not the BAT separately."
        }
    }
    $scan = Get-Item -LiteralPath $package
    $comfy = $null
    while ($null -ne $scan) {
        if ((Test-Path -LiteralPath (Join-Path $scan.FullName 'main.py') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $scan.FullName 'custom_nodes') -PathType Container)) {
            $comfy = $scan.FullName
            break
        }
        $scan = $scan.Parent
    }
    if (-not $comfy) {
        throw "ComfyUI was not found above this package. Move the WHOLE folder '$package' directly into your intended ComfyUI\custom_nodes folder, then run its Install-Windows.bat. Do not copy only the BAT."
    }
    $custom = (Get-Item -LiteralPath (Join-Path $comfy 'custom_nodes')).FullName
    if ((Get-Item -LiteralPath $package).Parent.FullName -ne $custom) {
        Write-Host 'EXTRA FOLDER LEVEL DETECTED - nothing has been installed.' -ForegroundColor Yellow
        Write-Host "The actual node package is: $package"
        Write-Host "Move THAT WHOLE inner folder directly into: $custom"
        Write-Host "Suggested destination: $(Join-Path $custom 'Muse-CharacterSheet-H3')"
        Write-Host 'Its __init__.py and Install-Windows.bat must be immediately inside that folder.'
        Write-Host 'Do not merge with an existing installation. Keep backups outside custom_nodes.'
        exit 2
    }
    Write-Host "Package layout OK: $package"
    Write-Host "ComfyUI: $comfy"
    if ($CheckLayout) { exit 0 }
    $python = $null
    foreach ($candidate in @((Join-Path $comfy '..\python_embeded\python.exe'), (Join-Path $comfy '.venv\Scripts\python.exe'), (Join-Path $comfy 'venv\Scripts\python.exe'))) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $python = (Get-Item -LiteralPath $candidate).FullName; break }
    }
    if (-not $python) {
        $python = (Read-Host "Enter the full path to THIS ComfyUI instance's python.exe").Trim('"')
        if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'Python executable not found. Nothing installed.' }
    }
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is required. Install Git for Windows and reopen this launcher.' }
    $helper = Join-Path $PSScriptRoot 'install_dependencies.py'
    & $python $helper --comfyui $comfy --enhanced
    if ($LASTEXITCODE -ne 0) { throw 'Dependency planning failed. Nothing installed.' }
    Write-Host 'Close ComfyUI before proceeding. Models are NOT downloaded. Existing node folders are retained.'
    if ((Read-Host 'Install the listed dependencies? [y/N]') -notmatch '^(y|yes)$') { Write-Host 'Cancelled. Nothing installed.'; exit 0 }
    & $python $helper --comfyui $comfy --enhanced --install --offer-dlss-runtime
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Review the error above; setup may be partially complete.' }
    Write-Host 'Node setup finished. See INSTALLATION.md for models and the separate DLSS runtime. Restart ComfyUI and refresh your browser.'
    exit 0
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

# Install the /ship skill into your user-level Claude Code config (Windows PowerShell).
# Run from this folder:  powershell -ExecutionPolicy Bypass -File .\install.ps1
# Re-run to update.
$ErrorActionPreference = 'Stop'

$src = Join-Path $PSScriptRoot 'skill'
$claudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$skillsDir = Join-Path $claudeDir 'skills'
$dest = Join-Path $skillsDir 'ship'
$staging = "$dest.installing"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'install: node is required on PATH' }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'install: git is required on PATH' }
if (-not (Test-Path (Join-Path $src 'SKILL.md'))) { throw "install: $src\SKILL.md not found" }

New-Item -ItemType Directory -Force -Path $skillsDir | Out-Null
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
Copy-Item -Recurse -Path $src -Destination $staging

# Hooks run without a shell, so the skill needs an absolute path; forward slashes
# work for node, Git Bash and PowerShell alike.
$shipHome = $dest -replace '\\', '/'
$skillFile = Join-Path $staging 'SKILL.md'
$text = [System.IO.File]::ReadAllText($skillFile)
$text = $text.Replace('__SHIP_HOME__', $shipHome)
[System.IO.File]::WriteAllText($skillFile, $text, (New-Object System.Text.UTF8Encoding($false)))

if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
Move-Item -Path $staging -Destination $dest

& node (Join-Path $dest 'scripts/ship.mjs') help | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'install: the helper failed to start; check your Node version (18 or newer)' }

Write-Host "Installed /ship to $dest"
Write-Host 'Start Claude Code in a repo (auto mode recommended: claude --permission-mode auto) and run: /ship <task>'

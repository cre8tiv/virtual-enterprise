<#
.SYNOPSIS
  Check, and optionally install, operator-machine prerequisites on Windows.
  macOS/Linux: use prereqs.sh.

.DESCRIPTION
  Without -Install the script only checks and changes nothing.
  With -Install it installs missing tools with winget (fallback: Chocolatey), or by direct download
  for go-passbolt-cli, and npm for CLI for Microsoft 365.
  Exit code: 0 when every required tool is present and meets its minimum version, 1 otherwise.
  Compatible with Windows PowerShell 5.1 and PowerShell 7+.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\prereqs\prereqs.ps1
  powershell -ExecutionPolicy Bypass -File scripts\prereqs\prereqs.ps1 -Install
#>
[CmdletBinding()]
param([switch]$Install)

$ErrorActionPreference = 'Continue'
$script:Failures = 0
$script:Notes = New-Object System.Collections.Generic.List[string]

$Arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
$Pkg = if (Get-Command winget -ErrorAction SilentlyContinue) { 'winget' }
       elseif (Get-Command choco -ErrorAction SilentlyContinue) { 'choco' }
       else { $null }
$PassboltDir = Join-Path $env:LOCALAPPDATA 'Programs\go-passbolt-cli'

function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

function Get-ToolVersion {
    param([scriptblock]$Command)
    try {
        $output = (& $Command 2>$null) | Out-String
        if ($output -match '(\d+\.\d+(\.\d+)?)') { return $Matches[1] }
    } catch { }
    return $null
}

function ConvertTo-Version {
    param([string]$Value)
    $parts = ($Value.Split('.') + @('0', '0', '0'))[0..2]
    return [version]($parts -join '.')
}

function Test-VersionAtLeast {
    param([string]$Actual, [string]$Minimum)
    return (ConvertTo-Version $Actual) -ge (ConvertTo-Version $Minimum)
}

# Installers send tool output to the host so they return only a success boolean.
function Install-Package {
    param([string]$WingetId, [string]$ChocoId)
    if ($Pkg -eq 'winget') {
        winget install --id $WingetId --exact --silent --accept-source-agreements --accept-package-agreements | Out-Host
        return ($LASTEXITCODE -eq 0)
    }
    if ($Pkg -eq 'choco') {
        choco install $ChocoId -y | Out-Host
        return ($LASTEXITCODE -eq 0)
    }
    $script:Notes.Add('Install winget (App Installer from the Microsoft Store) or Chocolatey to enable installs.')
    return $false
}

function Install-Git { Install-Package 'Git.Git' 'git' }

function Install-Docker {
    if (Get-Command docker -ErrorAction SilentlyContinue) { return $true }
    $ok = Install-Package 'Docker.DockerDesktop' 'docker-desktop'
    if ($ok) { $script:Notes.Add('Docker Desktop needs WSL 2 and may require a sign-out/restart. Start it once, then re-run this script.') }
    return $ok
}

function Install-Node { Install-Package 'OpenJS.NodeJS.LTS' 'nodejs-lts' }

function Install-Terraform { Install-Package 'Hashicorp.Terraform' 'terraform' }

function Install-PassboltCli {
    try {
        $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/passbolt/go-passbolt-cli/releases/latest' -UseBasicParsing
        $asset = $release.assets | Where-Object { $_.name -like "*_windows_$Arch.zip" } | Select-Object -First 1
        if (-not $asset) { return $false }
        $zip = Join-Path $env:TEMP $asset.name
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
        New-Item -ItemType Directory -Force -Path $PassboltDir | Out-Null
        Expand-Archive -Path $zip -DestinationPath $PassboltDir -Force
        Remove-Item $zip -Force
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if (($userPath -split ';') -notcontains $PassboltDir) {
            [Environment]::SetEnvironmentVariable('Path', "$userPath;$PassboltDir", 'User')
        }
        return $true
    } catch {
        $script:Notes.Add("go-passbolt-cli download failed: $($_.Exception.Message)")
        return $false
    }
}

function Install-M365 {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { return $false }
    npm install -g '@pnp/cli-microsoft365' | Out-Host
    return ($LASTEXITCODE -eq 0)
}

function Test-Tool {
    param([string]$Label, [string]$Minimum, [scriptblock]$VersionCommand, [scriptblock]$Installer)
    $version = Get-ToolVersion $VersionCommand
    if ($version -and (Test-VersionAtLeast $version $Minimum)) {
        '  {0,-26} OK       {1}' -f $Label, $version
        return
    }
    $state = if ($version) { 'OUTDATED' } else { 'MISSING' }
    if ($Install) {
        '  {0,-26} {1,-8} installing...' -f $Label, $state
        if (& $Installer) {
            Update-SessionPath
            $version = Get-ToolVersion $VersionCommand
            if ($version -and (Test-VersionAtLeast $version $Minimum)) {
                '  {0,-26} OK       {1}' -f $Label, $version
                return
            }
        }
        '  {0,-26} FAILED   needs >= {1}' -f $Label, $Minimum
    } else {
        '  {0,-26} {1,-8} needs >= {2}' -f $Label, $state, $Minimum
    }
    $script:Failures++
}

$mode = if ($Install) { 'install' } else { 'check' }
"Operator prerequisites (Windows/$Arch, package manager: $(if ($Pkg) { $Pkg } else { 'none' }), mode: $mode)"

Test-Tool 'git'                        '2.30' { git --version }                                  { Install-Git }
Test-Tool 'docker'                     '24.0' { docker version --format '{{.Client.Version}}' }  { Install-Docker }
Test-Tool 'docker compose'             '2.20' { docker compose version --short }                 { Install-Docker }
Test-Tool 'node'                       '20.0' { node --version }                                 { Install-Node }
Test-Tool 'npm'                        '10.0' { npm --version }                                  { Install-Node }
Test-Tool 'terraform'                  '1.5'  { terraform version }                              { Install-Terraform }
Test-Tool 'passbolt (go-passbolt-cli)' '0.5'  { passbolt --version }                             { Install-PassboltCli }
Test-Tool 'm365 (CLI for M365)'        '7.0'  { m365 version }                                   { Install-M365 }

# Docker daemon: installed is not enough, it must be running.
if (Get-Command docker -ErrorAction SilentlyContinue) {
    docker info *> $null
    if ($LASTEXITCODE -eq 0) {
        '  {0,-26} OK' -f 'docker daemon'
    } else {
        '  {0,-26} NOT RUNNING  start Docker Desktop' -f 'docker daemon'
        $script:Failures++
    }
}

'  Manual: install the Passbolt browser extension in your browser (https://www.passbolt.com/download).'
'  Scripts in infra/compose/vault (backup.sh, restore.sh) run in Git Bash, installed with git.'
foreach ($note in $script:Notes) { "  Note: $note" }

if ($script:Failures -gt 0) {
    $hint = if ($Install) { '' } else { ' Re-run with -Install to install missing tools.' }
    "Result: $($script:Failures) requirement(s) not met.$hint"
    exit 1
}
'Result: all prerequisites met.'
exit 0

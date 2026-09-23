#!/usr/bin/env bash
# Check, and optionally install, operator-machine prerequisites on macOS and Linux.
# Windows: use prereqs.ps1.
#
# Usage: scripts/prereqs/prereqs.sh [--install]
#   (no flag)  check only; changes nothing
#   --install  install missing tools (Homebrew on macOS; apt/dnf or direct download on Linux)
# Exit code: 0 when every required tool is present and meets its minimum version, 1 otherwise.
set -uo pipefail

INSTALL=false
[[ "${1:-}" == "--install" ]] && INSTALL=true

OS="$(uname -s)"
case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64 ;;
  arm64 | aarch64) ARCH=arm64 ;;
  *) ARCH="$(uname -m)" ;;
esac
LOCAL_BIN="$HOME/.local/bin"
PKG=""
if [[ "$OS" == "Darwin" ]]; then
  command -v brew >/dev/null 2>&1 && PKG=brew
elif command -v apt-get >/dev/null 2>&1; then
  PKG=apt
elif command -v dnf >/dev/null 2>&1; then
  PKG=dnf
fi

failures=0
notes=()

have() { command -v "$1" >/dev/null 2>&1; }

# First dotted version number found in the input, e.g. "git version 2.45.1" -> 2.45.1
extract_version() { grep -Eo '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n1; }

# version_ge <actual> <minimum>
version_ge() {
  local IFS=.
  local -a a=($1) b=($2)
  local i x y
  for i in 0 1 2; do
    x=${a[i]:-0}
    y=${b[i]:-0}
    ((10#$x > 10#$y)) && return 0
    ((10#$x < 10#$y)) && return 1
  done
  return 0
}

pkg_install() {
  case "$PKG" in
    brew) brew install "$@" ;;
    apt) sudo apt-get update -qq && sudo apt-get install -y "$@" ;;
    dnf) sudo dnf install -y "$@" ;;
    *) return 1 ;;
  esac
}

ensure_local_bin() {
  mkdir -p "$LOCAL_BIN"
  case ":$PATH:" in
    *":$LOCAL_BIN:"*) ;;
    *) notes+=("Add $LOCAL_BIN to your PATH (e.g. in ~/.bashrc or ~/.zshrc), then open a new shell.") ;;
  esac
}

# --- installers -------------------------------------------------------------

install_git() { pkg_install git; }

install_docker() {
  have docker && return 0
  if [[ "$PKG" == "brew" ]]; then
    brew install --cask docker-desktop && notes+=("Start Docker Desktop once from Applications, then re-run this script.")
  else
    notes+=("Install Docker Engine + Compose plugin: https://docs.docker.com/engine/install/ (then add your user to the 'docker' group).")
    return 1
  fi
}

install_node() {
  if [[ "$PKG" == "brew" ]]; then
    brew install node
  else
    notes+=("Install Node.js LTS (>= 20) via your distro's NodeSource packages or nvm: https://nodejs.org/en/download")
    return 1
  fi
}

install_terraform() {
  if [[ "$PKG" == "brew" ]]; then
    brew install hashicorp/tap/terraform
    return
  fi
  have unzip || pkg_install unzip || return 1
  local version
  version="$(curl -fsSL https://checkpoint-api.hashicorp.com/v1/check/terraform | grep -Eo '"current_version":"[^"]+"' | cut -d'"' -f4)"
  [[ -n "$version" ]] || return 1
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/terraform.zip" "https://releases.hashicorp.com/terraform/${version}/terraform_${version}_linux_${ARCH}.zip" &&
    ensure_local_bin &&
    unzip -oq "$tmp/terraform.zip" terraform -d "$LOCAL_BIN"
  local rc=$?
  rm -rf "$tmp"
  return $rc
}

install_passbolt_cli() {
  local os
  os="$(echo "$OS" | tr '[:upper:]' '[:lower:]')"
  local url
  url="$(curl -fsSL https://api.github.com/repos/passbolt/go-passbolt-cli/releases/latest |
    grep -Eo "https://[^\"]+_${os}_${ARCH}\.tar\.gz" | head -n1)"
  [[ -n "$url" ]] || return 1
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/cli.tar.gz" "$url" &&
    ensure_local_bin &&
    tar -xzf "$tmp/cli.tar.gz" -C "$tmp" passbolt &&
    install -m 0755 "$tmp/passbolt" "$LOCAL_BIN/passbolt"
  local rc=$?
  rm -rf "$tmp"
  return $rc
}

install_m365() { have npm && npm install -g @pnp/cli-microsoft365; }

# --- checks -----------------------------------------------------------------

# check <label> <min-version> <version-command> <installer>
check() {
  local label="$1" min="$2" cmd="$3" installer="$4"
  local version
  version="$(eval "$cmd" 2>/dev/null | extract_version)"
  if [[ -n "$version" ]] && version_ge "$version" "$min"; then
    printf '  %-26s OK       %s\n' "$label" "$version"
    return
  fi
  local state="MISSING"
  [[ -n "$version" ]] && state="OUTDATED"
  if $INSTALL; then
    printf '  %-26s %-8s installing...\n' "$label" "$state"
    if $installer; then
      hash -r
      version="$(eval "$cmd" 2>/dev/null | extract_version)"
      if [[ -n "$version" ]] && version_ge "$version" "$min"; then
        printf '  %-26s OK       %s\n' "$label" "$version"
        return
      fi
    fi
    printf '  %-26s FAILED   needs >= %s\n' "$label" "$min"
  else
    printf '  %-26s %-8s needs >= %s\n' "$label" "$state" "$min"
  fi
  failures=$((failures + 1))
}

echo "Operator prerequisites ($OS/$ARCH, package manager: ${PKG:-none}, mode: $($INSTALL && echo install || echo check))"

if [[ "$OS" == "Darwin" && -z "$PKG" ]]; then
  notes+=("Homebrew is required for installs on macOS: https://brew.sh")
fi

check "git"                   2.30  "git --version"                 install_git
check "docker"                24.0  "docker version --format '{{.Client.Version}}'" install_docker
check "docker compose"        2.20  "docker compose version --short" install_docker
check "node"                  20.0  "node --version"                install_node
check "npm"                   10.0  "npm --version"                 install_node
check "terraform"             1.5   "terraform version"             install_terraform
check "passbolt (go-passbolt-cli)" 0.5 "passbolt --version"         install_passbolt_cli
check "m365 (CLI for M365)"   7.0   "m365 version"                  install_m365

# Docker daemon: installed is not enough, it must be running.
if have docker; then
  if docker info >/dev/null 2>&1; then
    printf '  %-26s OK\n' "docker daemon"
  else
    printf '  %-26s %s\n' "docker daemon" "NOT RUNNING  start Docker Desktop / 'sudo systemctl start docker'"
    failures=$((failures + 1))
  fi
fi

echo "  Manual: install the Passbolt browser extension in your browser (https://www.passbolt.com/download)."

for note in "${notes[@]+"${notes[@]}"}"; do
  echo "  Note: $note"
done

if ((failures > 0)); then
  echo "Result: $failures requirement(s) not met.$($INSTALL || echo ' Re-run with --install to install missing tools.')"
  exit 1
fi
echo "Result: all prerequisites met."

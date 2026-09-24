#!/usr/bin/env bash
# Back up the Passbolt vault: database dump, server GPG keys, JWT keys.
# The output contains secrets. Write it OUTSIDE the repo and store it encrypted/offline.
#
# Usage: ./backup.sh <output-dir>
set -euo pipefail
cd "$(dirname "$0")"

out="${1:?usage: backup.sh <output-dir>}"
dest="$out/passbolt-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$dest"

docker compose exec -T db sh -c 'exec mariadb-dump --single-transaction -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' > "$dest/passbolt.sql"
# Git Bash on Windows: docker.exe needs a Windows path (C:/...), not /c/...
native="$dest"
if command -v cygpath >/dev/null 2>&1; then native="$(cygpath -m "$dest")"; fi
docker compose cp passbolt:/etc/passbolt/gpg "$native/gpg"
docker compose cp passbolt:/etc/passbolt/jwt "$native/jwt"

echo "Backup written to $dest"

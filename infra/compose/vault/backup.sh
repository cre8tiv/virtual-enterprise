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
docker compose cp passbolt:/etc/passbolt/gpg "$dest/gpg"
docker compose cp passbolt:/etc/passbolt/jwt "$dest/jwt"

echo "Backup written to $dest"

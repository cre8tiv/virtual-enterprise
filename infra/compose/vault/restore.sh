#!/usr/bin/env bash
# Restore a Passbolt backup into a FRESH stack on this host (empty volumes).
# .env must use the same APP_FULL_BASE_URL as the source instance.
#
# Usage: ./restore.sh <backup-dir>   (a directory produced by backup.sh)
set -euo pipefail
cd "$(dirname "$0")"

src="${1:?usage: restore.sh <backup-dir>}"
for f in passbolt.sql gpg/serverkey.asc gpg/serverkey_private.asc; do
  [[ -f "$src/$f" ]] || { echo "Missing $src/$f" >&2; exit 1; }
done

docker compose up -d --wait db
docker compose exec -T db sh -c 'exec mariadb -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' < "$src/passbolt.sql"

# Put the server keys in place before Passbolt's first start so it doesn't generate new ones.
docker compose create passbolt
docker compose cp "$src/gpg/." passbolt:/etc/passbolt/gpg
docker compose cp "$src/jwt/." passbolt:/etc/passbolt/jwt
docker compose start passbolt
docker compose exec -T passbolt chown -R www-data:www-data /etc/passbolt/gpg /etc/passbolt/jwt
docker compose restart passbolt

echo "Restored. Run the healthcheck:"
echo "  docker compose exec passbolt su -s /bin/bash -c '/usr/share/php/passbolt/bin/cake passbolt healthcheck' www-data"

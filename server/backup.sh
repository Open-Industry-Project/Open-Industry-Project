#!/usr/bin/env bash
# Nightly online backup of the collab SQLite db, run ON the VM by
# oip-collab-backup.timer (see server/systemd/, installed by deploy.sh).
#
# sqlite3's .backup is safe against the live server (it takes a consistent copy
# without stopping writers). Output is gzipped; only the newest $KEEP are kept.
#
#   DB   - source database   (default: the systemd service's DB_PATH)
#   DIR  - backup directory  (default: /var/lib/oip-collab/backups)
#   KEEP - retained backups  (default: 14)
set -euo pipefail

DB="${DB:-/var/lib/oip-collab/collab.sqlite}"
DIR="${DIR:-/var/lib/oip-collab/backups}"
KEEP="${KEEP:-14}"

mkdir -p "$DIR"
stamp="$(date -u +%Y%m%d-%H%M%S)"
out="$DIR/collab-$stamp.sqlite"

sqlite3 "$DB" ".backup '$out'"
gzip -f "$out"

# rotate: drop everything beyond the newest $KEEP
ls -1t "$DIR"/collab-*.sqlite.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm --

# The rooms' part assets (server/assets.mjs): files named by the SHA-256 of their bytes, so a file never changes once
# written. An add-only mirror is the whole backup: copy what is new, never delete (an asset the server swept may still
# be named by a room in an older db backup above).
ASSETS="${ASSETS:-$(dirname "$DB")/assets}"
if [ -d "$ASSETS" ]; then
  mkdir -p "$DIR/assets"
  find "$ASSETS" -maxdepth 1 -type f -regextype posix-extended -regex '.*/[0-9a-f]{64}' -exec cp -n -t "$DIR/assets" {} +
fi

echo "backup ok: $out.gz"

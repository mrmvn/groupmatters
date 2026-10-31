#!/bin/sh
# Online SQLite backup (safe with WAL), keeps the last $KEEP generations.
set -eu
DB="${DB_PATH:-/var/lib/groupmatters/register.sqlite}"
DIR="${BACKUP_DIR:-/var/lib/groupmatters/backups}"
KEEP="${KEEP:-14}"
mkdir -p "$DIR"
out="$DIR/register-$(date +%F).sqlite"
sqlite3 "$DB" ".backup '$out'"
[ "$(sqlite3 "$out" 'PRAGMA integrity_check;')" = ok ] || { echo "integrity check failed: $out" >&2; exit 1; }
ls -1t "$DIR"/register-*.sqlite | tail -n +"$((KEEP + 1))" | xargs -r rm --

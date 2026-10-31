#!/bin/sh
# Copy the server's backups to this machine (off-server copy).
set -eu
cd "$(dirname "$0")/.."
[ -f .deploy.env ] && . ./.deploy.env
: "${DEPLOY_HOST:?set DEPLOY_HOST}"
DEST="${BACKUP_DEST:-$HOME/groupmatters-backups}"
mkdir -p "$DEST"
rsync -a "$DEPLOY_HOST:/var/lib/groupmatters/backups/" "$DEST/"

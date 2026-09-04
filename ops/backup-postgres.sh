#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_DIR:?BACKUP_DIR is required}"

RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
TMP="$BACKUP_DIR/.arles-$STAMP.dump.tmp"
OUT="$BACKUP_DIR/arles-$STAMP.dump"

umask 077
pg_dump --format=custom --no-owner --no-acl --dbname="$DATABASE_URL" --file="$TMP"
pg_restore --list "$TMP" >/dev/null
mv "$TMP" "$OUT"

# Delete only backup files created by this script.
find "$BACKUP_DIR" -type f -name 'arles-*.dump' -mtime "+$RETENTION_DAYS" -delete
printf '%s\n' "$OUT"

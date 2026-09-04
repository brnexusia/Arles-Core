#!/bin/sh
set -eu

: "${BACKUP_FILE:?BACKUP_FILE is required}"
: "${VERIFY_DATABASE_URL:?VERIFY_DATABASE_URL is required}"

# VERIFY_DATABASE_URL must point to an isolated disposable database.
case "$VERIFY_DATABASE_URL" in
  *production*|*prod*)
    echo "Refusing to verify against a URL that looks like production." >&2
    exit 2
    ;;
esac

pg_restore --list "$BACKUP_FILE" >/dev/null
pg_restore --clean --if-exists --no-owner --no-acl --dbname="$VERIFY_DATABASE_URL" "$BACKUP_FILE"
psql "$VERIFY_DATABASE_URL" -v ON_ERROR_STOP=1 -c "select count(*) as companies from companies;" >/dev/null
psql "$VERIFY_DATABASE_URL" -v ON_ERROR_STOP=1 -c "select count(*) as auth_users from auth_users;" >/dev/null

echo "backup_restore_verified"

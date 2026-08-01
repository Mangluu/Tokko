#!/bin/sh

case "${USER_ID:-}" in
  ""|*[!0-9]*)
    echo "Set USER_ID to the numeric onboarding user ID." >&2
    exit 1
    ;;
esac

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set." >&2
  exit 1
fi

exec psql "$DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -v user_id="$USER_ID" \
  -f scripts/check-user.sql

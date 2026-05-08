#!/usr/bin/env sh
set -eu

# Clean restart for this repo's docker-compose stack.
# - Removes containers and named volumes (db_data, directus_uploads)
# - Starts services again
# - Optionally runs the seed job
#
# Usage:
#   ./scripts/compose-reset.sh           # reset + start + seed
#   ./scripts/compose-reset.sh --no-seed # reset + start only

NO_SEED=0
if [ "${1:-}" = "--no-seed" ]; then
  NO_SEED=1
fi

cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed or not on PATH" >&2
  exit 1
fi

echo "Stopping stack and removing volumes (DATA LOSS)."
docker compose down --volumes --remove-orphans

echo "Starting database, cache, and directus."
docker compose up -d database cache directus

# Wait for Directus to respond (avoid flakiness on fresh init / migrations)
echo "Waiting for Directus health endpoint..."
i=0
until curl -sf "http://localhost:8055/server/health" >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -gt 120 ]; then
    echo "Directus did not become ready in time. Check logs with: docker compose logs -f directus" >&2
    exit 1
  fi
  sleep 2
done
echo "Directus is up."

if [ "$NO_SEED" -eq 0 ]; then
  echo "Running seed job..."
  docker compose run --rm seed
fi

echo "Done."

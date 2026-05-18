#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"

# Rebuilds and recreates only the code-bearing services (mcp + agent).
# Leaves all volumes, Directus content, and seeded data intact.
# Use this for code-only changes; use docker-clean-start.sh for a full reset.

NO_CACHE=0
for arg in "$@"; do
  case "$arg" in
    --no-cache) NO_CACHE=1 ;;
    --help|-h)
      echo "Usage: $0 [--no-cache]"
      echo ""
      echo "  Rebuilds + recreates mcp and agent without wiping any data."
      echo ""
      echo "  --no-cache  Force a no-cache rebuild of mcp and agent images"
      exit 0 ;;
  esac
done

PROJECT=$(echo "${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}" | tr '[:upper:]' '[:lower:]')

echo "Stopping mcp + agent..."
docker compose rm -sf mcp agent >/dev/null 2>&1 || true

# Drop the built images so the next build can't reuse a stale layer cache by
# accident — same trick the clean-start script uses.
for svc in mcp agent; do
  docker image rm -f "${PROJECT}-${svc}" "${PROJECT}_${svc}" >/dev/null 2>&1 || true
done

echo "Building images..."
if [ "$NO_CACHE" -eq 1 ]; then
  docker compose build --no-cache mcp agent
else
  docker compose build mcp agent
fi

echo "Starting mcp + agent..."
docker compose up -d --force-recreate mcp agent

echo "Done. Agent UI: http://localhost:8000   MCP: http://localhost:3001/mcp"

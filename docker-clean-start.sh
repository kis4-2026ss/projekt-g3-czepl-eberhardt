#!/usr/bin/env sh
set -e

cd "$(dirname "$0")"

echo "Stopping all containers and removing volumes..."
docker compose down --volumes --remove-orphans

echo "Starting stack..."
docker compose up -d database cache directus website mcp-server

echo "Waiting for Directus..."
until curl -sf http://localhost:8055/server/health >/dev/null 2>&1; do sleep 2; done
echo "Directus is up."

echo "Running seed..."
docker compose run --rm seed

echo ""
echo "Done."
echo "  Directus   → http://localhost:8055  (admin@gmail.at / admin)"
echo "  Website    → http://localhost:4321"
echo "  MCP Server → http://localhost:3001/mcp"

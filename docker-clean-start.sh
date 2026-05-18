#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"

# Volumes wiped on a normal clean restart (CMS data and uploads).
WIPE="db_data directus_uploads"

# Volumes preserved by default — slow to rebuild and rarely the source of bugs:
#   website_node_modules         ~ Astro deps for the main site
#   website_preview_node_modules ~ Astro deps for the preview instance
KEEP="website_node_modules website_preview_node_modules"

FULL=0
NO_CACHE=0
for arg in "$@"; do
  case "$arg" in
    --full|-f) FULL=1 ;;
    --no-cache) NO_CACHE=1 ;;
    --help|-h)
      echo "Usage: $0 [--full] [--no-cache]"
      echo ""
      echo "  Resets the stack to a clean state and re-seeds Directus."
      echo "  By default node_modules volumes are preserved."
      echo "  The MCP server image is ALWAYS rebuilt from source."
      echo ""
      echo "  --full      Also wipe: $KEEP"
      echo "  --no-cache  Force a no-cache rebuild of all built images"
      exit 0 ;;
  esac
done

PROJECT=$(echo "${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}" | tr '[:upper:]' '[:lower:]')

echo "Stopping containers..."
docker compose down --remove-orphans

if [ "$FULL" -eq 1 ]; then
  echo "Full reset — wiping everything."
  WIPE="$WIPE $KEEP"
  KEEP=""
fi

echo "Removing volumes: $WIPE"
for vol in $WIPE; do
  docker volume rm -f "${PROJECT}_${vol}" >/dev/null 2>&1 || true
done

if [ -n "$KEEP" ]; then
  echo "Preserving:      $KEEP  (use --full to wipe these too)"
fi

# Remove built images so they always pick up the latest source code.
# (compose --build alone can serve a cached layer if Docker thinks src/ is unchanged.)
echo "Removing built images (forces fresh rebuild)..."
docker compose rm -f mcp-server agent-api >/dev/null 2>&1 || true
docker image rm -f "${PROJECT}-mcp-server" "${PROJECT}_mcp-server" >/dev/null 2>&1 || true
docker image rm -f "${PROJECT}-agent-api" "${PROJECT}_agent-api" >/dev/null 2>&1 || true

echo "Building images..."
if [ "$NO_CACHE" -eq 1 ]; then
  docker compose build --no-cache --pull mcp-server agent-api
else
  docker compose build mcp-server agent-api
fi

echo "Starting stack..."
docker compose up -d --build --force-recreate database cache directus website website-preview mcp-server agent-api

echo "Waiting for Directus..."
until curl -sf http://localhost:8055/server/health >/dev/null 2>&1; do sleep 2; done
echo "Directus is up."

echo "Running seed..."
docker compose run --rm seed

echo ""
echo "Done."
echo "  Directus        → http://localhost:8055  (admin@gmail.at / admin)"
echo "  Website         → http://localhost:4321"
echo "  Website Preview → http://localhost:4322"
echo "  MCP Server      → http://localhost:3001/mcp"
echo "  Agent UI        → http://localhost:8000"
echo "──────────────────────────────────────────────────────────────"
echo "Claude Desktop setup"
echo ""
echo "Add to ~/Library/Application Support/Claude/claude_desktop_config.json"
echo "(Windows: %APPDATA%\\Claude\\claude_desktop_config.json)"
echo ""
echo '  {'
echo '    "mcpServers": {'
echo '      "directus": {'
echo '        "command": "npx",'
echo '        "args": ["-y", "mcp-remote", "http://localhost:3001/mcp"]'
echo '      }'
echo '    }'
echo '  }'
echo ""
echo "Then restart Claude Desktop."
echo "──────────────────────────────────────────────────────────────"

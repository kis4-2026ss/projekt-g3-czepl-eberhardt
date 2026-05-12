#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"

# Volumes wiped on a normal clean restart (CMS data, uploads, chat profiles).
WIPE="db_data directus_uploads chat_app_data"

# Volumes preserved by default — slow to rebuild and rarely the source of bugs:
#   ollama_data            ~ 4–10 GB of pulled LLM weights
#   website_node_modules   ~ Astro dev deps
#   chat_app_node_modules  ~ chat-app deps (incl. compiled better-sqlite3)
KEEP="ollama_data website_node_modules chat_app_node_modules"

FULL=0
for arg in "$@"; do
  case "$arg" in
    --full|-f) FULL=1 ;;
    --help|-h)
      echo "Usage: $0 [--full]"
      echo ""
      echo "  Resets the stack to a clean state and re-seeds Directus."
      echo "  By default the Ollama model cache and node_modules volumes are preserved."
      echo ""
      echo "  --full    Also wipe: $KEEP"
      exit 0 ;;
  esac
done

PROJECT="${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}"

echo "Stopping containers..."
docker compose down --remove-orphans

if [ "$FULL" -eq 1 ]; then
  echo "Full reset — wiping everything including the Ollama model cache."
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

echo "Starting stack..."
docker compose up -d database cache directus website mcp-server ollama chat-app

echo "Waiting for Directus..."
until curl -sf http://localhost:8055/server/health >/dev/null 2>&1; do sleep 2; done
echo "Directus is up."

echo "Running seed..."
docker compose run --rm seed

echo ""
echo "Done."
echo "  Directus    → http://localhost:8055  (admin@gmail.at / admin)"
echo "  Website     → http://localhost:4321"
echo "  MCP Server  → http://localhost:3001/mcp"
echo "  MCP Console → http://localhost:4322"

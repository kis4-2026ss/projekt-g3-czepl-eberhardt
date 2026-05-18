#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"

# Volumes wiped on a normal clean restart.
# agent_data is always wiped so the instance DB re-seeds with correct defaults.
WIPE="adlerwirt_db adlerwirt_uploads fitcore_db fitcore_uploads agent_data"

# Volumes preserved by default — slow to rebuild and rarely the source of bugs:
KEEP="adlerwirt_website_modules fitcore_website_modules"

FULL=0
NO_CACHE=0
for arg in "$@"; do
  case "$arg" in
    --full|-f) FULL=1 ;;
    --no-cache) NO_CACHE=1 ;;
    --help|-h)
      echo "Usage: $0 [--full] [--no-cache]"
      echo ""
      echo "  Resets the stack to a clean state and re-seeds both Directus instances."
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
echo "Removing built images (forces fresh rebuild)..."
docker compose rm -f mcp agent >/dev/null 2>&1 || true
for svc in mcp agent; do
  docker image rm -f "${PROJECT}-${svc}" "${PROJECT}_${svc}" >/dev/null 2>&1 || true
done

echo "Building images..."
if [ "$NO_CACHE" -eq 1 ]; then
  docker compose build --no-cache --pull mcp agent
else
  docker compose build mcp agent
fi

echo "Starting stack..."
docker compose up -d --build --force-recreate

echo "Waiting for Directus (Adlerwirt)..."
until curl -sf http://localhost:8055/server/health >/dev/null 2>&1; do sleep 2; done
echo "Directus (Adlerwirt) is up."

echo "Waiting for Directus (FitCore)..."
until curl -sf http://localhost:8056/server/health >/dev/null 2>&1; do sleep 2; done
echo "Directus (FitCore) is up."

echo "Running seeds..."
docker compose run --rm adlerwirt-seed
docker compose run --rm fitcore-seed

cat <<'EOF'

┌─────────────────────────────────────────────────────────────┐
│  Stack ready                                                 │
├──────────────────┬──────────────────────────────────────────┤
│  Agent UI        │  http://localhost:8000                   │
│  MCP             │  http://localhost:3001/mcp               │
│  Preview proxy   │  http://*.localhost:4322                 │
├──────────────────┼──────────────────────────────────────────┤
│  Adlerwirt                                                  │
│    Directus      │  http://localhost:8055                   │
│                  │  admin@gmail.at / admin                  │
│    Website       │  http://localhost:4321                   │
├──────────────────┼──────────────────────────────────────────┤
│  FitCore                                                    │
│    Directus      │  http://localhost:8056                   │
│                  │  admin@fitcore.studio / admin            │
│    Website       │  http://localhost:4323                   │
└──────────────────┴──────────────────────────────────────────┘
EOF

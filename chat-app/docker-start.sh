#!/bin/sh
set -e

# Ensure the data dir exists and is writable (mounted as a docker volume).
mkdir -p /app/data

echo "[chat-app] Installing dependencies..."
# better-sqlite3 ships prebuilt binaries for Alpine/musl, but fall back to building
# from source if they aren't available for this platform.
if ! npm install --prefer-offline --silent 2>/dev/null; then
  echo "[chat-app] Prebuilt install failed — installing build toolchain..."
  apk add --no-cache python3 make g++ >/dev/null
  npm install --prefer-offline --silent
fi

echo "[chat-app] Building Astro SSR server..."
npm run build

echo "[chat-app] Starting Astro SSR server on port ${PORT:-4322}..."
echo "[chat-app] (The Ollama model is pulled lazily in the background — open the UI to track progress.)"
exec node ./dist/server/entry.mjs

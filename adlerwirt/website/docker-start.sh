#!/bin/sh
set -e

echo "[startup] Waiting for Directus..."
until node -e "
  fetch(process.env.DIRECTUS_URL + '/server/health')
    .then(r => process.exit(r.ok ? 0 : 1))
    .catch(() => process.exit(1));
" 2>/dev/null; do
  sleep 2
done
echo "[startup] Directus is up."

echo "[startup] Setting API token..."
node -e "
  const url   = process.env.DIRECTUS_URL;
  const email = process.env.ADMIN_EMAIL;
  const pass  = process.env.ADMIN_PASSWORD;
  const token = process.env.DIRECTUS_TOKEN;

  fetch(url + '/auth/login', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email, password: pass }),
  })
    .then(r => r.json())
    .then(d => d.data.access_token)
    .then(t =>
      fetch(url + '/users/me', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t },
        body:    JSON.stringify({ token }),
      })
    )
    .then(r => { if (!r.ok) throw new Error('PATCH failed: ' + r.status); })
    .then(() => { console.log('[startup] API token set.'); process.exit(0); })
    .catch(e => { console.error('[startup] Token setup failed:', e.message); process.exit(1); });
"

echo "[startup] Installing dependencies..."
npm install --prefer-offline --silent

echo "[startup] Building Astro SSR server..."
npm run build

echo "[startup] Starting Astro SSR server..."
exec node ./dist/server/entry.mjs

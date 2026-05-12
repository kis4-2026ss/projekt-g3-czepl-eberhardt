import type { APIRoute } from 'astro';
import { Profiles } from '@/lib/db';
import { openMcp, listTools } from '@/lib/mcp-client';

export const prerender = false;

/**
 * Test a profile's connection from two angles:
 *   1. Directly hit the Directus instance (proves the URL + token work).
 *   2. Open an MCP session with those credentials and list tools (proves the
 *      full path the chat actually uses).
 */
export const POST: APIRoute = async ({ params, request }) => {
  const useUnsaved = new URL(request.url).searchParams.get('unsaved') === '1';

  let url: string;
  let token: string;
  let name = '';

  if (useUnsaved) {
    try {
      const body = (await request.json()) as { directus_url?: string; directus_token?: string };
      url = body.directus_url ?? '';
      token = body.directus_token ?? '';
      if (!url || !token) {
        return json(400, { ok: false, error: 'URL und Token sind erforderlich.' });
      }
      try { new URL(url); } catch { return json(400, { ok: false, error: 'Ungültige URL.' }); }
    } catch {
      return json(400, { ok: false, error: 'Ungültiger Request-Body.' });
    }
  } else {
    const id = Number(params.id);
    if (!Number.isFinite(id) || id <= 0) return json(400, { ok: false, error: 'Ungültige ID' });
    const p = Profiles.get(id);
    if (!p) return json(404, { ok: false, error: 'Profil nicht gefunden.' });
    url = p.directus_url;
    token = p.directus_token;
    name = p.name;
  }

  // Step 1: direct ping
  let directus = { ok: false, info: '', error: null as string | null };
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/users/me?fields=email,role.name`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      directus.error = `HTTP ${res.status}`;
    } else {
      const data = (await res.json()) as { data?: { email?: string; role?: { name?: string } } };
      directus.ok = true;
      directus.info = data.data?.email ? `${data.data.email} (${data.data.role?.name ?? 'unknown role'})` : 'OK';
    }
  } catch (e) {
    directus.error = e instanceof Error ? e.message : String(e);
  }

  // Step 2: through MCP
  let mcp = { ok: false, tools: 0, error: null as string | null };
  if (directus.ok) {
    try {
      const client = await openMcp({ url, token });
      const tools = await listTools(client);
      mcp.ok = true;
      mcp.tools = tools.length;
      await client.close().catch(() => {});
    } catch (e) {
      mcp.error = e instanceof Error ? e.message : String(e);
    }
  }

  return json(200, {
    ok: directus.ok && mcp.ok,
    name,
    directus,
    mcp,
  });
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

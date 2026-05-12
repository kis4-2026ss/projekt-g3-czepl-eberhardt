import type { APIRoute } from 'astro';
import { openMcp, listTools } from '@/lib/mcp-client';
import { Profiles } from '@/lib/db';
import { ensureModelInBackground, getPullState } from '@/lib/model-pull';

export const prerender = false;

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';

export const GET: APIRoute = async ({ url }) => {
  // Kick off the model pull lazily — first health hit (i.e. UI page load) starts it.
  ensureModelInBackground();

  const idParam = url.searchParams.get('profileId');
  const id = idParam ? Number(idParam) : null;
  const profile = id ? Profiles.get(id) : Profiles.getDefault();
  const pull = getPullState();

  const result = {
    profile: profile ? { id: profile.id, name: profile.name } : null,
    mcp:     { ok: false, tools: 0, error: null as string | null },
    ollama:  {
      ok:         false,
      modelReady: pull.status === 'ready',
      model:      pull.model,
      pull,
      error:      null as string | null,
    },
  };

  if (profile) {
    try {
      const mcp = await openMcp({ url: profile.directus_url, token: profile.directus_token });
      const tools = await listTools(mcp);
      result.mcp.ok = true;
      result.mcp.tools = tools.length;
      await mcp.close().catch(() => {});
    } catch (e) {
      result.mcp.error = e instanceof Error ? e.message : String(e);
    }
  } else {
    result.mcp.error = 'Kein Profil konfiguriert.';
  }

  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`);
    result.ollama.ok = res.ok;
    if (!res.ok) result.ollama.error = `HTTP ${res.status}`;
  } catch (e) {
    result.ollama.error = e instanceof Error ? e.message : String(e);
  }

  const ok = !!profile && result.mcp.ok && result.ollama.ok && result.ollama.modelReady;
  return new Response(JSON.stringify({ ok, ...result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

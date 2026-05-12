import type { APIRoute } from 'astro';
import { Profiles, maskedProfile, type ProfileInput } from '@/lib/db';

export const prerender = false;

function parseId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const PATCH: APIRoute = async ({ params, request }) => {
  const id = parseId(params.id);
  if (!id) return jsonError(400, 'Ungültige ID');
  try {
    const body = (await request.json()) as Partial<ProfileInput> & { is_default?: boolean };
    let profile = Profiles.get(id);
    if (!profile) return jsonError(404, 'Profil nicht gefunden.');

    if (body.name !== undefined || body.directus_url !== undefined || body.directus_token !== undefined) {
      profile = Profiles.update(id, {
        name:           body.name           ?? profile.name,
        directus_url:   body.directus_url   ?? profile.directus_url,
        directus_token: body.directus_token ?? profile.directus_token,
      });
    }
    if (body.is_default === true) {
      profile = Profiles.setDefault(id);
    }
    return new Response(JSON.stringify({ profile: maskedProfile(profile) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return jsonError(400, e instanceof Error ? e.message : String(e));
  }
};

export const DELETE: APIRoute = ({ params }) => {
  const id = parseId(params.id);
  if (!id) return jsonError(400, 'Ungültige ID');
  try {
    Profiles.delete(id);
    return new Response(null, { status: 204 });
  } catch (e) {
    return jsonError(400, e instanceof Error ? e.message : String(e));
  }
};

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

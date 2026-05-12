import type { APIRoute } from 'astro';
import { Profiles, maskedProfile, type ProfileInput } from '@/lib/db';

export const prerender = false;

export const GET: APIRoute = () => {
  const profiles = Profiles.list().map(maskedProfile);
  return new Response(JSON.stringify({ profiles }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = (await request.json()) as Partial<ProfileInput>;
    const profile = Profiles.create(body);
    return new Response(JSON.stringify({ profile: maskedProfile(profile) }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

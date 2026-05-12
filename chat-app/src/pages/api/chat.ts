import type { APIRoute } from 'astro';
import { runChat, type ChatEvent, type ClientMessage } from '@/lib/ollama-chat';
import { Profiles } from '@/lib/db';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let messages: ClientMessage[];
  let profileId: number | null = null;
  try {
    const body = (await request.json()) as { messages?: ClientMessage[]; profileId?: number };
    messages  = body.messages  ?? [];
    profileId = body.profileId ?? null;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const profile = profileId ? Profiles.get(profileId) : Profiles.getDefault();
  if (!profile) {
    return new Response(JSON.stringify({ error: 'Kein Directus-Profil konfiguriert.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: ChatEvent) => {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      try {
        const iter = runChat(messages, {
          profile: {
            name: profile.name,
            creds: { url: profile.directus_url, token: profile.directus_token },
          },
        });
        for await (const event of iter) send(event);
      } catch (e) {
        send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
};

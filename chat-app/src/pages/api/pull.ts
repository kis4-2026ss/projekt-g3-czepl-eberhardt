import type { APIRoute } from 'astro';
import { retryPull, getPullState } from '@/lib/model-pull';

export const prerender = false;

export const POST: APIRoute = async () => {
  // Fire-and-forget; the UI polls /api/health for progress.
  void retryPull().catch(() => {});
  return new Response(JSON.stringify({ pull: getPullState() }), {
    status: 202,
    headers: { 'Content-Type': 'application/json' },
  });
};

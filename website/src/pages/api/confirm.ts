import type { APIRoute } from 'astro';
import { confirmPreview } from '../../lib/preview';

export const POST: APIRoute = async ({ request, redirect }) => {
  const data = await request.formData();
  const token = data.get('token');
  if (!token || typeof token !== 'string') {
    return new Response('Missing token', { status: 400 });
  }
  await confirmPreview(token);
  const referer = request.headers.get('referer') ?? '/';
  const url = new URL(referer);
  url.searchParams.delete('preview_token');
  return redirect(url.pathname + (url.search || ''), 302);
};

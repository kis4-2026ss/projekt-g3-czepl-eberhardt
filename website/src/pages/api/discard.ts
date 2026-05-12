import type { APIRoute } from 'astro';
import { discardPreview } from '../../lib/preview';

export const POST: APIRoute = async ({ request, redirect }) => {
  const data = await request.formData();
  const token = data.get('token');
  if (token && typeof token === 'string') {
    await discardPreview(token);
  }
  const referer = request.headers.get('referer') ?? '/';
  const url = new URL(referer);
  url.searchParams.delete('preview_token');
  return redirect(url.pathname + (url.search || ''), 302);
};

import { defineMiddleware } from 'astro:middleware';
import { fetchPreview } from './lib/preview';

export const onRequest = defineMiddleware(async (context, next) => {
  const token = context.url.searchParams.get('preview_token');
  if (token) {
    const preview = await fetchPreview(token);
    context.locals.preview = preview ?? undefined;
    context.locals.previewToken = token;
  }
  return next();
});

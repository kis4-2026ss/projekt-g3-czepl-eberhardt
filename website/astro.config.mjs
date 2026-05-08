import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  integrations: [tailwind()],
  server: { host: true }, // bind to 0.0.0.0 so Docker can expose the port
});

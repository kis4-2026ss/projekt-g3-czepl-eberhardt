/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />
/// <reference types="node" />

interface ImportMetaEnv {
  readonly DIRECTUS_URL: string;
  readonly PUBLIC_DIRECTUS_URL: string;
  readonly DIRECTUS_TOKEN: string;
}

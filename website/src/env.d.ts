/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />
/// <reference types="node" />

interface ImportMetaEnv {
  readonly DIRECTUS_URL: string;
  readonly DIRECTUS_TOKEN: string;
  readonly MCP_SERVER_URL: string;
}

declare namespace App {
  interface Locals {
    preview?: import('./lib/preview').PreviewEntry;
    previewToken?: string;
  }
}

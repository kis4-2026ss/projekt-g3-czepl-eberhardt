/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly OLLAMA_HOST?: string;
  readonly OLLAMA_MODEL?: string;
  readonly MCP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

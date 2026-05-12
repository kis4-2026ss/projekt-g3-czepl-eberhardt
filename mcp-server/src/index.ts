import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { DirectusClient, computeDiff, type DiffEntry, type DirectusClientOpts } from "./directus.js";
import http from "node:http";
import { randomUUID } from "node:crypto";

// ── Per-request client factory ────────────────────────────────────────────────
//
// Connection details may be supplied per request via HTTP headers, falling back
// to env vars. This lets a single MCP server serve multiple Directus instances
// (the chat-app uses this to switch between connection profiles).

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function makeClient(req: http.IncomingMessage): DirectusClient {
  const opts: DirectusClientOpts = {
    url:      header(req, "x-directus-url")      ?? process.env.DIRECTUS_URL      ?? "http://localhost:8055",
    token:    header(req, "x-directus-token")    ?? process.env.DIRECTUS_TOKEN,
    email:    header(req, "x-directus-email")    ?? process.env.DIRECTUS_EMAIL,
    password: header(req, "x-directus-password") ?? process.env.DIRECTUS_PASSWORD,
  };
  return new DirectusClient(opts);
}

const WEBSITE_URL = (process.env.WEBSITE_URL ?? "http://localhost:4321").replace(/\/$/, "");

/** Tool schema hint: Directus returns HTTP 403 for invalid /items/.../id paths (easy to mistake for RBAC). */
const ITEM_PK_DESCRIPTION =
  "Exact primary key from read_items/read_item (integer or UUID). Never a title, slug, or placeholder; if you only know a name, call read_items with a filter first, then use data[0].id.";

// ── Preview store ─────────────────────────────────────────────────────────────

interface PreviewEntry {
  action: "create" | "update" | "delete" | "update_singleton";
  collection: string;
  id?: string | number;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  diff?: DiffEntry[];
  data?: Record<string, unknown>;
}

const previewStore = new Map<string, { entry: PreviewEntry; timer: ReturnType<typeof setTimeout> }>();
const PREVIEW_TTL_MS = 30 * 60 * 1000;

function storePreview(entry: PreviewEntry): string {
  const token = randomUUID();
  const timer = setTimeout(() => previewStore.delete(token), PREVIEW_TTL_MS);
  previewStore.set(token, { entry, timer });
  return token;
}

function buildPreviewResponse(token: string, entry: PreviewEntry): Record<string, unknown> {
  const preview_url = `${WEBSITE_URL}?preview_token=${token}`;
  return { ...entry, preview_token: token, preview_url };
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  // Introspection
  {
    name: "list_collections",
    description:
      "List all user-facing collections in the Directus instance. Shows collection name, singleton status, icon, and note. Call this first to understand the available data model.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_collection_fields",
    description:
      "Get all fields for a specific collection, including field type, whether it is required, and UI options. Use this to understand what data a collection holds before reading or writing.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name (e.g. 'menu_items')" },
      },
      required: ["collection"],
    },
  },
  {
    name: "get_schema",
    description:
      "Get the full schema: all collections, all fields, and all relations in one call. Useful for a complete picture of the data model.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },

  // Read
  {
    name: "read_items",
    description:
      "Read multiple items from a collection. Supports field selection, Directus filter objects, sorting, pagination, and full-text search.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name" },
        fields: {
          type: "array",
          items: { type: "string" },
          description: "Fields to include in the response. Omit for all fields.",
        },
        filter: {
          type: "object",
          description: "Directus filter object, e.g. { \"available\": { \"_eq\": true } }",
        },
        sort: {
          type: "array",
          items: { type: "string" },
          description: "Sort fields. Prefix with '-' for descending, e.g. [\"-price\"]",
        },
        limit: { type: "number", description: "Maximum number of items to return" },
        offset: { type: "number", description: "Number of items to skip (for pagination)" },
        search: { type: "string", description: "Full-text search string" },
      },
      required: ["collection"],
    },
  },
  {
    name: "read_item",
    description:
      "Read a single item by primary key. If you only know a human-readable field (e.g. dish name), use read_items with a filter instead.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name" },
        id: { description: ITEM_PK_DESCRIPTION },
        fields: {
          type: "array",
          items: { type: "string" },
          description: "Fields to include in the response",
        },
      },
      required: ["collection", "id"],
    },
  },
  {
    name: "read_singleton",
    description:
      "Read the data of a singleton collection (a collection with exactly one record, e.g. 'site_settings', 'hero', 'about'). Use list_collections to identify which collections are singletons.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Singleton collection name" },
        fields: {
          type: "array",
          items: { type: "string" },
          description: "Fields to include in the response",
        },
      },
      required: ["collection"],
    },
  },

  // Write
  {
    name: "create_item",
    description:
      "Create a new item in a collection. Set dry_run=true to preview what would be created and get a preview URL before writing.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name" },
        data: {
          type: "object",
          description: "Item data as key-value pairs matching the collection's fields",
        },
        dry_run: {
          type: "boolean",
          description: "If true, store a preview and return a preview_url without writing anything",
        },
      },
      required: ["collection", "data"],
    },
  },
  {
    name: "update_item",
    description:
      "Update one or more fields of an existing item by primary key. Set dry_run=true to get a before/after diff and a preview URL before writing.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name" },
        id: { description: ITEM_PK_DESCRIPTION },
        data: {
          type: "object",
          description: "Fields to update as key-value pairs (partial update)",
        },
        dry_run: {
          type: "boolean",
          description: "If true, return a before/after diff and preview_url without writing",
        },
      },
      required: ["collection", "id", "data"],
    },
  },
  {
    name: "update_items",
    description:
      "Bulk-update multiple items in a collection in one request. Provide the list of IDs and the fields to change. Use this instead of calling update_item in a loop.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name" },
        ids: {
          type: "array",
          items: {},
          description: `List of primary keys to update. ${ITEM_PK_DESCRIPTION}`,
        },
        data: {
          type: "object",
          description: "Fields to set on all matched items (partial update)",
        },
      },
      required: ["collection", "ids", "data"],
    },
  },
  {
    name: "update_singleton",
    description:
      "Update fields of a singleton collection (e.g. 'site_settings', 'hero', 'about'). Set dry_run=true to get a diff and preview URL before writing.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Singleton collection name" },
        data: {
          type: "object",
          description: "Fields to update as key-value pairs",
        },
        dry_run: {
          type: "boolean",
          description: "If true, return a before/after diff and preview_url without writing",
        },
      },
      required: ["collection", "data"],
    },
  },
  {
    name: "delete_item",
    description:
      "Permanently delete an item by primary key. Set dry_run=true to preview what would be deleted and get a preview URL.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name" },
        id: { description: ITEM_PK_DESCRIPTION },
        dry_run: {
          type: "boolean",
          description: "If true, return the item that would be deleted and a preview_url without deleting",
        },
      },
      required: ["collection", "id"],
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

// ── MCP Server factory ────────────────────────────────────────────────────────

function makeServer(client: DirectusClient): Server {
  const server = new Server(
    { name: "directus-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      switch (name) {
        // ── Introspection ────────────────────────────────────────────────────

        case "list_collections":
          return ok(await client.listCollections());

        case "get_collection_fields": {
          const { collection } = args as { collection: string };
          return ok(await client.getCollectionFields(collection));
        }

        case "get_schema":
          return ok(await client.getSchema());

        // ── Read ─────────────────────────────────────────────────────────────

        case "read_items": {
          const { collection, fields, filter, sort, limit, offset, search } = args as {
            collection: string;
            fields?: string[];
            filter?: Record<string, unknown>;
            sort?: string[];
            limit?: number;
            offset?: number;
            search?: string;
          };
          return ok(await client.readItems(collection, { fields, filter, sort, limit, offset, search }));
        }

        case "read_item": {
          const { collection, id, fields } = args as {
            collection: string;
            id: string | number;
            fields?: string[];
          };
          return ok(await client.readItem(collection, id, fields));
        }

        case "read_singleton": {
          const { collection, fields } = args as { collection: string; fields?: string[] };
          return ok(await client.readSingleton(collection, fields));
        }

        // ── Write ────────────────────────────────────────────────────────────

        case "create_item": {
          const { collection, data, dry_run = false } = args as {
            collection: string;
            data: Record<string, unknown>;
            dry_run?: boolean;
          };
          if (dry_run) {
            const entry: PreviewEntry = { action: "create", collection, after: data, data };
            const token = storePreview(entry);
            return ok(buildPreviewResponse(token, entry));
          }
          return ok(await client.createItem(collection, data));
        }

        case "update_item": {
          const { collection, id, data, dry_run = false } = args as {
            collection: string;
            id: string | number;
            data: Record<string, unknown>;
            dry_run?: boolean;
          };
          if (dry_run) {
            const res = await client.readItem(collection, id) as { data: Record<string, unknown> };
            const before = res.data;
            const after = { ...before, ...data };
            const entry: PreviewEntry = {
              action: "update", collection, id,
              before, after, diff: computeDiff(before, data), data,
            };
            const token = storePreview(entry);
            return ok(buildPreviewResponse(token, entry));
          }
          return ok(await client.updateItem(collection, id, data));
        }

        case "update_items": {
          const { collection, ids, data } = args as {
            collection: string;
            ids: (string | number)[];
            data: Record<string, unknown>;
          };
          return ok(await client.updateItems(collection, ids, data));
        }

        case "update_singleton": {
          const { collection, data, dry_run = false } = args as {
            collection: string;
            data: Record<string, unknown>;
            dry_run?: boolean;
          };
          if (dry_run) {
            const res = await client.readSingleton(collection) as { data: Record<string, unknown> };
            const before = res.data;
            const after = { ...before, ...data };
            const entry: PreviewEntry = {
              action: "update_singleton", collection,
              before, after, diff: computeDiff(before, data), data,
            };
            const token = storePreview(entry);
            return ok(buildPreviewResponse(token, entry));
          }
          return ok(await client.updateSingleton(collection, data));
        }

        case "delete_item": {
          const { collection, id, dry_run = false } = args as {
            collection: string;
            id: string | number;
            dry_run?: boolean;
          };
          if (dry_run) {
            const res = await client.readItem(collection, id) as { data: Record<string, unknown> };
            const entry: PreviewEntry = {
              action: "delete", collection, id, before: res.data,
            };
            const token = storePreview(entry);
            return ok(buildPreviewResponse(token, entry));
          }
          await client.deleteItem(collection, id);
          return ok({ success: true, deleted: { collection, id } });
        }

        default:
          return err(`Unknown tool: ${name}`);
      }
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  });

  return server;
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3001);
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, mcp-session-id",
};

const httpServer = http.createServer();

httpServer.on("request", (req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS).end();
      return;
    }

    // ── MCP endpoint ──────────────────────────────────────────────────────────
    if (path === "/mcp") {
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", resolve);
        req.on("error", reject);
      });
      const body = chunks.length
        ? (JSON.parse(Buffer.concat(chunks).toString()) as unknown)
        : undefined;

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = makeServer(makeClient(req));
      res.on("close", () => transport.close().catch(() => {}));
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    // ── GET /preview/:token ───────────────────────────────────────────────────
    if (method === "GET" && path.startsWith("/preview/")) {
      const token = path.slice("/preview/".length);
      const stored = previewStore.get(token);
      if (!stored) {
        res.writeHead(404, { "Content-Type": "application/json", ...CORS_HEADERS })
          .end(JSON.stringify({ error: "Preview not found or expired" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS })
        .end(JSON.stringify({ ...stored.entry, preview_token: token }));
      return;
    }

    // ── POST /confirm/:token ──────────────────────────────────────────────────
    if (method === "POST" && path.startsWith("/confirm/")) {
      const token = path.slice("/confirm/".length);
      const stored = previewStore.get(token);
      if (!stored) {
        res.writeHead(404, { "Content-Type": "application/json", ...CORS_HEADERS })
          .end(JSON.stringify({ error: "Preview not found or expired" }));
        return;
      }

      const { entry } = stored;
      clearTimeout(stored.timer);
      previewStore.delete(token);

      const confirmClient = makeClient(req);
      switch (entry.action) {
        case "create":
          await confirmClient.createItem(entry.collection, entry.data!);
          break;
        case "update":
          await confirmClient.updateItem(entry.collection, entry.id!, entry.data!);
          break;
        case "update_singleton":
          await confirmClient.updateSingleton(entry.collection, entry.data!);
          break;
        case "delete":
          await confirmClient.deleteItem(entry.collection, entry.id!);
          break;
      }

      res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS })
        .end(JSON.stringify({ success: true, action: entry.action, collection: entry.collection }));
      return;
    }

    // ── DELETE /preview/:token ────────────────────────────────────────────────
    if (method === "DELETE" && path.startsWith("/preview/")) {
      const token = path.slice("/preview/".length);
      const stored = previewStore.get(token);
      if (stored) {
        clearTimeout(stored.timer);
        previewStore.delete(token);
      }
      res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS })
        .end(JSON.stringify({ success: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: "Not found" }));
  })().catch((e: unknown) => {
    process.stderr.write(`Request error: ${e instanceof Error ? e.message : String(e)}\n`);
    if (!res.headersSent) res.writeHead(500).end();
  });
});

httpServer.listen(PORT, () => {
  process.stderr.write(`directus-mcp listening on http://0.0.0.0:${PORT}/mcp\n`);
});

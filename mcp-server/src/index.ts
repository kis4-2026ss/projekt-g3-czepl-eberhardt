import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { DirectusClient } from "./directus.js";
import http from "node:http";

// ── Client setup ──────────────────────────────────────────────────────────────

const client = new DirectusClient(
  process.env.DIRECTUS_URL ?? "http://localhost:8055",
  process.env.DIRECTUS_EMAIL ?? "admin@gmail.at",
  process.env.DIRECTUS_PASSWORD ?? "admin",
);

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
          description:
            "Directus filter object, e.g. { \"available\": { \"_eq\": true } }",
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
    description: "Read a single item by its primary key ID from a collection.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name" },
        id: { description: "Item primary key (integer or UUID string)" },
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
    description: "Create a new item in a collection.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name" },
        data: {
          type: "object",
          description: "Item data as key-value pairs matching the collection's fields",
        },
      },
      required: ["collection", "data"],
    },
  },
  {
    name: "update_item",
    description: "Update one or more fields of an existing item in a collection.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name" },
        id: { description: "Item primary key (integer or UUID string)" },
        data: {
          type: "object",
          description: "Fields to update as key-value pairs (partial update)",
        },
      },
      required: ["collection", "id", "data"],
    },
  },
  {
    name: "update_singleton",
    description:
      "Update fields of a singleton collection (e.g. 'site_settings', 'hero', 'about'). This is a partial update – only provided fields are changed.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Singleton collection name" },
        data: {
          type: "object",
          description: "Fields to update as key-value pairs",
        },
      },
      required: ["collection", "data"],
    },
  },
  {
    name: "delete_item",
    description: "Permanently delete an item from a collection by its primary key.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name" },
        id: { description: "Item primary key (integer or UUID string)" },
      },
      required: ["collection", "id"],
    },
  },
];

// ── Helper ────────────────────────────────────────────────────────────────────

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function err(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

// ── Server factory ────────────────────────────────────────────────────────────

function makeServer(): Server {
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
          const { collection, data } = args as {
            collection: string;
            data: Record<string, unknown>;
          };
          return ok(await client.createItem(collection, data));
        }

        case "update_item": {
          const { collection, id, data } = args as {
            collection: string;
            id: string | number;
            data: Record<string, unknown>;
          };
          return ok(await client.updateItem(collection, id, data));
        }

        case "update_singleton": {
          const { collection, data } = args as {
            collection: string;
            data: Record<string, unknown>;
          };
          return ok(await client.updateSingleton(collection, data));
        }

        case "delete_item": {
          const { collection, id } = args as { collection: string; id: string | number };
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

const httpServer = http.createServer();

httpServer.on("request", (req, res) => {
  void (async () => {
    if (req.url !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: "Not found" }));
      return;
    }

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
    const server = makeServer();

    res.on("close", () => transport.close().catch(() => {}));
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  })().catch((e: unknown) => {
    process.stderr.write(`Request error: ${e instanceof Error ? e.message : String(e)}\n`);
    if (!res.headersSent) res.writeHead(500).end();
  });
});

httpServer.listen(PORT, () => {
  process.stderr.write(`directus-mcp listening on http://0.0.0.0:${PORT}/mcp\n`);
});

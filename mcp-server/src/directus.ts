export interface DiffEntry {
  field: string;
  before: unknown;
  after: unknown;
}

export function computeDiff(
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
): DiffEntry[] {
  return Object.entries(patch)
    .filter(([k, v]) => JSON.stringify(before[k]) !== JSON.stringify(v))
    .map(([k, v]) => ({ field: k, before: before[k], after: v }));
}

export interface ReadItemsParams {
  fields?: string[];
  filter?: Record<string, unknown>;
  sort?: string[];
  limit?: number;
  offset?: number;
  search?: string;
}

export interface DirectusClientOpts {
  url: string;
  /** Static API token. If provided, used directly without a login round-trip. */
  token?: string;
  /** Optional email/password fallback (legacy). */
  email?: string;
  password?: string;
}

export class DirectusClient {
  private token: string | null;
  private readonly url: string;
  private readonly email?: string;
  private readonly password?: string;

  constructor(opts: DirectusClientOpts) {
    this.url      = opts.url;
    this.token    = opts.token ?? null;
    this.email    = opts.email;
    this.password = opts.password;
  }

  private async ensureAuth(): Promise<void> {
    if (this.token) return;
    if (!this.email || !this.password) {
      throw new Error(
        "DirectusClient: no token and no email/password provided. " +
          "Send X-Directus-Token (or X-Directus-Email + X-Directus-Password) headers.",
      );
    }
    const res = await fetch(`${this.url}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: this.email, password: this.password }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Directus auth failed (${res.status}): ${body}`);
    }
    const { data } = (await res.json()) as { data: { access_token: string } };
    this.token = data.access_token;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    await this.ensureAuth();
    const res = await fetch(`${this.url}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
        ...(options.headers as Record<string, string>),
      },
    });

    if (res.status === 401 && this.email && this.password) {
      // Re-login only makes sense when we own the credentials.
      this.token = null;
      await this.ensureAuth();
      return this.request<T>(path, options);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Directus API error ${res.status} on ${path}: ${body}`);
    }

    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  // ── Introspection ──────────────────────────────────────────────────────────

  async listCollections(): Promise<unknown[]> {
    const { data } = await this.request<{ data: unknown[] }>("/collections");
    return (data as Array<{ collection: string }>).filter(
      (c) => !c.collection.startsWith("directus_"),
    );
  }

  async getCollectionFields(collection: string): Promise<unknown[]> {
    const { data } = await this.request<{ data: unknown[] }>(`/fields/${collection}`);
    return data;
  }

  async getSchema(): Promise<{ collections: unknown[]; fields: unknown[]; relations: unknown[] }> {
    const [colRes, fieldRes, relRes] = await Promise.all([
      this.request<{ data: Array<{ collection: string }> }>("/collections"),
      this.request<{ data: Array<{ collection: string }> }>("/fields"),
      this.request<{ data: Array<{ collection: string }> }>("/relations"),
    ]);

    const isUser = (c: { collection: string }) => !c.collection.startsWith("directus_");

    return {
      collections: colRes.data.filter(isUser),
      fields: fieldRes.data.filter(isUser),
      relations: relRes.data.filter(isUser),
    };
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  async readItems(collection: string, params: ReadItemsParams): Promise<unknown> {
    const q = new URLSearchParams();
    if (params.fields?.length) q.set("fields", params.fields.join(","));
    if (params.sort?.length) q.set("sort", params.sort.join(","));
    if (params.limit != null) q.set("limit", String(params.limit));
    if (params.offset != null) q.set("offset", String(params.offset));
    if (params.search) q.set("search", params.search);
    if (params.filter) q.set("filter", JSON.stringify(params.filter));

    const qs = q.toString();
    return this.request<unknown>(`/items/${collection}${qs ? `?${qs}` : ""}`);
  }

  async readItem(
    collection: string,
    id: string | number,
    fields?: string[],
  ): Promise<unknown> {
    const qs = fields?.length ? `?fields=${fields.join(",")}` : "";
    return this.request<unknown>(`/items/${collection}/${id}${qs}`);
  }

  async createItem(collection: string, data: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>(`/items/${collection}`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateItem(
    collection: string,
    id: string | number,
    data: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request<unknown>(`/items/${collection}/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async updateItems(
    collection: string,
    ids: (string | number)[],
    data: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request<unknown>(`/items/${collection}`, {
      method: "PATCH",
      body: JSON.stringify({ keys: ids, data }),
    });
  }

  async deleteItem(collection: string, id: string | number): Promise<void> {
    await this.request<void>(`/items/${collection}/${id}`, { method: "DELETE" });
  }

  // Singletons use the same /items/:collection endpoint but without an ID.
  async readSingleton(collection: string, fields?: string[]): Promise<unknown> {
    const qs = fields?.length ? `?fields=${fields.join(",")}` : "";
    return this.request<unknown>(`/items/${collection}${qs}`);
  }

  async updateSingleton(
    collection: string,
    data: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request<unknown>(`/items/${collection}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }
}

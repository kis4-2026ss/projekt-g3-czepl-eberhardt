export interface ReadItemsParams {
  fields?: string[];
  filter?: Record<string, unknown>;
  sort?: string[];
  limit?: number;
  offset?: number;
  search?: string;
}

export class DirectusClient {
  private token: string | null = null;

  constructor(
    private readonly url: string,
    private readonly email: string,
    private readonly password: string,
  ) {}

  private async ensureAuth(): Promise<void> {
    if (this.token) return;
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

    if (res.status === 401) {
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

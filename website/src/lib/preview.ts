const MCP_SERVER_URL = (
  import.meta.env.MCP_SERVER_URL ??
  process.env['MCP_SERVER_URL'] ??
  'http://localhost:3001'
).replace(/\/$/, '');

export interface DiffEntry {
  field: string;
  before: unknown;
  after: unknown;
}

export interface PreviewEntry {
  action: 'create' | 'update' | 'delete' | 'update_singleton';
  collection: string;
  id?: string | number;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  diff?: DiffEntry[];
  data?: Record<string, unknown>;
  preview_token: string;
}

export async function fetchPreview(token: string): Promise<PreviewEntry | null> {
  try {
    const res = await fetch(`${MCP_SERVER_URL}/preview/${token}`);
    if (!res.ok) return null;
    return (await res.json()) as PreviewEntry;
  } catch {
    return null;
  }
}

export async function confirmPreview(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${MCP_SERVER_URL}/confirm/${token}`, { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function discardPreview(token: string): Promise<void> {
  try {
    await fetch(`${MCP_SERVER_URL}/preview/${token}`, { method: 'DELETE' });
  } catch {
    // ignore
  }
}

export function applyPreviewSingleton<T>(
  data: T,
  preview: PreviewEntry | undefined,
  collection: string,
): T {
  if (!preview || preview.collection !== collection) return data;
  if ((preview.action === 'update_singleton' || preview.action === 'update') && preview.after) {
    return Object.assign({}, data, preview.after) as T;
  }
  return data;
}

export function applyPreviewList<T extends { id: number | string }>(
  items: T[],
  preview: PreviewEntry | undefined,
  collection: string,
): T[] {
  if (!preview || preview.collection !== collection) return items;
  switch (preview.action) {
    case 'create':
      return [...items, { ...(preview.after as unknown as T), id: '__preview_new__' as unknown as T['id'] }];
    case 'update':
      return items.map(item =>
        String(item.id) === String(preview.id)
          ? Object.assign({}, item, preview.data)
          : item,
      );
    case 'delete':
      return items.filter(item => String(item.id) !== String(preview.id));
    default:
      return items;
  }
}

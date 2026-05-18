import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://app:app@app-db:5432/app";

export const pool = new Pool({ connectionString: DATABASE_URL });

export async function initSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mcp_sessions (
      session_id            TEXT PRIMARY KEY,
      directus_url          TEXT NOT NULL DEFAULT '',
      directus_token        TEXT,
      directus_email        TEXT,
      directus_password     TEXT,
      website_url           TEXT,
      website_public_url    TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used             TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS mcp_previews (
      token        TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL,
      action       TEXT NOT NULL,
      collection   TEXT NOT NULL,
      item_id      TEXT,
      before_json  JSONB,
      after_json   JSONB,
      diff_json    JSONB,
      data_json    JSONB,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS mcp_previews_session_idx ON mcp_previews(session_id);
  `);
}

export interface SessionRow {
  session_id: string;
  directus_url: string;
  directus_token: string | null;
  directus_email: string | null;
  directus_password: string | null;
  website_url: string | null;
  website_public_url: string | null;
}

export async function upsertSession(
  sessionId: string,
  patch: {
    directusUrl?: string;
    directusToken?: string;
    directusEmail?: string;
    directusPassword?: string;
    websiteUrl?: string;
    websitePublicUrl?: string;
  },
): Promise<SessionRow> {
  // Insert if missing, then patch only provided columns. Postgres handles
  // concurrent writers cleanly so no in-process locking needed.
  await pool.query(
    `INSERT INTO mcp_sessions (session_id) VALUES ($1)
     ON CONFLICT (session_id) DO NOTHING`,
    [sessionId],
  );

  const sets: string[] = ["last_used = now()"];
  const vals: unknown[] = [];
  let i = 1;
  const push = (col: string, val: unknown) => { vals.push(val); sets.push(`${col} = $${++i}`); };
  if (patch.directusUrl !== undefined && patch.directusUrl) push("directus_url", patch.directusUrl);
  if (patch.directusToken !== undefined)    push("directus_token", patch.directusToken);
  if (patch.directusEmail !== undefined)    push("directus_email", patch.directusEmail);
  if (patch.directusPassword !== undefined) push("directus_password", patch.directusPassword);
  if (patch.websiteUrl !== undefined && patch.websiteUrl) push("website_url", patch.websiteUrl);
  if (patch.websitePublicUrl !== undefined && patch.websitePublicUrl) push("website_public_url", patch.websitePublicUrl);

  vals.unshift(sessionId);
  const res = await pool.query<SessionRow>(
    `UPDATE mcp_sessions SET ${sets.join(", ")} WHERE session_id = $1 RETURNING *`,
    vals,
  );
  return res.rows[0]!;
}

export async function touchSession(sessionId: string): Promise<void> {
  await pool.query(`UPDATE mcp_sessions SET last_used = now() WHERE session_id = $1`, [sessionId]);
}

export async function getSession(sessionId: string): Promise<SessionRow | null> {
  const res = await pool.query<SessionRow>(
    `SELECT * FROM mcp_sessions WHERE session_id = $1`,
    [sessionId],
  );
  return res.rows[0] ?? null;
}

export interface PreviewRow {
  token: string;
  session_id: string;
  action: "create" | "update" | "delete" | "update_singleton";
  collection: string;
  item_id: string | null;
  before_json: Record<string, unknown> | null;
  after_json: Record<string, unknown> | null;
  diff_json: unknown[] | null;
  data_json: Record<string, unknown> | null;
}

export async function insertPreview(p: {
  token: string;
  sessionId: string;
  action: PreviewRow["action"];
  collection: string;
  itemId?: string | number;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  diff?: unknown[];
  data?: Record<string, unknown>;
}): Promise<void> {
  // node-postgres serializes JS arrays as Postgres array literals (not JSON),
  // so JSONB columns reject array values with "invalid input syntax for type
  // json". Stringify explicitly so the driver passes a JSON text literal.
  const jsonb = (v: unknown) => (v == null ? null : JSON.stringify(v));
  await pool.query(
    `INSERT INTO mcp_previews
     (token, session_id, action, collection, item_id, before_json, after_json, diff_json, data_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      p.token, p.sessionId, p.action, p.collection,
      p.itemId != null ? String(p.itemId) : null,
      jsonb(p.before), jsonb(p.after), jsonb(p.diff), jsonb(p.data),
    ],
  );
}

export async function getPreview(token: string): Promise<PreviewRow | null> {
  const res = await pool.query<PreviewRow>(`SELECT * FROM mcp_previews WHERE token = $1`, [token]);
  return res.rows[0] ?? null;
}

export async function getPreviewsForSession(sessionId: string): Promise<PreviewRow[]> {
  const res = await pool.query<PreviewRow>(
    `SELECT * FROM mcp_previews WHERE session_id = $1 ORDER BY created_at ASC`,
    [sessionId],
  );
  return res.rows;
}

export async function deletePreview(token: string): Promise<void> {
  await pool.query(`DELETE FROM mcp_previews WHERE token = $1`, [token]);
}

export async function deletePreviewsForSession(sessionId: string): Promise<void> {
  await pool.query(`DELETE FROM mcp_previews WHERE session_id = $1`, [sessionId]);
}

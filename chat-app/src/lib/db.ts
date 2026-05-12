import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.CHAT_DB_PATH ?? '/app/data/chat.db';

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    directus_url    TEXT    NOT NULL,
    directus_token  TEXT    NOT NULL,
    is_default      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// Seed the docker-preconfigured Directus on first run so the chat works out of the box.
const seedUrl   = process.env.DEFAULT_DIRECTUS_URL;
const seedToken = process.env.DEFAULT_DIRECTUS_TOKEN;
const seedName  = process.env.DEFAULT_PROFILE_NAME ?? 'Docker Directus';

if (seedUrl && seedToken) {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM profiles').get() as { c: number };
  if (c === 0) {
    db.prepare(`
      INSERT INTO profiles (name, directus_url, directus_token, is_default)
      VALUES (?, ?, ?, 1)
    `).run(seedName, seedUrl, seedToken);
  }
}

export interface Profile {
  id:              number;
  name:            string;
  directus_url:    string;
  directus_token:  string;
  is_default:      number;
  created_at:      string;
}

export interface ProfileInput {
  name:           string;
  directus_url:   string;
  directus_token: string;
}

function validateInput(input: Partial<ProfileInput>): asserts input is ProfileInput {
  if (!input.name?.trim())           throw new Error('Name ist erforderlich.');
  if (!input.directus_url?.trim())   throw new Error('Directus-URL ist erforderlich.');
  if (!input.directus_token?.trim()) throw new Error('Directus-Token ist erforderlich.');
  try {
    new URL(input.directus_url);
  } catch {
    throw new Error('Directus-URL ist ungültig.');
  }
}

export const Profiles = {
  list(): Profile[] {
    return db
      .prepare('SELECT * FROM profiles ORDER BY is_default DESC, created_at ASC')
      .all() as Profile[];
  },

  get(id: number): Profile | undefined {
    return db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as Profile | undefined;
  },

  getDefault(): Profile | undefined {
    return db
      .prepare('SELECT * FROM profiles WHERE is_default = 1 LIMIT 1')
      .get() as Profile | undefined;
  },

  create(input: Partial<ProfileInput>): Profile {
    validateInput(input);
    const res = db
      .prepare(`INSERT INTO profiles (name, directus_url, directus_token) VALUES (?, ?, ?)`)
      .run(input.name.trim(), input.directus_url.trim(), input.directus_token.trim());
    return Profiles.get(Number(res.lastInsertRowid))!;
  },

  update(id: number, input: Partial<ProfileInput>): Profile {
    validateInput(input);
    const existing = Profiles.get(id);
    if (!existing) throw new Error('Profil nicht gefunden.');
    db.prepare(`
      UPDATE profiles
         SET name = ?, directus_url = ?, directus_token = ?
       WHERE id = ?
    `).run(input.name.trim(), input.directus_url.trim(), input.directus_token.trim(), id);
    return Profiles.get(id)!;
  },

  delete(id: number): void {
    const existing = Profiles.get(id);
    if (!existing) return;
    if (existing.is_default) {
      throw new Error('Das Standard-Profil kann nicht gelöscht werden. Wähle zuerst ein anderes als Standard.');
    }
    db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  },

  setDefault(id: number): Profile {
    const existing = Profiles.get(id);
    if (!existing) throw new Error('Profil nicht gefunden.');
    const tx = db.transaction(() => {
      db.prepare('UPDATE profiles SET is_default = 0').run();
      db.prepare('UPDATE profiles SET is_default = 1 WHERE id = ?').run(id);
    });
    tx();
    return Profiles.get(id)!;
  },
};

/** Sanitised view for the client — never expose the token in full. */
export function maskedProfile(p: Profile): Omit<Profile, 'directus_token'> & { token_hint: string } {
  const t = p.directus_token;
  return {
    id:           p.id,
    name:         p.name,
    directus_url: p.directus_url,
    is_default:   p.is_default,
    created_at:   p.created_at,
    token_hint:   t.length > 8 ? `${t.slice(0, 4)}…${t.slice(-4)}` : '••••',
  };
}

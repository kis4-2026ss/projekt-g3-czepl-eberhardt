import os
import json
import uuid
from contextlib import asynccontextmanager
from typing import Optional, AsyncIterator
from urllib.parse import urlsplit, urlunsplit

import httpx
import psycopg
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse, HTMLResponse, JSONResponse, Response
from pydantic import BaseModel
from dotenv import load_dotenv
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.messages import HumanMessage
from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.prebuilt import create_react_agent
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

load_dotenv()

GOOGLE_API_KEY  = os.getenv("GOOGLE_API_KEY", "")
GEMINI_MODEL    = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
PORT            = int(os.getenv("PORT", "8000"))
DATABASE_URL    = os.getenv("DATABASE_URL", "postgres://app:app@app-db:5432/app")
DEFAULT_MCP_URL = os.getenv("MCP_URL", "http://mcp:3001/mcp")
# Where the browser reaches the MCP preview proxy. Used to build the
# "Vorschau" deep-link on inline cards; never used server-side.
PREVIEW_HOST    = os.getenv("PREVIEW_HOST", "localhost:4322")

# Tools whose execution can change the set of pending previews. After these
# fire we refresh the preview list and emit add/remove events to the chat UI.
PREVIEW_AFFECTING_TOOLS = frozenset({
    "create_item", "update_item", "update_items", "update_singleton", "delete_item",
    "confirm_preview", "discard_preview",
    "confirm_all_previews", "discard_all_previews",
})


def mcp_http_base(mcp_url: str) -> str:
    """Strip the MCP JSON-RPC path off a configured MCP URL so we can hit the
    plain HTTP endpoints (/sessions/...) on the same host."""
    parts = urlsplit(mcp_url)
    return urlunsplit((parts.scheme, parts.netloc, "", "", ""))


def build_preview_event(p: dict, batch_id: Optional[str]) -> dict:
    """Shape one row from GET /sessions/:sid/previews into the SSE payload the
    chat UI consumes. Includes the live-preview deep-link so the frontend
    doesn't need to know PREVIEW_HOST or the session id encoding."""
    session_id = p.get("session_id") or ""
    token = p.get("preview_token") or ""
    preview_pages = p.get("preview_pages") or ["/"]
    first_page = preview_pages[0] if preview_pages else "/"
    return {
        "type": "preview",
        "token": token,
        "session_id": session_id,
        "action": p.get("action"),
        "collection": p.get("collection"),
        "item_id": p.get("id"),
        "diff": p.get("diff"),
        "before": p.get("before"),
        "after": p.get("after"),
        "batch_id": batch_id,
        "preview_url": f"http://{session_id}.{PREVIEW_HOST}{first_page}?pb_focus={token}",
    }

# psycopg needs the "postgresql://" scheme; accept "postgres://" too.
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = "postgresql://" + DATABASE_URL[len("postgres://"):]

SEED_INSTANCES = [
    {
        "name": "Adlerwirt",
        "directus_url": "http://adlerwirt-directus:8055",
        "directus_token": "adlerwirt-dev-token",
        "directus_email": "admin@gmail.at",
        "directus_password": "admin",
        "website_url": "http://localhost:4321",
        "website_internal_url": "http://adlerwirt-website:4321",
    },
    {
        "name": "FitCore Studio",
        "directus_url": "http://fitcore-directus:8055",
        "directus_token": "fitcore-dev-token",
        "directus_email": "admin@fitcore.studio",
        "directus_password": "admin",
        "website_url": "http://localhost:4323",
        "website_internal_url": "http://fitcore-website:4321",
    },
]

# ── Database ───────────────────────────────────────────────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS instances (
    id                   SERIAL PRIMARY KEY,
    name                 TEXT NOT NULL,
    mcp_url              TEXT NOT NULL,
    directus_url         TEXT NOT NULL,
    directus_token       TEXT,
    directus_email       TEXT,
    directus_password    TEXT,
    website_url          TEXT,
    website_internal_url TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chats (
    id           TEXT PRIMARY KEY,
    instance_id  INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
    title        TEXT NOT NULL DEFAULT 'Neue Unterhaltung',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chats_instance_idx ON chats(instance_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
    id           BIGSERIAL PRIMARY KEY,
    chat_id      TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role         TEXT NOT NULL,
    content      TEXT NOT NULL,
    tools_json   JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_chat_idx ON chat_messages(chat_id, id);
"""

async def init_db(pool: AsyncConnectionPool) -> None:
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(SCHEMA)
            await cur.execute("SELECT COUNT(*) AS n FROM instances")
            row = await cur.fetchone()
            if row and row["n"] == 0:
                for inst in SEED_INSTANCES:
                    await cur.execute(
                        """INSERT INTO instances
                           (name, mcp_url, directus_url, directus_token,
                            directus_email, directus_password, website_url, website_internal_url)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                        (inst["name"], DEFAULT_MCP_URL, inst["directus_url"],
                         inst["directus_token"], inst["directus_email"], inst["directus_password"],
                         inst["website_url"], inst["website_internal_url"]),
                    )

# ── Agent ──────────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are an AI assistant for managing a website's Directus CMS.

Change workflow (IMPORTANT):
1. Use list_collections / get_collection_fields only when you genuinely don't know the field names.
   The server validates every write and returns the list of valid fields if you use a wrong one — fix and retry.
2. All write tools (create_item, update_item, update_items, update_singleton, delete_item) STAGE changes —
   nothing is written to the CMS immediately.
3. After staging changes, the user sees them as interactive cards directly in this chat, with
   Übernehmen (apply) and Verwerfen (discard) buttons plus a Vorschau (live preview) link on each card.
   NEVER paste review URLs, preview URLs, or any other links — the UI shows everything inline.
4. Briefly describe in one or two short sentences what you prepared (what changed and why), then let the
   user act on the inline cards. Do not list every field or token — the card already shows the diff.
5. Only call confirm_preview / confirm_all_previews if the user explicitly types a confirmation
   (e.g. "ja übernimm das", "apply all"). Otherwise let them click the card buttons.

Pending-state rule (IMPORTANT):
- The user may confirm or discard changes by clicking the inline cards, by using the live preview
  banner, or by typing a follow-up message — all outside your visibility.
- Whenever the user says they confirmed, discarded, or asks what is still pending:
  call list_previews FIRST to see the actual current state before answering.
  Never assume a staged change is still pending — always verify with list_previews."""

def build_session_headers(instance: dict, session_id: str) -> dict:
    """Build the headers the MCP server needs per request to scope this session."""
    headers = {"x-session-id": session_id}
    if instance["directus_url"]:      headers["x-directus-url"]      = instance["directus_url"]
    if instance["directus_token"]:    headers["x-directus-token"]    = instance["directus_token"]
    if instance["directus_email"]:    headers["x-directus-email"]    = instance["directus_email"]
    if instance["directus_password"]: headers["x-directus-password"] = instance["directus_password"]

    # The MCP preview proxy fetches from this URL — must be reachable from the
    # MCP container. In Docker dev that's the service name; in production it's
    # the customer's public website URL.
    internal_url = instance.get("website_internal_url") or instance.get("website_url")
    if internal_url:               headers["x-website-url"]        = internal_url
    if instance["website_url"]:    headers["x-website-public-url"] = instance["website_url"]
    return headers

async def build_agent(instance: dict, session_id: str):
    headers = build_session_headers(instance, session_id)
    mcp = MultiServerMCPClient({
        "directus": {
            "url": instance["mcp_url"],
            "transport": "streamable_http",
            "headers": headers,
        }
    })
    tools = await mcp.get_tools()
    return create_react_agent(
        app.state.llm,
        tools,
        checkpointer=app.state.checkpointer,
        prompt=SYSTEM_PROMPT,
    )

# ── App ────────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    pool = AsyncConnectionPool(DATABASE_URL, open=False, kwargs={"autocommit": True, "row_factory": dict_row})
    await pool.open()
    app.state.pool = pool
    await init_db(pool)

    # LangGraph checkpoint store — uses its own connection (autocommit required).
    cp_conn = await psycopg.AsyncConnection.connect(DATABASE_URL, autocommit=True)
    checkpointer = AsyncPostgresSaver(cp_conn)
    await checkpointer.setup()
    app.state.checkpointer = checkpointer
    app.state.cp_conn = cp_conn

    app.state.llm = ChatGoogleGenerativeAI(
        model=GEMINI_MODEL,
        google_api_key=GOOGLE_API_KEY or None,
        temperature=0.7,
        streaming=True,
        thinking_budget=0,
        generation_config={"thinking_config": {"thinking_budget": 0, "include_thoughts": False}},
    )
    try:
        yield
    finally:
        await pool.close()
        await cp_conn.close()

app = FastAPI(title="Directus AI Agent", lifespan=lifespan)
app.mount("/static", StaticFiles(directory="static"), name="static")

# ── Models ─────────────────────────────────────────────────────────────────────

class InstanceBody(BaseModel):
    name: str
    directus_url: str
    directus_token: Optional[str] = None
    directus_email: Optional[str] = None
    directus_password: Optional[str] = None
    website_url: Optional[str] = None
    website_internal_url: Optional[str] = None

class ChatRequest(BaseModel):
    message: str
    chat_id: str
    instance_id: int

class ChatCreateBody(BaseModel):
    instance_id: int
    title: Optional[str] = None

class ChatRenameBody(BaseModel):
    title: str

# ── Instance CRUD ──────────────────────────────────────────────────────────────

@app.get("/instances")
async def list_instances():
    async with app.state.pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT * FROM instances ORDER BY id")
            return await cur.fetchall()

@app.post("/instances", status_code=201)
async def create_instance(body: InstanceBody):
    async with app.state.pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """INSERT INTO instances
                   (name, mcp_url, directus_url, directus_token,
                    directus_email, directus_password, website_url, website_internal_url)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                   RETURNING *""",
                (body.name, DEFAULT_MCP_URL, body.directus_url, body.directus_token,
                 body.directus_email, body.directus_password,
                 body.website_url, body.website_internal_url),
            )
            return await cur.fetchone()

@app.put("/instances/{instance_id}")
async def update_instance(instance_id: int, body: InstanceBody):
    async with app.state.pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """UPDATE instances
                   SET name=%s, directus_url=%s, directus_token=%s,
                       directus_email=%s, directus_password=%s, website_url=%s, website_internal_url=%s
                   WHERE id=%s
                   RETURNING *""",
                (body.name, body.directus_url, body.directus_token,
                 body.directus_email, body.directus_password, body.website_url,
                 body.website_internal_url, instance_id),
            )
            row = await cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Instance not found")
            return row

@app.delete("/instances/{instance_id}", status_code=204)
async def delete_instance(instance_id: int):
    async with app.state.pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("DELETE FROM instances WHERE id = %s", (instance_id,))

# ── Chat CRUD ──────────────────────────────────────────────────────────────────

@app.get("/chats")
async def list_chats(instance_id: int):
    async with app.state.pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """SELECT id, instance_id, title, created_at, updated_at
                   FROM chats WHERE instance_id = %s
                   ORDER BY updated_at DESC""",
                (instance_id,),
            )
            return await cur.fetchall()

@app.post("/chats", status_code=201)
async def create_chat(body: ChatCreateBody):
    chat_id = str(uuid.uuid4())
    async with app.state.pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """INSERT INTO chats (id, instance_id, title)
                   VALUES (%s, %s, COALESCE(%s, 'Neue Unterhaltung'))
                   RETURNING id, instance_id, title, created_at, updated_at""",
                (chat_id, body.instance_id, body.title),
            )
            return await cur.fetchone()

@app.get("/chats/{chat_id}/messages")
async def get_chat_messages(chat_id: str):
    async with app.state.pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """SELECT role, content, tools_json AS tools, created_at
                   FROM chat_messages WHERE chat_id = %s
                   ORDER BY id""",
                (chat_id,),
            )
            return await cur.fetchall()

@app.put("/chats/{chat_id}")
async def rename_chat(chat_id: str, body: ChatRenameBody):
    async with app.state.pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE chats SET title = %s, updated_at = now() WHERE id = %s RETURNING *",
                (body.title, chat_id),
            )
            row = await cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Chat not found")
            return row

@app.delete("/chats/{chat_id}", status_code=204)
async def delete_chat(chat_id: str):
    """Delete a chat and everything attached to it: messages, langgraph thread
    state, and any pending previews bound to the chat's MCP session."""
    mcp_session_id = chat_to_mcp_session(chat_id)
    async with app.state.pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("DELETE FROM chats WHERE id = %s", (chat_id,))
    # The mcp_* tables are owned by the MCP server. If MCP hasn't started yet
    # they may not exist — that's fine, no previews could have been written.
    async with app.state.pool.connection() as conn:
        async with conn.cursor() as cur:
            try:
                await cur.execute("DELETE FROM mcp_previews WHERE session_id = %s", (mcp_session_id,))
                await cur.execute("DELETE FROM mcp_sessions WHERE session_id = %s", (mcp_session_id,))
            except psycopg.errors.UndefinedTable:
                pass
    # LangGraph thread state purge — checkpointer stores by thread_id.
    try:
        await app.state.checkpointer.adelete_thread(chat_id)
    except Exception:
        # adelete_thread is only on newer langgraph; ignore if missing.
        pass

# ── Chat helpers ───────────────────────────────────────────────────────────────

def chat_to_mcp_session(chat_id: str) -> str:
    """Derive the stable MCP x-session-id from a chat id.

    The MCP server keys previews + session info by this id. Keeping it stable
    across reloads is what makes previews persist beyond the chat window."""
    return ("c" + chat_id.replace("-", ""))[:40]

async def append_message(chat_id: str, role: str, content: str, tools: Optional[list] = None) -> None:
    async with app.state.pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """INSERT INTO chat_messages (chat_id, role, content, tools_json)
                   VALUES (%s, %s, %s, %s)""",
                (chat_id, role, content, json.dumps(tools) if tools is not None else None),
            )
            await cur.execute("UPDATE chats SET updated_at = now() WHERE id = %s", (chat_id,))

async def maybe_set_initial_title(chat_id: str, first_user_msg: str) -> None:
    """If the chat still has the default title, derive one from the first user
    message. Idempotent — only updates when title is the default."""
    title = first_user_msg.strip()
    if len(title) > 60:
        title = title[:58].rstrip() + "…"
    async with app.state.pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """UPDATE chats SET title = %s
                   WHERE id = %s AND title = 'Neue Unterhaltung'""",
                (title, chat_id),
            )

# ── Preview proxy ──────────────────────────────────────────────────────────────
#
# The chat UI renders inline preview cards and needs to read/confirm/discard
# them without knowing the MCP server's URL or how chat_id → session_id maps.
# These three endpoints proxy the corresponding MCP endpoints, scoped to the
# chat's MCP session.

async def _instance_for_chat(chat_id: str) -> dict:
    async with app.state.pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """SELECT i.* FROM instances i
                   JOIN chats c ON c.instance_id = i.id
                   WHERE c.id = %s""",
                (chat_id,),
            )
            instance = await cur.fetchone()
    if not instance:
        raise HTTPException(status_code=404, detail="Chat not found")
    return instance


@app.get("/chats/{chat_id}/previews")
async def list_chat_previews(chat_id: str):
    instance = await _instance_for_chat(chat_id)
    sid = chat_to_mcp_session(chat_id)
    base = mcp_http_base(instance["mcp_url"])
    async with httpx.AsyncClient(timeout=10.0) as http:
        r = await http.get(f"{base}/sessions/{sid}/previews")
    if r.status_code != 200:
        return JSONResponse([], status_code=200)
    rows = r.json()
    return [build_preview_event(row, None) for row in rows]


@app.post("/chats/{chat_id}/preview/{token}/confirm")
async def confirm_chat_preview(chat_id: str, token: str):
    instance = await _instance_for_chat(chat_id)
    sid = chat_to_mcp_session(chat_id)
    base = mcp_http_base(instance["mcp_url"])
    async with httpx.AsyncClient(timeout=30.0) as http:
        r = await http.post(f"{base}/sessions/{sid}/confirm/{token}")
    return Response(content=r.content, status_code=r.status_code,
                    media_type=r.headers.get("content-type", "application/json"))


@app.delete("/chats/{chat_id}/preview/{token}")
async def discard_chat_preview(chat_id: str, token: str):
    instance = await _instance_for_chat(chat_id)
    sid = chat_to_mcp_session(chat_id)
    base = mcp_http_base(instance["mcp_url"])
    async with httpx.AsyncClient(timeout=10.0) as http:
        r = await http.delete(f"{base}/sessions/{sid}/preview/{token}")
    return Response(content=r.content, status_code=r.status_code,
                    media_type=r.headers.get("content-type", "application/json"))

# ── Chat ───────────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    with open("static/index.html", encoding="utf-8") as f:
        return HTMLResponse(f.read())

@app.post("/chat")
async def chat(req: ChatRequest):
    async with app.state.pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT * FROM instances WHERE id = %s", (req.instance_id,))
            instance = await cur.fetchone()
            await cur.execute("SELECT id FROM chats WHERE id = %s", (req.chat_id,))
            chat_row = await cur.fetchone()

    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")
    if not chat_row:
        raise HTTPException(status_code=404, detail="Chat not found")

    mcp_session_id = chat_to_mcp_session(req.chat_id)
    agent = await build_agent(instance, mcp_session_id)
    mcp_base = mcp_http_base(instance["mcp_url"])

    await maybe_set_initial_title(req.chat_id, req.message)
    await append_message(req.chat_id, "user", req.message)

    async def stream() -> AsyncIterator[bytes]:
        collected = ""
        tool_names: list[str] = []
        seen_tools: set[str] = set()
        # Tokens already known before this turn started or already announced
        # via a preview event. Seeded with the current pending set so we don't
        # re-emit cards for previews from previous turns.
        known_tokens: set[str] = set()
        async with httpx.AsyncClient(timeout=10.0) as http:
            try:
                seed = await http.get(f"{mcp_base}/sessions/{mcp_session_id}/previews")
                if seed.status_code == 200:
                    for row in seed.json():
                        if row.get("preview_token"):
                            known_tokens.add(row["preview_token"])
            except Exception:
                pass

            async def emit_preview_delta(batch_id: Optional[str], tool_name: str):
                try:
                    r = await http.get(f"{mcp_base}/sessions/{mcp_session_id}/previews")
                    if r.status_code != 200:
                        return
                    rows = r.json()
                except Exception:
                    return
                current_tokens = {row.get("preview_token") for row in rows if row.get("preview_token")}
                # Removed previews. The tool name tells us whether they were
                # confirmed or discarded so the card can render the right
                # final state.
                outcome = "confirmed" if tool_name in {"confirm_preview", "confirm_all_previews"} else "discarded"
                for removed in known_tokens - current_tokens:
                    yield (f"data: {json.dumps({'type': 'preview_removed', 'token': removed, 'outcome': outcome})}"
                           "\n\n").encode()
                # Newly staged previews from the just-finished tool call.
                for row in rows:
                    token = row.get("preview_token")
                    if not token or token in known_tokens:
                        continue
                    yield (f"data: {json.dumps(build_preview_event(row, batch_id))}"
                           "\n\n").encode()
                known_tokens.clear()
                known_tokens.update(current_tokens)

            try:
                async for event in agent.astream_events(
                    {"messages": [HumanMessage(content=req.message)]},
                    config={"configurable": {"thread_id": req.chat_id}, "recursion_limit": 100},
                    version="v2",
                ):
                    kind = event["event"]
                    if kind == "on_chat_model_stream":
                        chunk = event["data"]["chunk"]
                        content = chunk.content
                        if isinstance(content, list):
                            content = "".join(
                                p.get("text", "") if isinstance(p, dict) else str(p)
                                for p in content
                            )
                        if content:
                            collected += content
                            yield f"data: {json.dumps({'type': 'token', 'content': content})}\n\n".encode()
                    elif kind == "on_tool_start":
                        name = event["name"]
                        if name not in seen_tools:
                            seen_tools.add(name)
                            tool_names.append(name)
                        yield f"data: {json.dumps({'type': 'tool_start', 'name': name, 'run_id': event.get('run_id')})}\n\n".encode()
                    elif kind == "on_tool_end":
                        name = event["name"]
                        run_id = event.get("run_id")
                        yield f"data: {json.dumps({'type': 'tool_end', 'name': name, 'run_id': run_id})}\n\n".encode()
                        if name in PREVIEW_AFFECTING_TOOLS:
                            async for chunk_bytes in emit_preview_delta(run_id, name):
                                yield chunk_bytes
            except Exception as e:
                yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n".encode()
            finally:
                if collected or tool_names:
                    await append_message(req.chat_id, "assistant", collected, tool_names or None)
                yield f"data: {json.dumps({'type': 'done'})}\n\n".encode()

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=PORT, reload=True)

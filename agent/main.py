import os
import json
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse, HTMLResponse
from pydantic import BaseModel
from dotenv import load_dotenv
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.messages import HumanMessage
from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.prebuilt import create_react_agent
from langgraph.checkpoint.memory import MemorySaver

load_dotenv()

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "")
GEMINI_MODEL   = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
PORT           = int(os.getenv("PORT", "8000"))
DB_PATH        = Path(os.getenv("DB_PATH", "data/agent.db"))
DEFAULT_MCP_URL = os.getenv("MCP_URL", "http://adlerwirt-mcp:3001/mcp")

DB_PATH.parent.mkdir(parents=True, exist_ok=True)

# ── Database ───────────────────────────────────────────────────────────────────

def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

SEED_INSTANCES = [
    {
        "name": "Adlerwirt",
        "mcp_url": "http://adlerwirt-mcp:3001/mcp",
        "directus_url": "http://adlerwirt-directus:8055",
        "directus_token": "adlerwirt-dev-token",
        "directus_email": "admin@gmail.at",
        "directus_password": "admin",
        "website_url": "http://localhost:4321",
    },
    {
        "name": "FitCore Studio",
        "mcp_url": "http://fitcore-mcp:3002/mcp",
        "directus_url": "http://fitcore-directus:8055",
        "directus_token": "fitcore-dev-token",
        "directus_email": "admin@fitcore.studio",
        "directus_password": "admin",
        "website_url": "http://localhost:4323",
    },
]

def init_db():
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS instances (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            name              TEXT NOT NULL,
            mcp_url           TEXT NOT NULL,
            directus_url      TEXT NOT NULL,
            directus_token    TEXT,
            directus_email    TEXT,
            directus_password TEXT,
            website_url       TEXT,
            created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    if conn.execute("SELECT COUNT(*) FROM instances").fetchone()[0] == 0:
        for inst in SEED_INSTANCES:
            conn.execute(
                """INSERT INTO instances
                   (name, mcp_url, directus_url, directus_token, directus_email, directus_password, website_url)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (inst["name"], inst.get("mcp_url", DEFAULT_MCP_URL), inst["directus_url"],
                 inst["directus_token"], inst["directus_email"],
                 inst["directus_password"], inst["website_url"]),
            )
    conn.commit()
    conn.close()

# ── Agent ──────────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are an AI assistant for managing a website's Directus CMS.

Website preview: {website_url}

Change workflow (IMPORTANT):
1. Use list_collections / get_collection_fields only when you genuinely don't know the field names.
   The server validates every write and returns the list of valid fields if you use a wrong one — fix and retry.
2. All write tools (create_item, update_item, update_items, update_singleton, delete_item) STAGE changes —
   nothing is written to the CMS immediately.
3. After staging ALL intended changes, show the user the review URL and ask for confirmation.
4. Only call confirm_preview / confirm_all_previews after the user explicitly says to apply.

Pending-state rule (IMPORTANT):
- The user may confirm or discard changes via the review page in the browser, outside this chat.
- Whenever the user says they confirmed, discarded, or asks what is still pending:
  call list_previews FIRST to see the actual current state before answering.
  Never assume a staged change is still pending — always verify with list_previews.

Keep answers concise. Briefly name each tool you call."""

memory = MemorySaver()

async def build_agent(instance: sqlite3.Row):
    headers = {}
    if instance["directus_url"]:
        headers["x-directus-url"] = instance["directus_url"]
    if instance["directus_token"]:
        headers["x-directus-token"] = instance["directus_token"]
    if instance["directus_email"]:
        headers["x-directus-email"] = instance["directus_email"]
    if instance["directus_password"]:
        headers["x-directus-password"] = instance["directus_password"]

    mcp = MultiServerMCPClient({
        "directus": {
            "url": instance["mcp_url"],
            "transport": "streamable_http",
            **({"headers": headers} if headers else {}),
        }
    })
    tools = await mcp.get_tools()

    return create_react_agent(
        app.state.llm,
        tools,
        checkpointer=memory,
        prompt=SYSTEM_PROMPT.format(website_url=instance["website_url"] or "not configured"),
    )

# ── App ────────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    app.state.llm = ChatGoogleGenerativeAI(
        model=GEMINI_MODEL,
        google_api_key=GOOGLE_API_KEY or None,
        temperature=0.7,
        streaming=True,
        thinking_budget=0,
        generation_config={"thinking_config": {"thinking_budget": 0, "include_thoughts": False}},
    )
    yield

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

class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"
    instance_id: int

# ── Instance CRUD ──────────────────────────────────────────────────────────────

@app.get("/instances")
def list_instances():
    conn = get_db()
    rows = conn.execute("SELECT * FROM instances ORDER BY id").fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.post("/instances", status_code=201)
def create_instance(body: InstanceBody):
    conn = get_db()
    cur = conn.execute(
        """INSERT INTO instances
           (name, mcp_url, directus_url, directus_token, directus_email, directus_password, website_url)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (body.name, DEFAULT_MCP_URL, body.directus_url, body.directus_token,
         body.directus_email, body.directus_password, body.website_url),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM instances WHERE id = ?", (cur.lastrowid,)).fetchone()
    conn.close()
    return dict(row)

@app.put("/instances/{instance_id}")
def update_instance(instance_id: int, body: InstanceBody):
    conn = get_db()
    conn.execute(
        """UPDATE instances
           SET name=?, directus_url=?, directus_token=?,
               directus_email=?, directus_password=?, website_url=?
           WHERE id=?""",
        (body.name, body.directus_url, body.directus_token,
         body.directus_email, body.directus_password, body.website_url, instance_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM instances WHERE id = ?", (instance_id,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Instance not found")
    return dict(row)

@app.delete("/instances/{instance_id}", status_code=204)
def delete_instance(instance_id: int):
    conn = get_db()
    conn.execute("DELETE FROM instances WHERE id = ?", (instance_id,))
    conn.commit()
    conn.close()

# ── Chat ───────────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    with open("static/index.html", encoding="utf-8") as f:
        return HTMLResponse(f.read())

@app.post("/chat")
async def chat(req: ChatRequest):
    conn = get_db()
    instance = conn.execute("SELECT * FROM instances WHERE id = ?", (req.instance_id,)).fetchone()
    conn.close()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    agent = await build_agent(instance)
    thread_id = f"{req.instance_id}:{req.session_id}"

    async def stream():
        try:
            async for event in agent.astream_events(
                {"messages": [HumanMessage(content=req.message)]},
                config={"configurable": {"thread_id": thread_id}, "recursion_limit": 100},
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
                        yield f"data: {json.dumps({'type': 'token', 'content': content})}\n\n"
                elif kind == "on_tool_start":
                    yield f"data: {json.dumps({'type': 'tool_start', 'name': event['name']})}\n\n"
                elif kind == "on_tool_end":
                    yield f"data: {json.dumps({'type': 'tool_end', 'name': event['name']})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"
        finally:
            yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=PORT, reload=True)

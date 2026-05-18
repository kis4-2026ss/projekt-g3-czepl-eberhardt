import os
import json
from contextlib import asynccontextmanager
from fastapi import FastAPI
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
MCP_URL        = os.getenv("MCP_URL", "http://localhost:3001/mcp")
PORT           = int(os.getenv("PORT", "8000"))

SYSTEM_PROMPT = """You are an AI assistant for managing a restaurant's Directus CMS.

Known collections:
- menu_items, categories, speisekarte_copy  → restaurant menu
- events                                    → upcoming events
- team                                      → team members
- testimonials                              → customer testimonials
- faq_items, faq_copy                       → FAQ page
- opening_hours                             → business hours
- Singletons: site_settings, hero, about, ueber_uns_copy, kontakt_copy

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


@asynccontextmanager
async def lifespan(app: FastAPI):
    llm = ChatGoogleGenerativeAI(
        model=GEMINI_MODEL,
        google_api_key=GOOGLE_API_KEY or None,
        temperature=0.7,
        streaming=True,
        thinking_budget=0,
        generation_config={"thinking_config": {"thinking_budget": 0, "include_thoughts": False}},
    )

    mcp = MultiServerMCPClient({
        "directus": {
            "url": MCP_URL,
            "transport": "streamable_http",
        }
    })
    tools = await mcp.get_tools()
    print(f"✓ MCP connected — {len(tools)} tools loaded")

    memory = MemorySaver()
    app.state.agent = create_react_agent(
        llm,
        tools,
        checkpointer=memory,
        prompt=SYSTEM_PROMPT,
    )
    yield


app = FastAPI(title="Directus AI Agent", lifespan=lifespan)
app.mount("/static", StaticFiles(directory="static"), name="static")


class ChatRequest(BaseModel):
    message: str
    session_id: str = "default"


@app.get("/")
async def root():
    with open("static/index.html", encoding="utf-8") as f:
        return HTMLResponse(f.read())


@app.post("/chat")
async def chat(req: ChatRequest):
    async def stream():
        try:
            async for event in app.state.agent.astream_events(
                {"messages": [HumanMessage(content=req.message)]},
                config={"configurable": {"thread_id": req.session_id}, "recursion_limit": 100},
                version="v2",
            ):
                kind = event["event"]

                if kind == "on_chat_model_stream":
                    chunk = event["data"]["chunk"]
                    content = chunk.content
                    # Gemini sometimes returns a list of content parts
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

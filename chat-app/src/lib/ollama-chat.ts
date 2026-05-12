import { Ollama, type Message, type Tool } from 'ollama';
import { openMcp, listTools, callTool, type DirectusCreds } from './mcp-client';

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'llama3.1:8b';
const MAX_TURNS = 8;

const ollama = new Ollama({ host: OLLAMA_HOST });

function systemPrompt(profileName: string, directusUrl: string): string {
  return `You are MCP Console, a conversational assistant for managing content in a Directus headless CMS via the Model Context Protocol.

Connected to: **${profileName}** (${directusUrl})

## Critical rules
- ALWAYS call tools directly using the tool calling mechanism. NEVER write tool calls as JSON text in your reply.
- Do NOT say "I will call X" or "Let me call X" — just call it immediately.
- Do NOT describe what you are about to do. Act first, explain after (briefly).

## Available tools
- list_collections — list all collections
- get_collection_fields — fields of a specific collection
- get_schema — full schema overview
- read_items / read_item / read_singleton — read content
- create_item / update_item / update_items / update_singleton / delete_item — write content
  (update_items takes a list of IDs and updates them all at once — use it for bulk changes)

## Workflow
1. When you need the schema, call get_schema or list_collections first — you do not know it in advance.
2. Before any update, read the current value so the user can see what changed.
3. For bulk updates or deletions, confirm with the user before proceeding.
4. After a successful write, briefly state what changed.
5. Reply in the user's language.`;
}

export type ChatEvent =
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id: string; result: string; isError: boolean }
  | { type: 'text'; content: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

export type ClientMessage = { role: 'user' | 'assistant'; content: string };

export interface RunChatOptions {
  profile: { name: string; creds: DirectusCreds };
}

export async function* runChat(
  messages: ClientMessage[],
  opts: RunChatOptions,
): AsyncGenerator<ChatEvent> {
  const mcp = await openMcp(opts.profile.creds);
  try {
    const mcpTools = await listTools(mcp);
    const tools: Tool[] = mcpTools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        // Ollama expects a JSON Schema object here. MCP gives us one already.
        parameters: t.inputSchema as Tool['function']['parameters'],
      },
    }));

    const history: Message[] = [
      { role: 'system', content: systemPrompt(opts.profile.name, opts.profile.creds.url) },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const res = await ollama.chat({
        model: OLLAMA_MODEL,
        messages: history,
        tools,
        stream: false,
      });

      const assistant = res.message;
      history.push(assistant);

      const calls = assistant.tool_calls ?? [];
      if (calls.length > 0) {
        for (let i = 0; i < calls.length; i++) {
          const call = calls[i]!;
          const id = `t${turn}-${i}`;
          const args = (call.function.arguments ?? {}) as Record<string, unknown>;
          yield { type: 'tool_call', id, name: call.function.name, args };

          try {
            const result = await callTool(mcp, call.function.name, args);
            history.push({ role: 'tool', content: result.text });
            yield { type: 'tool_result', id, result: result.text, isError: result.isError };
            if (result.isError) {
              history.push({
                role: 'user',
                content: '[Tool failed. Do NOT write any text. Immediately call the right tool to investigate and fix the problem — list_collections or read_items if you need to find the correct collection or item ID.]',
              });
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            history.push({ role: 'tool', content: `Error: ${msg}` });
            yield { type: 'tool_result', id, result: msg, isError: true };
            history.push({
              role: 'user',
              content: '[Tool failed. Do NOT write any text. Immediately call the right tool to investigate and fix the problem — list_collections or read_items if you need to find the correct collection or item ID.]',
            });
          }
        }
        continue;
      }

      if (assistant.content) {
        yield { type: 'text', content: assistant.content };
      }
      yield { type: 'done' };
      return;
    }

    yield { type: 'error', message: `Maximum tool-use iterations (${MAX_TURNS}) reached.` };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // Ollama returns terse errors like `model "x" not found, try pulling it first`.
    // Rewrite into something actionable instead of just relaying it.
    const notFound = /model ['"]?(.+?)['"]? not found/i.exec(raw);
    if (notFound) {
      const model = notFound[1] ?? OLLAMA_MODEL;
      yield {
        type: 'error',
        message:
          `Model "${model}" isn't loaded in Ollama yet. Pull it with:\n\n` +
          `  docker exec ollama ollama pull ${model}\n\n` +
          `Once the pull finishes, just send your message again.`,
      };
    } else {
      yield { type: 'error', message: raw };
    }
  } finally {
    await mcp.close().catch(() => {});
  }
}

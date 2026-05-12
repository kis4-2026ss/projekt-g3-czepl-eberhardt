/**
 * Background model-pull manager.
 *
 * The chat-app server should start immediately even when the model isn't loaded
 * in Ollama yet — pulling 4-5 GB blocking startup is a bad UX. This module owns
 * the pull lifecycle and exposes its state for the health endpoint + UI.
 */

const OLLAMA_HOST  = process.env.OLLAMA_HOST  ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'llama3.1:8b';

export type PullStatus = 'idle' | 'checking' | 'pulling' | 'ready' | 'error';

export interface PullState {
  status:      PullStatus;
  model:       string;
  /** Last status line reported by Ollama (e.g. "pulling 667b0c1932bc"). */
  statusText:  string;
  /** Bytes downloaded for the current layer (Ollama reports per-layer, not overall). */
  current:     number;
  /** Total bytes for the current layer. */
  total:       number;
  error:       string | null;
  startedAt:   number | null;
  finishedAt:  number | null;
}

const state: PullState = {
  status:     'idle',
  model:      OLLAMA_MODEL,
  statusText: '',
  current:    0,
  total:      0,
  error:      null,
  startedAt:  null,
  finishedAt: null,
};

let inFlight: Promise<void> | null = null;

export function getPullState(): PullState {
  return { ...state };
}

async function modelExists(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`);
    if (!res.ok) return false;
    const data = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
    return (data.models ?? []).some((m) => m.name === OLLAMA_MODEL || m.model === OLLAMA_MODEL);
  } catch {
    return false;
  }
}

/** Fire-and-forget background trigger. Safe to call repeatedly — coalesces. */
export function ensureModelInBackground(): void {
  void ensureModel().catch(() => { /* state already recorded the error */ });
}

export function ensureModel(): Promise<void> {
  if (state.status === 'ready') return Promise.resolve();
  if (inFlight) return inFlight;

  inFlight = (async () => {
    state.status     = 'checking';
    state.error      = null;
    state.statusText = 'checking…';

    if (await modelExists()) {
      state.status     = 'ready';
      state.statusText = 'ready';
      state.finishedAt = Date.now();
      return;
    }

    state.status     = 'pulling';
    state.startedAt  = Date.now();
    state.finishedAt = null;
    state.statusText = 'starting…';
    state.current    = 0;
    state.total      = 0;

    try {
      const res = await fetch(`${OLLAMA_HOST}/api/pull`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: state.model, stream: true }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`pull request failed: HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const dec    = new TextDecoder();
      let buffer  = '';
      let sawSuccess = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += dec.decode(value, { stream: true });

        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let j: { error?: string; status?: string; completed?: number; total?: number };
          try { j = JSON.parse(line); } catch { continue; }
          if (j.error)  throw new Error(j.error);
          if (j.status) state.statusText = j.status;
          if (j.status === 'success') sawSuccess = true;
          if (typeof j.completed === 'number') state.current = j.completed;
          if (typeof j.total     === 'number') state.total   = j.total;
        }
      }

      if (!sawSuccess) throw new Error('pull stream ended without a success status');
      if (!(await modelExists())) {
        throw new Error('pull reported success but model is not listed in /api/tags');
      }

      state.status     = 'ready';
      state.statusText = 'ready';
      state.finishedAt = Date.now();
    } catch (e) {
      state.status     = 'error';
      state.statusText = '';
      state.error      = e instanceof Error ? e.message : String(e);
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Reset error state so the next `ensureModel()` retries from scratch. */
export function retryPull(): Promise<void> {
  if (state.status === 'error') {
    state.status     = 'idle';
    state.error      = null;
    state.statusText = '';
  }
  return ensureModel();
}

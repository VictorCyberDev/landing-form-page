import Anthropic from '@anthropic-ai/sdk';

export type CompleteOpts = { system: string; user: string; maxTokens: number };

export class LLMError extends Error {
  constructor(
    message: string,
    public status: number,
    public provider: string,
  ) {
    super(message);
  }
}

export type Provider = {
  name: 'anthropic' | 'gemini' | 'groq' | 'openrouter';
  /** Unique id for cooldown tracking, e.g. "openrouter:google/gemma-4-31b-it:free". */
  id: string;
  free?: boolean;
  complete: (o: CompleteOpts) => Promise<string>;
};

const TIMEOUT = 50_000;

async function postJson(url: string, headers: Record<string, string>, body: unknown, provider: string, timeoutMs = TIMEOUT) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new LLMError(text.slice(0, 300) || `HTTP ${res.status}`, res.status, provider);
  return JSON.parse(text);
}

function gemini(key: string): Provider {
  const base = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const safety = [
    'HARM_CATEGORY_HARASSMENT',
    'HARM_CATEGORY_HATE_SPEECH',
    'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    'HARM_CATEGORY_DANGEROUS_CONTENT',
  ].map((category) => ({ category, threshold: 'BLOCK_NONE' }));
  return {
    name: 'gemini',
    id: 'gemini',
    async complete({ system, user, maxTokens }) {
      const body = (thinking: boolean) => ({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: maxTokens,
          ...(thinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
        safetySettings: safety,
      });
      const url = `${base}/v1beta/models/${model}:generateContent`;
      const headers = { 'x-goog-api-key': key };
      let data;
      try {
        data = await postJson(url, headers, body(true), 'gemini');
      } catch (e) {
        // Some models reject the thinking switch; retry plainly.
        if (e instanceof LLMError && e.status === 400) data = await postJson(url, headers, body(false), 'gemini');
        else throw e;
      }
      const cand = data.candidates?.[0];
      const text = (cand?.content?.parts || []).map((p: { text?: string }) => p.text || '').join('');
      if (!text.trim()) {
        throw new LLMError(`Gemini returned no text (${cand?.finishReason || data.promptFeedback?.blockReason || 'unknown'})`, 502, 'gemini');
      }
      if (cand?.finishReason === 'MAX_TOKENS') throw new LLMError('Gemini output was cut off', 502, 'gemini');
      return text;
    },
  };
}

function groq(key: string, model: string): Provider {
  const base = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
  return {
    name: 'groq',
    id: `groq:${model}`,
    free: true,
    async complete({ system, user, maxTokens }) {
      const data = await postJson(
        `${base}/chat/completions`,
        { authorization: `Bearer ${key}` },
        {
          model,
          temperature: 0,
          max_tokens: Math.min(maxTokens, 8000),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
        'groq',
      );
      const choice = data.choices?.[0];
      const text = choice?.message?.content || '';
      if (!text.trim()) throw new LLMError('Groq returned no text', 502, 'groq');
      if (choice?.finish_reason === 'length') throw new LLMError('Groq output was cut off', 502, 'groq');
      // Some Groq reasoning models wrap their thinking in <think> tags.
      return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    },
  };
}

// Hard price ceiling (USD per million tokens) sent with every OpenRouter request, so a request can
// never be routed to an expensive model. Free models cost 0 and always pass.
const MAX_PRICE = { prompt: 0.6, completion: 1.2 };

function openrouter(key: string, model: string, free: boolean): Provider {
  const base = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
  return {
    name: 'openrouter',
    id: `openrouter:${model}`,
    free,
    async complete({ system, user, maxTokens }) {
      const data = await postJson(
        `${base}/chat/completions`,
        { authorization: `Bearer ${key}`, 'x-title': 'Novel to PDF' },
        {
          model,
          max_tokens: maxTokens,
          provider: { max_price: MAX_PRICE },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
        'openrouter',
        free ? 30_000 : TIMEOUT,
      );
      if (data.error) {
        throw new LLMError(JSON.stringify(data.error).slice(0, 300), Number(data.error.code) || 502, 'openrouter');
      }
      const choice = data.choices?.[0];
      const text = (choice?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (!text) throw new LLMError('OpenRouter returned no text', 502, 'openrouter');
      if (choice?.finish_reason === 'length') throw new LLMError('OpenRouter output was cut off', 502, 'openrouter');
      return text;
    },
  };
}

// Free models, best translators first. Anything else free that looks like a general chat model is
// appended from OpenRouter's live model list.
const FREE_PREFERENCE = [
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'thinkingmachines/inkling:free',
  'google/gemma-4-26b-a4b-it:free',
  'poolside/laguna-s-2.1:free',
];
// Cheap Chinese models only, used when no free model can do the job.
const CHEAP_CHINESE = ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash', 'qwen/qwen3.7-flash'];

let freeCache: { at: number; ids: string[] } | null = null;
async function freeModels(base: string): Promise<string[]> {
  if (freeCache && Date.now() - freeCache.at < 3_600_000) return freeCache.ids;
  let live: string[] = [];
  try {
    const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(8000) });
    const data = (await res.json()) as { data?: { id: string; context_length?: number }[] };
    live = (data.data || [])
      .filter((m) => m.id.endsWith(':free') && (m.context_length || 0) >= 100_000)
      .map((m) => m.id)
      .filter((id) => !/code|safety|-vl|omni|lfm|flint|embed|guard/i.test(id));
  } catch {
    /* use the static list */
  }
  const ordered = [
    ...FREE_PREFERENCE.filter((id) => !live.length || live.includes(id)),
    ...live.filter((id) => !FREE_PREFERENCE.includes(id)),
  ].slice(0, 6);
  freeCache = { at: Date.now(), ids: ordered.length ? ordered : FREE_PREFERENCE };
  return freeCache.ids;
}

function anthropic(client: Anthropic, model: string, name: Provider['name']): Provider {
  return {
    name,
    id: `anthropic:${model}`,
    async complete({ system, user, maxTokens }) {
      try {
        const msg = await client.messages.create({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
        });
        if (msg.stop_reason === 'max_tokens') throw new LLMError('Output was cut off', 502, name);
        return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      } catch (e) {
        if (e instanceof LLMError) throw e;
        throw new LLMError((e as Error).message.slice(0, 300), (e as { status?: number }).status || 502, name);
      }
    },
  };
}

/**
 * Fast providers (Groq free + DeepSeek flash, ~$0.1 per million tokens) share the load: each request starts
 * at the next one in turn, so parallel chunks don't queue behind one rate limit. Slower free models and the
 * larger cheap models are fallbacks.
 */
export type Plan = { fast: Provider[]; fallback: Provider[] };

export async function getProviders(): Promise<Plan> {
  const fast: Provider[] = [];
  const fallback: Provider[] = [];
  const orKey = process.env.OPENROUTER_API_KEY;
  if (process.env.GROQ_API_KEY) {
    for (const m of (process.env.GROQ_MODELS || 'qwen/qwen3.8-27b,openai/gpt-oss-120b').split(',')) {
      fast.push(groq(process.env.GROQ_API_KEY, m.trim()));
    }
  }
  if (orKey) {
    const base = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
    fast.push(openrouter(orKey, CHEAP_CHINESE[1], false)); // deepseek-v4-flash
    // Groq and OpenRouter work side by side: the three best free OpenRouter models join the rotation,
    // so when Groq is at its speed limit the others carry on at the same time.
    const free = await freeModels(base);
    free.slice(0, 3).forEach((id) => fast.push(openrouter(orKey, id, true)));
    free.slice(3).forEach((id) => fallback.push(openrouter(orKey, id, true)));
    fallback.push(openrouter(orKey, CHEAP_CHINESE[0], false), openrouter(orKey, CHEAP_CHINESE[2], false));
  }
  if (process.env.GEMINI_API_KEY) fast.push(gemini(process.env.GEMINI_API_KEY));
  if (process.env.ANTHROPIC_API_KEY && process.env.ALLOW_PAID_CLAUDE === '1') {
    fallback.push(
      anthropic(new Anthropic({ timeout: TIMEOUT, maxRetries: 1 }), process.env.TRANSLATION_MODEL || 'claude-sonnet-5-5', 'anthropic'),
    );
  }
  return { fast, fallback };
}

// Models that just failed are skipped for a while, so a rate-limited free model doesn't slow every call.
const cooldown = new Map<string, number>();
let freeExhaustedUntil = 0;

function noteFailure(p: Provider, e: LLMError) {
  const msg = e.message.toLowerCase();
  const now = Date.now();
  if (p.free && (msg.includes('per-day') || msg.includes('per day'))) freeExhaustedUntil = now + 3_600_000;
  else if (e.status === 429) cooldown.set(p.id, now + 45_000);
  else if (e.status === 402 || e.status === 404 || e.status === 403) cooldown.set(p.id, now + 600_000);
  else cooldown.set(p.id, now + 90_000);
}

let rotation = 0;

/** Run one request on the next fast provider; fall through the rest, then the fallbacks. Not rate-limited by this app. */
export async function complete(plan: Plan, o: CompleteOpts): Promise<{ text: string; via: string }> {
  const started = Date.now();
  const now = () => Date.now();
  const usable = (p: Provider) => !((cooldown.get(p.id) || 0) > now()) && !(p.free && freeExhaustedUntil > now());
  const fastOk = plan.fast.filter(usable);
  const k = fastOk.length ? rotation++ % fastOk.length : 0;
  const rotated = [...fastOk.slice(k), ...fastOk.slice(0, k)];
  let list = [...rotated, ...plan.fallback.filter(usable)];
  if (!list.length) list = [...plan.fast, ...plan.fallback]; // everything cooling down: try anyway
  let last: LLMError | null = null;
  let busy = false; // at least one provider was only rate-limited / overloaded, i.e. waiting will help
  for (const p of list) {
    if (now() - started > 42_000 && last) {
      busy = true;
      break; // leave time to answer within the function limit
    }
    try {
      return { text: await p.complete(o), via: p.id.replace(/^openrouter:/, '') };
    } catch (e) {
      last = e instanceof LLMError ? e : new LLMError((e as Error).message, 502, p.name);
      if (last.status === 429 || last.status >= 500 || last.name === 'TimeoutError' || last.name === 'AbortError') busy = true;
      noteFailure(p, last);
    }
  }
  if (!last) throw new LLMError('No AI provider configured', 503, 'none');
  throw busy ? new LLMError(last.message, 429, last.provider) : last;
}

/** Gemini with Google Search grounding: finds where a work can be read online. */
export async function geminiSearch(prompt: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new LLMError('no gemini key', 503, 'gemini');
  const base = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const data = await postJson(
    `${base}/v1beta/models/${model}:generateContent`,
    { 'x-goog-api-key': key },
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0 },
    },
    'gemini',
  );
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.map((p: { text?: string }) => p.text || '').join('');
}

/** OpenRouter with its built-in web search (":online"): finds where a work can be read online. */
export async function openrouterSearch(prompt: string): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new LLMError('no openrouter key', 503, 'openrouter');
  const base = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
  const model = (process.env.OPENROUTER_SEARCH_MODEL || 'deepseek/deepseek-v4-flash') + ':online';
  const data = await postJson(
    `${base}/chat/completions`,
    { authorization: `Bearer ${key}`, 'x-title': 'Novel to PDF' },
    { model, max_tokens: 1500, messages: [{ role: 'user', content: prompt }] },
    'openrouter',
  );
  return data.choices?.[0]?.message?.content || '';
}

/** Groq's built-in web search (browser_search) — searches the open web, not a fixed list of sites. */
export async function groqSearch(prompt: string): Promise<string> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new LLMError('no groq key', 503, 'groq');
  const base = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
  let last: LLMError | null = null;
  // The small model has its own daily allowance; the larger one is the backup.
  for (const model of ['openai/gpt-oss-20b', 'openai/gpt-oss-120b']) {
    try {
      const data = await postJson(
        `${base}/chat/completions`,
        { authorization: `Bearer ${key}` },
        {
          model,
          max_completion_tokens: 2500,
          reasoning_effort: 'low',
          tools: [{ type: 'browser_search' }],
          messages: [
            {
              role: 'system',
              content:
                'You are a book-finding search assistant with live web search. Run at most 3 web searches. ' +
                'Do NOT open or read result pages; use only result titles, URLs and snippets. Output only JSON.',
            },
            { role: 'user', content: prompt },
          ],
        },
        'groq',
        55_000,
      );
      const text = data.choices?.[0]?.message?.content || '';
      if (text.trim()) return text;
    } catch (e) {
      last = e instanceof LLMError ? e : new LLMError((e as Error).message, 502, 'groq');
    }
  }
  throw last ?? new LLMError('Groq search returned nothing', 502, 'groq');
}

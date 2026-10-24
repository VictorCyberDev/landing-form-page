import Anthropic from '@anthropic-ai/sdk';
import { getVercelOidcToken } from '@vercel/oidc';

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
  name: 'anthropic' | 'gateway' | 'gemini' | 'groq';
  complete: (o: CompleteOpts) => Promise<string>;
};

const TIMEOUT = 50_000;

async function postJson(url: string, headers: Record<string, string>, body: unknown, provider: string) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
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

function groq(key: string): Provider {
  const base = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  return {
    name: 'groq',
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

function anthropic(client: Anthropic, model: string, name: Provider['name']): Provider {
  return {
    name,
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

/** Providers in order of preference; callers fall through on failure. */
export async function getProviders(): Promise<Provider[]> {
  const out: Provider[] = [];
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    out.push(
      anthropic(
        new Anthropic({ timeout: TIMEOUT, maxRetries: 1 }),
        process.env.TRANSLATION_MODEL || 'claude-sonnet-5-5',
        'anthropic',
      ),
    );
  }
  if (process.env.GEMINI_API_KEY) out.push(gemini(process.env.GEMINI_API_KEY));
  if (process.env.GROQ_API_KEY) out.push(groq(process.env.GROQ_API_KEY));
  if (!out.length && (process.env.AI_GATEWAY_API_KEY || process.env.VERCEL)) {
    try {
      const apiKey = process.env.AI_GATEWAY_API_KEY || (await getVercelOidcToken());
      out.push(
        anthropic(
          new Anthropic({ apiKey, baseURL: 'https://ai-gateway.vercel.sh', timeout: TIMEOUT, maxRetries: 1 }),
          process.env.TRANSLATION_MODEL || 'anthropic/claude-sonnet-5',
          'gateway',
        ),
      );
    } catch {
      /* no OIDC token available */
    }
  }
  return out;
}

/** Try each provider in turn; retry transient errors once per provider. */
export async function complete(providers: Provider[], o: CompleteOpts): Promise<{ text: string; via: string }> {
  let last: LLMError | null = null;
  for (const p of providers) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return { text: await p.complete(o), via: p.name };
      } catch (e) {
        last = e instanceof LLMError ? e : new LLMError((e as Error).message, 502, p.name);
        const transient = last.status === 429 || last.status >= 500 || last.name === 'TimeoutError';
        if (!transient) break;
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
      }
    }
  }
  throw last ?? new LLMError('No AI provider configured', 503, 'none');
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

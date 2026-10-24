import Anthropic from '@anthropic-ai/sdk';
import { geminiSearch, openrouterSearch } from './llm';
import { safeFetch } from './safe-fetch';
import { matchScore } from './text';

export const WIKISOURCE_LANGS = ['en', 'fr', 'de', 'es', 'it', 'ru', 'zh', 'ja'];

export type WebHit = { title: string; author?: string; url: string; langHint?: string };

/** Search Wikisource (the free library of source texts) in several languages. */
export async function searchWikisource(query: string): Promise<WebHit[]> {
  const results = await Promise.allSettled(
    WIKISOURCE_LANGS.map(async (lang) => {
      const res = await safeFetch(
        `https://${lang}.wikisource.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=4&format=json`,
        { timeoutMs: 8000, headers: { accept: 'application/json' } },
      );
      if (!res.ok) throw new Error(`${lang}.wikisource ${res.status}`);
      const data = (await res.json()) as { query?: { search?: { title: string }[] } };
      return (data.query?.search || [])
        .filter((r) => !r.title.includes('/') && matchScore(query, r.title) >= 0.6)
        .slice(0, 1)
        .map((r) => ({
          title: r.title,
          url: `https://${lang}.wikisource.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
          langHint: lang,
        }));
    }),
  );
  return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

/** Last resort: let an AI with live web search find places the work can be read. */
export async function findOnlineWithAI(query: string): Promise<WebHit[]> {
  const ask =
    `Find where the book or novel "${query}" can be read online, in full, for free ` +
    `(original-language web-novel sites, Wikisource, Project Gutenberg, the author's or publisher's own site, ` +
    `public-domain archives). Prefer a table-of-contents / chapter-list page or the first chapter, and give real, working URLs only. ` +
    `Return at most 5 results as ONLY a JSON array, no other text: ` +
    `[{"title": string, "author": string|null, "language": string, "url": string}]. ` +
    `If you cannot find anywhere it can be read, return [].`;
  let text = '';
  if (process.env.OPENROUTER_API_KEY) {
    text = await openrouterSearch(ask);
  } else if (process.env.GEMINI_API_KEY) {
    text = await geminiSearch(ask);
  } else if (process.env.ANTHROPIC_API_KEY) {
    const client = new Anthropic({ timeout: 50_000, maxRetries: 1 });
    const msg = await client.messages.create({
      model: process.env.SEARCH_MODEL || process.env.TRANSLATION_MODEL || 'claude-sonnet-5-5',
      max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }] as never,
      messages: [{ role: 'user', content: ask }],
    });
    text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  } else {
    return [];
  }
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as {
      title?: string;
      author?: string | null;
      language?: string;
      url?: string;
    }[];
    return arr
      .filter((a) => a.url && /^https?:\/\//i.test(a.url))
      .slice(0, 5)
      .map((a) => ({
        title: a.title || query,
        author: a.author || undefined,
        url: a.url!,
        langHint: a.language,
      }));
  } catch {
    return [];
  }
}

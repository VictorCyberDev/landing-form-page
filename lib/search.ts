import { safeFetch } from './safe-fetch';
import { matchScore } from './text';
import type { WebHit } from './webfind';

/**
 * General web search through an official search API, if you've added a key (any one of these works):
 *   BRAVE_API_KEY (brave.com/search/api, free tier), TAVILY_API_KEY (tavily.com, free tier), SERPER_API_KEY (serper.dev).
 */
export function hasSearchApi() {
  return !!(process.env.BRAVE_API_KEY || process.env.TAVILY_API_KEY || process.env.SERPER_API_KEY);
}

export async function searchWebApi(query: string, count = 10): Promise<WebHit[]> {
  if (process.env.BRAVE_API_KEY) {
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`, {
      headers: { accept: 'application/json', 'x-subscription-token': process.env.BRAVE_API_KEY },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Brave search ${res.status}`);
    const d = (await res.json()) as { web?: { results?: { title: string; url: string }[] } };
    return (d.web?.results || []).map((r) => ({ title: r.title, url: r.url }));
  }
  if (process.env.TAVILY_API_KEY) {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
      body: JSON.stringify({ query, max_results: count }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Tavily search ${res.status}`);
    const d = (await res.json()) as { results?: { title: string; url: string }[] };
    return (d.results || []).map((r) => ({ title: r.title, url: r.url }));
  }
  if (process.env.SERPER_API_KEY) {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.SERPER_API_KEY },
      body: JSON.stringify({ q: query, num: count }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Serper search ${res.status}`);
    const d = (await res.json()) as { organic?: { title: string; link: string }[] };
    return (d.organic || []).map((r) => ({ title: r.title, url: r.link }));
  }
  return [];
}

export type ArchiveHit = { id: string; title: string; author?: string; language?: string; score: number };

/** Internet Archive's public texts (older books, public-domain translations, uploaded novels). */
export async function searchArchive(query: string): Promise<ArchiveHit[]> {
  const q = query.replace(/["()]/g, ' ').trim();
  const url =
    `https://archive.org/advancedsearch.php?q=${encodeURIComponent(`(title:(${q}) OR creator:(${q})) AND mediatype:texts AND -access-restricted-item:true`)}` +
    `&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=creator&fl%5B%5D=language&rows=12&output=json&sort%5B%5D=downloads+desc`;
  const res = await safeFetch(url, { timeoutMs: 15000, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Internet Archive search ${res.status}`);
  const d = (await res.json()) as {
    response?: { docs?: { identifier: string; title?: string; creator?: string | string[]; language?: string | string[] }[] };
  };
  return (d.response?.docs || []).map((x) => {
    const title = String(x.title || x.identifier);
    const author = Array.isArray(x.creator) ? x.creator[0] : x.creator;
    const lang = Array.isArray(x.language) ? x.language[0] : x.language;
    // Prefer titles that are close to what was typed (not just containing the words).
    const closeness = Math.min(0.25, Math.abs(title.length - query.length) / 400);
    return { id: x.identifier, title, author, language: lang, score: matchScore(query, `${title} ${author || ''}`) - closeness };
  });
}

export async function fetchArchiveText(id: string): Promise<string> {
  if (!/^[\w.-]+$/.test(id)) throw new Error('Bad Internet Archive id');
  const res = await safeFetch(`https://archive.org/download/${id}/${id}_djvu.txt`, { timeoutMs: 45000 });
  if (res.status === 401 || res.status === 403) throw new Error('That edition is borrow-only on the Internet Archive.');
  if (!res.ok) throw new Error(`Internet Archive answered ${res.status}`);
  return await res.text();
}

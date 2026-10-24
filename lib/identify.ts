import { safeFetch } from './safe-fetch';
import { matchScore, matchThreshold } from './text';
import type { Suggestion } from './types';

/** "Is this it?": Wikipedia's page for the novel (cover picture, author, blurb), via the public API. */
export async function wikipediaNovel(query: string): Promise<Suggestion | null> {
  const search = await safeFetch(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(`${query} novel`)}&srlimit=4&format=json`,
    { timeoutMs: 10000, headers: { accept: 'application/json' } },
  );
  if (!search.ok) return null;
  const data = (await search.json()) as { query?: { search?: { title: string }[] } };
  for (const hit of data.query?.search || []) {
    if (matchScore(query, hit.title) < matchThreshold(query) * 0.7) continue;
    const res = await safeFetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`, {
      timeoutMs: 10000,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) continue;
    const s = (await res.json()) as {
      title: string;
      description?: string;
      extract?: string;
      thumbnail?: { source: string };
      content_urls?: { desktop?: { page?: string } };
    };
    const about = `${s.description || ''} ${s.extract || ''}`;
    if (!/novel|book|fiction|story|trilogy|series|epic|romance/i.test(about)) continue;
    const by = /\bby ([A-Z][^.,;(]+?)(?:[.,;(]|$)/.exec(s.description || s.extract || '')?.[1]?.trim();
    const year = /\b(1[5-9]\d\d|20\d\d)\b/.exec(s.description || '')?.[1];
    return {
      title: s.title,
      author: by,
      year: year ? Number(year) : undefined,
      languages: [],
      coverUrl: s.thumbnail?.source,
      blurb: (s.extract || '').slice(0, 360),
      url: s.content_urls?.desktop?.page,
    };
  }
  return null;
}

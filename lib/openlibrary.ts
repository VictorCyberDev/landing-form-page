import { safeFetch } from './safe-fetch';
import { matchScore } from './text';
import type { ElsewhereEdition, Suggestion } from './types';

type OLDoc = {
  key: string;
  title: string;
  author_name?: string[];
  language?: string[];
  ebook_access?: string;
  first_publish_year?: number;
};

/** Which English editions exist (even if they can't be downloaded for free)? */
export async function searchOpenLibrary(query: string): Promise<ElsewhereEdition[]> {
  const res = await safeFetch(
    `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=10&fields=key,title,author_name,language,ebook_access,first_publish_year`,
    { timeoutMs: 15000, headers: { accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`Open Library answered ${res.status}`);
  const data = (await res.json()) as { docs?: OLDoc[] };
  const out: ElsewhereEdition[] = [];
  for (const d of data.docs || []) {
    if (!d.language?.includes('eng')) continue;
    if (matchScore(query, `${d.title} ${(d.author_name || []).join(' ')}`) < 0.6) continue;
    const access =
      d.ebook_access === 'public'
        ? 'Free to read online'
        : d.ebook_access === 'borrowable'
          ? 'Borrowable (not a free download)'
          : 'Print / purchase only';
    out.push({
      title: d.title,
      author: d.author_name?.[0],
      url: `https://openlibrary.org${d.key}`,
      access,
      year: d.first_publish_year,
    });
    if (out.length >= 3) break;
  }
  return out;
}

/** "Is it this one?": the closest works to the name, with their authors, whether or not they can be downloaded. */
export async function suggestWorks(query: string): Promise<Suggestion[]> {
  const res = await safeFetch(
    `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=8&fields=title,author_name,first_publish_year,language,edition_count`,
    { timeoutMs: 15000, headers: { accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`Open Library answered ${res.status}`);
  const data = (await res.json()) as {
    docs?: { title: string; author_name?: string[]; first_publish_year?: number; language?: string[]; edition_count?: number }[];
  };
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const d of (data.docs || []).sort((a, b) => (b.edition_count || 0) - (a.edition_count || 0))) {
    const key = `${d.title}|${d.author_name?.[0]}`.toLowerCase();
    if (seen.has(key) || matchScore(query, `${d.title} ${(d.author_name || []).join(' ')}`) < 0.4) continue;
    seen.add(key);
    out.push({ title: d.title, author: d.author_name?.[0], year: d.first_publish_year, languages: d.language || [] });
    if (out.length >= 4) break;
  }
  return out;
}

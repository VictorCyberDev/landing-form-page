import { safeFetch } from './safe-fetch';
import { matchScore } from './text';
import type { ElsewhereEdition } from './types';

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

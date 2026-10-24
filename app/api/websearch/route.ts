import { NextResponse } from 'next/server';
import { extractPage } from '@/lib/extract';
import { groqSearch } from '@/lib/llm';
import { hasSearchApi, searchWebApi } from '@/lib/search';
import { looksEnglish } from '@/lib/text';
import type { AboutLink, Candidate } from '@/lib/types';
import type { WebHit } from '@/lib/webfind';

export const maxDuration = 120;

const ABOUT_ONLY =
  /(^|\.)(wikipedia|wikiwand|goodreads|amazon|imdb|sparknotes|shmoop|cliffsnotes|litcharts|gradesaver|bookrags|enotes|reddit|youtube|facebook|twitter|pinterest|quora|britannica|barnesandnoble|kobo|audible|scribd|tvtropes|fandom)\.[a-z.]+$/i;

const langName = (code?: string) => {
  if (!code) return 'Unknown language';
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
};

function parseHits(text: string): (WebHit & { description?: string; canReadOnline?: boolean })[] {
  const s = text.indexOf('[');
  const e = text.lastIndexOf(']');
  if (s < 0 || e < s) return [];
  try {
    return (JSON.parse(text.slice(s, e + 1)) as Record<string, unknown>[])
      .filter((a) => typeof a.url === 'string' && /^https?:\/\//i.test(a.url as string))
      .map((a) => ({
        title: String(a.title || ''),
        url: String(a.url),
        author: a.author ? String(a.author) : undefined,
        langHint: a.language ? String(a.language) : undefined,
        description: a.description ? String(a.description) : undefined,
        canReadOnline: a.canReadOnline !== false,
      }));
  } catch {
    return [];
  }
}

/** GET so identical searches are cached at the edge for a day: repeat searches cost nothing. */
export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get('q') || '').trim();
  if (!q) return NextResponse.json({ error: 'empty' }, { status: 400 });

  let hits: (WebHit & { description?: string; canReadOnline?: boolean })[] = [];
  let via = '';
  let problem = '';
  if (process.env.GROQ_API_KEY) {
    try {
      hits = parseHits(
        await groqSearch(
          `Novel: "${q}". Search the whole web: find every kind of page where the full text can be read online ` +
            `(web-novel sites, fan translations, blogs, forums, libraries, publishers, in any language) and a few pages that describe it. ` +
            `Return a JSON array of up to 10 objects: {"title","url","author","language","description","canReadOnline"(boolean: true only if the page itself has the novel's text or a chapter list)}.`,
        ),
      );
      via = 'Groq web search';
    } catch (e) {
      problem = (e as Error).message.slice(0, 160);
    }
  }
  if (!hits.length && hasSearchApi()) {
    try {
      hits = (await searchWebApi(`"${q}" novel read online`)).map((h) => ({ ...h, canReadOnline: true }));
      via = 'web search';
    } catch (e) {
      problem = (e as Error).message.slice(0, 160);
    }
  }

  const uniq = [...new Map(hits.map((h) => [h.url, h])).values()].slice(0, 10);
  const candidates: Candidate[] = [];
  const about: AboutLink[] = [];
  const blocked: AboutLink[] = [];
  await Promise.all(
    uniq.map(async (h) => {
      const host = new URL(h.url).hostname.replace(/^www\./, '');
      if (ABOUT_ONLY.test(host) || h.canReadOnline === false) {
        about.push({ title: h.title, url: h.url, description: h.description });
        return;
      }
      try {
        const page = await extractPage(h.url);
        const english = looksEnglish(page.paragraphs.join(' '));
        candidates.push({
          key: `url:${h.url}`,
          title: h.title || page.title,
          author: h.author,
          language: english ? 'English' : langName(page.lang || h.langHint?.slice(0, 2).toLowerCase()),
          sourceName: host,
          url: h.url,
          ref: { kind: 'url', url: h.url },
          pageInfo: { words: page.words, chapterLinks: page.chapterLinks, next: page.next },
          image: page.image,
          blurb: h.description || page.blurb,
        });
      } catch (e) {
        blocked.push({ title: h.title || host, url: h.url, description: h.description, reason: (e as Error).message.slice(0, 140) });
      }
    }),
  );
  const size = (c: Candidate) => (c.pageInfo?.chapterLinks?.length ? c.pageInfo.chapterLinks.length * 1500 : c.pageInfo?.words || 0);
  candidates.sort((a, b) => size(b) - size(a));

  const res = NextResponse.json({ candidates, about, blocked, via, problem: hits.length ? '' : problem });
  if (hits.length) res.headers.set('cache-control', 'public, s-maxage=86400, stale-while-revalidate=604800');
  return res;
}

import { NextResponse } from 'next/server';
import { extractPage } from '@/lib/extract';
import { fetchGutenbergRaw, parseGutenbergText, searchGutenberg } from '@/lib/gutenberg';
import { searchOpenLibrary } from '@/lib/openlibrary';
import { findOnlineWithAI, searchWikisource, type WebHit } from '@/lib/webfind';
import { countWords, looksEnglish } from '@/lib/text';
import { verifyChapters } from '@/lib/verify';
import type { Candidate, ElsewhereEdition, ResolveResult } from '@/lib/types';

export const maxDuration = 60;

const langName = (code?: string) => {
  if (!code) return 'Unknown language';
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
};

function asUrl(input: string): string | null {
  if (/^https?:\/\/\S+$/i.test(input)) return input;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(input) && !/\s/.test(input)) return `https://${input}`;
  return null;
}

const GUTENBERG_URL = /gutenberg\.org\/(?:ebooks|cache\/epub|files)\/(\d+)/i;

async function gutenbergCandidate(id: string): Promise<Candidate> {
  const parsed = parseGutenbergText(await fetchGutenbergRaw(id));
  return {
    key: `gutenberg:${id}`,
    title: parsed.title || `Gutenberg #${id}`,
    author: parsed.author,
    language: parsed.language || 'English',
    sourceName: 'Project Gutenberg',
    url: `https://www.gutenberg.org/ebooks/${id}`,
    ref: { kind: 'gutenberg', id },
    pageInfo: {
      words: countWords(parsed.chapters.flatMap((c) => c.paragraphs).join(' ')),
      chapters: parsed.chapters.length,
      verification: verifyChapters(parsed.chapters.map((c) => c.title)).message,
    },
  };
}

const NOT_FULL_TEXT =
  /(^|\.)(wikipedia|wikiwand|goodreads|amazon|imdb|sparknotes|shmoop|cliffsnotes|litcharts|gradesaver|bookrags|enotes|coursehero|fandom|reddit|youtube|facebook|twitter|x|pinterest|quora|britannica|novelupdates|barnesandnoble|kobo|audible|scribd)\.[a-z.]+$/i;
const ABRIDGED =
  /\bv\.\s*\d|\bvol(?:ume)?\.?\s*\d|\btome\b|\bpart\s+\d+\s*(?:of|\/)|complete .*works|collection|illustrated|selections|abridged|for (?:young|children)|retold|adapted|simplified|summary|study guide|cliff|notes on/i;

async function webCandidate(hit: WebHit): Promise<Candidate> {
  if (NOT_FULL_TEXT.test(new URL(hit.url).hostname)) throw new Error('Not a full-text source');
  const page = await extractPage(hit.url);
  if (page.words < 80 && !page.chapterLinks?.length) throw new Error('No readable text');
  const english = looksEnglish(page.paragraphs.join(' '));
  const host = new URL(hit.url).hostname.replace(/^www\./, '');
  return {
    key: `url:${hit.url}`,
    title: hit.title || page.title,
    author: hit.author,
    language: english ? 'English' : langName(page.lang || hit.langHint),
    sourceName: host,
    url: hit.url,
    ref: { kind: 'url', url: hit.url },
    pageInfo: { words: page.words, chapterLinks: page.chapterLinks, next: page.next },
  };
}

export async function POST(req: Request) {
  let query = '';
  try {
    query = String((await req.json()).query ?? '').trim();
  } catch {
    /* fallthrough */
  }
  if (!query) return NextResponse.json({ error: 'Type a title or paste a link.' }, { status: 400 });

  const out: ResolveResult = { english: [], foreign: [], elsewhere: [], searched: [], warnings: [] };
  const place = (c: Candidate) => (c.language === 'English' ? out.english : out.foreign).push(c);

  try {
    const url = asUrl(query);
    if (url) {
      out.searched.push(new URL(url).hostname);
      const g = GUTENBERG_URL.exec(url);
      place(g ? await gutenbergCandidate(g[1]) : await webCandidate({ title: '', url }));
      return NextResponse.json(out);
    }
  } catch (e) {
    return NextResponse.json(
      { error: `Couldn't read that link: ${(e as Error).message}` },
      { status: 422 },
    );
  }

  // Title search across the free libraries, in parallel.
  out.searched.push('Project Gutenberg', 'Open Library', 'Wikisource');
  const [guEn, guAny, ol, ws] = await Promise.allSettled([
    searchGutenberg(query, 'en'),
    searchGutenberg(query),
    searchOpenLibrary(query),
    searchWikisource(query),
  ]);
  const warn = (name: string, r: PromiseSettledResult<unknown>) => {
    if (r.status === 'rejected') out.warnings.push(`${name} didn't respond`);
  };
  warn('Project Gutenberg', guEn);
  warn('Open Library', ol);

  const good = <T extends { score: number; title: string }>(r: PromiseSettledResult<T[]>) =>
    r.status === 'fulfilled'
      ? r.value
          .filter((h) => h.score >= 0.6)
          .map((h) => ({ h, rank: h.score - (ABRIDGED.test(h.title) ? 0.5 : 0) }))
          .sort((a, b) => b.rank - a.rank)
          .map((x) => x.h)
      : [];

  const seen = new Set<string>();
  for (const h of good(guEn).slice(0, 3)) {
    seen.add(h.id);
    out.english.push({
      key: `gutenberg:${h.id}`,
      title: h.title,
      author: h.author,
      language: 'English',
      sourceName: 'Project Gutenberg',
      url: `https://www.gutenberg.org/ebooks/${h.id}`,
      ref: { kind: 'gutenberg', id: h.id },
    });
  }
  for (const h of good(guAny)) {
    if (seen.has(h.id) || !h.language || h.language === 'English') continue;
    seen.add(h.id);
    out.foreign.push({
      key: `gutenberg:${h.id}`,
      title: h.title,
      author: h.author,
      language: h.language,
      sourceName: 'Project Gutenberg',
      url: `https://www.gutenberg.org/ebooks/${h.id}`,
      ref: { kind: 'gutenberg', id: h.id },
    });
    if (out.foreign.length >= 3) break;
  }

  let webHits: WebHit[] = ws.status === 'fulfilled' ? ws.value : [];
  if (!out.english.length && !out.foreign.length && !webHits.length) {
    out.searched.push('the wider web');
    try {
      webHits = await findOnlineWithAI(query);
    } catch (e) {
      out.warnings.push(`Web search unavailable (${(e as Error).message.slice(0, 80)})`);
    }
  }
  const verified = await Promise.allSettled(webHits.slice(0, 8).map(webCandidate));
  const web = verified.flatMap((v) => (v.status === 'fulfilled' ? [v.value] : []));
  // Prefer the source that looks most complete: a chapter list, or a long text.
  const size = (c: Candidate) => (c.pageInfo?.chapterLinks?.length ? c.pageInfo.chapterLinks.length * 1500 : c.pageInfo?.words || 0);
  web.sort((a, b) => size(b) - size(a));
  const substantial = web.filter((c) => size(c) >= 1500);
  for (const c of substantial.length ? substantial : web) place(c);

  if (!out.english.length && ol.status === 'fulfilled') {
    out.elsewhere = ol.value as ElsewhereEdition[];
  }
  // Read the best Gutenberg editions now so the page can show what is in them (size, chapters, gaps).
  const top = [out.english[0], out.foreign[0]].filter((c): c is Candidate => !!c && c.ref.kind === 'gutenberg');
  await Promise.allSettled(
    top.map(async (c) => {
      if (c.ref.kind === 'gutenberg') Object.assign(c, { pageInfo: (await gutenbergCandidate(c.ref.id)).pageInfo });
    }),
  );
  return NextResponse.json(out);
}

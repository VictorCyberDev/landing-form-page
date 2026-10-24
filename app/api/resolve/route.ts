import { NextResponse } from 'next/server';
import { extractPage } from '@/lib/extract';
import { fetchGutenbergRaw, parseGutenbergText, searchGutenberg } from '@/lib/gutenberg';
import { searchOpenLibrary, suggestWorks } from '@/lib/openlibrary';
import { hasSearchApi, searchArchive, searchWebApi } from '@/lib/search';
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

// Only applied to *search results* (never to a link you paste): pages that talk about a novel
// rather than contain it.
const NOT_FULL_TEXT =
  /(^|\.)(wikipedia|wikiwand|goodreads|amazon|imdb|sparknotes|shmoop|cliffsnotes|litcharts|gradesaver|bookrags|enotes|coursehero|reddit|youtube|facebook|twitter|pinterest|quora|britannica|barnesandnoble|kobo|audible|scribd)\.[a-z.]+$/i;
const ABRIDGED =
  /\bv\.\s*\d|\bvol(?:ume)?\.?\s*\d|\btome\b|\bpart\s+\d+\s*(?:of|\/)|complete .*works|collection|illustrated|selections|abridged|for (?:young|children)|retold|adapted|simplified|summary|study guide|cliff|notes on/i;

async function webCandidate(hit: WebHit, fromSearch = true): Promise<Candidate> {
  if (fromSearch && NOT_FULL_TEXT.test(new URL(hit.url).hostname)) throw new Error('Not a full-text source');
  const page = await extractPage(hit.url);
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

  const out: ResolveResult = { suggestions: [], english: [], foreign: [], elsewhere: [], searched: [], warnings: [] };
  const place = (c: Candidate) => (c.language === 'English' ? out.english : out.foreign).push(c);

  // A pasted link is read as-is: nothing is filtered or refused.
  const url = asUrl(query);
  if (url) {
    out.searched.push(new URL(url).hostname);
    try {
      const g = GUTENBERG_URL.exec(url);
      place(g ? await gutenbergCandidate(g[1]) : await webCandidate({ title: '', url }, false));
      return NextResponse.json(out);
    } catch (e) {
      return NextResponse.json({ error: `Couldn't read that link: ${(e as Error).message}` }, { status: 422 });
    }
  }

  // A name: look everywhere at once.
  out.searched.push('Project Gutenberg', 'Internet Archive', 'Open Library', 'Wikisource');
  const apiSearch = hasSearchApi();
  if (apiSearch) out.searched.push('the web');
  const [guEn, guAny, ol, ws, arch, sug, web1, web2] = await Promise.allSettled([
    searchGutenberg(query, 'en'),
    searchGutenberg(query),
    searchOpenLibrary(query),
    searchWikisource(query),
    searchArchive(query),
    suggestWorks(query),
    apiSearch ? searchWebApi(`"${query}" novel read online`) : Promise.resolve([] as WebHit[]),
    apiSearch ? searchWebApi(`${query} full text chapters`) : Promise.resolve([] as WebHit[]),
  ]);
  const warn = (name: string, r: PromiseSettledResult<unknown>) => {
    if (r.status === 'rejected') out.warnings.push(`${name} didn't respond`);
  };
  warn('Project Gutenberg', guEn);
  warn('Open Library', ol);
  warn('Internet Archive', arch);
  warn('Web search', web1);
  if (sug.status === 'fulfilled') out.suggestions = sug.value;

  const good = <T extends { score: number; title: string }>(r: PromiseSettledResult<T[]>) =>
    r.status === 'fulfilled'
      ? r.value
          .filter((h) => h.score >= 0.5)
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
  for (const h of good(arch).slice(0, 4)) {
    const isEn = !h.language || /^(en|eng|english)$/i.test(h.language);
    place({
      key: `archive:${h.id}`,
      title: h.title,
      author: h.author,
      language: isEn ? 'English' : langName(h.language!.slice(0, 2).toLowerCase()),
      sourceName: 'Internet Archive',
      url: `https://archive.org/details/${h.id}`,
      ref: { kind: 'archive', id: h.id },
      note: 'Scanned text from the Internet Archive',
    });
  }

  let webHits: WebHit[] = [
    ...(ws.status === 'fulfilled' ? ws.value : []),
    ...(web1.status === 'fulfilled' ? web1.value : []),
    ...(web2.status === 'fulfilled' ? web2.value : []),
  ];
  if (!out.english.length && !out.foreign.length && !webHits.length) {
    try {
      const found = await findOnlineWithAI(query);
      if (found.length) out.searched.push('an AI web search');
      webHits = found;
    } catch {
      /* the AI search is a bonus; it needs credit */
    }
  }
  const uniq = [...new Map(webHits.map((h) => [h.url, h])).values()];
  const verified = await Promise.allSettled(uniq.slice(0, 12).map((h) => webCandidate(h)));
  const web = verified.flatMap((v) => (v.status === 'fulfilled' ? [v.value] : []));
  // Most complete first: a chapter list beats a long page beats a stub. Nothing is hidden.
  const size = (c: Candidate) => (c.pageInfo?.chapterLinks?.length ? c.pageInfo.chapterLinks.length * 1500 : c.pageInfo?.words || 0);
  web.sort((a, b) => size(b) - size(a));
  for (const c of web) place(c);

  if (!out.english.length && ol.status === 'fulfilled') out.elsewhere = ol.value as ElsewhereEdition[];

  // Read the best Gutenberg editions now so the page can show what is in them (size, chapters, gaps).
  const top = [out.english[0], out.foreign[0]].filter((c): c is Candidate => !!c && c.ref.kind === 'gutenberg');
  await Promise.allSettled(
    top.map(async (c) => {
      if (c.ref.kind === 'gutenberg') Object.assign(c, { pageInfo: (await gutenbergCandidate(c.ref.id)).pageInfo });
    }),
  );
  return NextResponse.json(out);
}

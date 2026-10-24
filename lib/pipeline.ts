import { chunkParagraphs, countWords, looksEnglish } from './text';
import type { Book, Candidate, Chapter, PageResult, Report } from './types';
import { verifyChapters } from './verify';

export type Progress = (fraction: number, message: string) => void;

export class UserFacingError extends Error {
  constructor(
    message: string,
    public code?: 'missing-key' | 'access-code' | 'aborted',
  ) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((data as { error?: string }).error || `HTTP ${res.status}`), { status: res.status });
  return data as T;
}

async function pool<T>(items: T[], size: number, fn: (item: T, i: number) => Promise<void>, signal?: AbortSignal) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      if (signal?.aborted) throw new UserFacingError('Cancelled', 'aborted');
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "Chapter 4 - My Novel - SomeSite" -> "Chapter 4"; "Work/Volume 1/Chapter 2" -> "Chapter 2" */
function tidyTitle(pageTitle: string, linkTitle?: string): string {
  if (linkTitle) return linkTitle;
  const last = pageTitle.includes('/') ? pageTitle.split('/').pop()!.trim() : pageTitle;
  const segs = last.split(/\s[|\-–—_·]\s/).map((s) => s.trim()).filter(Boolean);
  return segs.find((s) => /chapter|第|제|章|話|话/i.test(s)) || segs[0] || last;
}

function dropDuplicateTitle(paragraphs: string[], title: string): string[] {
  const first = paragraphs[0]?.trim();
  if (first && first.length <= title.length + 12 && (title.includes(first) || first.includes(title))) {
    return paragraphs.slice(1);
  }
  return paragraphs;
}

async function fetchPage(url: string, signal?: AbortSignal): Promise<PageResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await json<PageResult>(
        await fetch('/api/page', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url }),
          signal,
        }),
      );
    } catch (e) {
      if (signal?.aborted) throw new UserFacingError('Cancelled', 'aborted');
      lastErr = e;
      await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr;
}

export const MIN_WORDS = 300;

export class TooSmall extends UserFacingError {}

const wordsOf = (chapters: Chapter[]) => countWords(chapters.flatMap((c) => c.paragraphs).join(' '));

/** Download the full text of the chosen source. `limit` caps how many top-level chapters to read (default: all). */
export async function loadBook(
  c: Candidate,
  limit: number,
  onProgress: Progress,
  signal?: AbortSignal,
  lastResort = false,
): Promise<Book> {
  if (c.ref.kind === 'gutenberg' || c.ref.kind === 'archive') {
    onProgress(0.05, `Downloading the full text from ${c.sourceName}`);
    const q =
      c.ref.kind === 'archive'
        ? `/api/book?src=archive&id=${encodeURIComponent(c.ref.id)}&title=${encodeURIComponent(c.title)}&author=${encodeURIComponent(c.author || '')}`
        : `/api/book?id=${c.ref.id}`;
    const book = await json<Book>(await fetch(q, { signal }));
    if (!lastResort && wordsOf(book.chapters) < MIN_WORDS) {
      throw new TooSmall('That edition is only a few pages long.');
    }
    return withReport(book);
  }

  const chapters: Chapter[] = [];
  const startUrl = (c.ref as { url: string }).url;
  let rootLinks = c.pageInfo?.chapterLinks;
  let total = rootLinks?.length || 1;
  let done = 0;
  const tick = (what: string) => onProgress(0.02 + 0.13 * Math.min(1, done / Math.max(1, total)), what);
  const fail = (title: string, src?: string): Chapter => ({
    title,
    src,
    failed: true,
    paragraphs: ['[This chapter could not be retrieved from the source.]'],
  });

  // Read one page. If it turns out to be an index of sub-pages, read those too (up to 3 levels deep).
  const readNode = async (link: { title: string; url: string }, depth: number, prefix: string): Promise<Chapter[]> => {
    let p: PageResult;
    try {
      p = await fetchPage(link.url, signal);
    } catch (e) {
      if ((e as UserFacingError).code === 'aborted') throw e;
      return [fail(link.title)];
    }
    if (p.chapterLinks?.length && p.words < 1200 && depth < 3) {
      const kids = p.chapterLinks;
      const label = tidyTitle(p.title, depth === 0 ? undefined : link.title);
      const parts: Chapter[][] = [];
      total += kids.length - 1;
      await pool(kids, 3, async (k, i) => {
        parts[i] = await readNode(k, depth + 1, depth === 0 ? prefix : label);
      }, signal);
      done++;
      return parts.flat();
    }
    const t = tidyTitle(p.title, link.title);
    done++;
    tick(`Reading — ${done} of about ${total} parts`);
    const title = prefix && !t.toLowerCase().includes(prefix.toLowerCase()) ? `${prefix} — ${t}` : t;
    return [{ title, paragraphs: dropDuplicateTitle(p.paragraphs, t) }];
  };

  if (rootLinks?.length) {
    const take = rootLinks.slice(0, limit);
    total = take.length;
    const slots: Chapter[][] = new Array(take.length);
    await pool(take, 4, async (l, i) => {
      slots[i] = await readNode(l, 1, '');
    }, signal);
    chapters.push(...slots.flat());
  } else {
    // A single page, possibly followed by "next chapter" links.
    let url: string | undefined = startUrl;
    const seen = new Set<string>();
    while (url && chapters.length < limit && !seen.has(url)) {
      seen.add(url);
      onProgress(0.02 + 0.13 * Math.min(1, chapters.length / Math.max(1, limit)), `Reading page ${chapters.length + 1}`);
      let p: PageResult;
      try {
        p = await fetchPage(url, signal);
      } catch (e) {
        if (!chapters.length) throw e;
        break;
      }
      if (!chapters.length && p.chapterLinks?.length) {
        rootLinks = p.chapterLinks;
        total = rootLinks.length;
        const slots: Chapter[][] = new Array(rootLinks.length);
        await pool(rootLinks.slice(0, limit), 4, async (l, i) => {
          slots[i] = await readNode(l, 1, '');
        }, signal);
        chapters.push(...slots.flat());
        break;
      }
      const t = tidyTitle(p.title);
      chapters.push({ title: t, paragraphs: dropDuplicateTitle(p.paragraphs, t) });
      url = p.next;
    }
  }
  // Every chapter must be there: retry any that failed, with growing pauses.
  for (const wait of [4000, 12000, 30000]) {
    const bad = chapters.filter((ch) => ch.failed && ch.src);
    if (!bad.length) break;
    onProgress(0.15, `Retrying ${bad.length} chapter${bad.length === 1 ? '' : 's'} that didn't load…`);
    await sleep(wait);
    for (const ch of bad) {
      try {
        const p = await fetchPage(ch.src!, signal);
        if (p.paragraphs.length) {
          ch.paragraphs = dropDuplicateTitle(p.paragraphs, ch.title);
          ch.failed = false;
        }
      } catch (e) {
        if ((e as UserFacingError).code === 'aborted') throw e;
      }
    }
  }
  const good = chapters.filter((ch) => ch.paragraphs.length);
  if (!good.length) throw new UserFacingError("Couldn't find any readable text at that address.");
  if (wordsOf(good) < MIN_WORDS && !lastResort) {
    throw new TooSmall(`Only ${fmtWords(wordsOf(good))} words were found at ${c.sourceName} — that isn't the full text.`);
  }
  return withReport({
    title: c.title,
    author: c.author,
    language: c.language,
    sourceName: c.sourceName,
    sourceUrl: c.url,
    chapters: good,
  });
}

/** Check the book against the source's own chapter numbering and note anything missing. */
function withReport(book: Book): Book {
  const v = verifyChapters(book.chapters.map((c) => c.title));
  const failed = book.chapters.filter((c) => c.failed).map((c) => c.title);
  const report: Report = {
    chapters: book.chapters.length,
    words: wordsOf(book.chapters),
    verification: v.message,
    verified: v.ok && !failed.length,
    failed,
  };
  return { ...book, report };
}

const fmtWords = (n: number) => n.toLocaleString('en-US');

export function bookIsEnglish(book: Book): boolean {
  const sample = book.chapters
    .slice(0, 4)
    .flatMap((c) => c.paragraphs)
    .join(' ');
  return looksEnglish(sample);
}

type TranslateOpts = { accessCode?: string; signal?: AbortSignal };

class ValidationFailed extends Error {}

async function callTranslate(payload: object, { accessCode, signal }: TranslateOpts, onWait?: (msg: string) => void) {
  let lastErr: Error = new Error('translation failed');
  let failures = 0;
  // Rate limits are not failures: wait and resume (up to ~40 minutes in total) instead of giving up.
  for (let waits = 0; waits < 100; ) {
    if (signal?.aborted) throw new UserFacingError('Cancelled', 'aborted');
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(accessCode ? { 'x-access-code': accessCode } : {}) },
        body: JSON.stringify(payload),
        signal,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data as { paragraphs?: string[]; titles?: string[] };
      if (data.error === 'missing-key') {
        throw new UserFacingError(
          'Translation isn’t configured yet. Add OPENROUTER_API_KEY or GROQ_API_KEY in the Vercel project settings under Environment Variables, then redeploy.',
          'missing-key',
        );
      }
      if (data.error === 'access-code-required') {
        throw new UserFacingError('This site is locked. Enter the access code.', 'access-code');
      }
      if (res.status === 422 && data.error === 'validation') throw new ValidationFailed(data.detail);
      if (res.status === 429 || res.status === 504 || res.status === 503) {
        waits++;
        onWait?.('The free AI is at its speed limit — waiting a moment, then continuing automatically…');
        await sleep(15000 + Math.random() * 10000);
        continue;
      }
      if (res.status === 402) {
        throw new UserFacingError(
          'The AI credits are used up: OpenRouter’s balance is $0 and the free limits are reached. Add a few dollars of OpenRouter credit (cheap Chinese models cost cents per novel) or try again later — what has been translated so far is not kept.',
          'missing-key',
        );
      }
      if (data.error === 'upstream' && [401, 403].includes(res.status)) {
        throw new UserFacingError(
          `The AI service refused the request (${String(data.detail || res.status).slice(0, 160)}). Check the API key.`,
          'missing-key',
        );
      }
      lastErr = new Error(data.detail || data.error || `HTTP ${res.status}`);
      if (res.status === 400 || res.status === 413) break;
    } catch (e) {
      if (e instanceof UserFacingError || e instanceof ValidationFailed) throw e;
      if (signal?.aborted) throw new UserFacingError('Cancelled', 'aborted');
      lastErr = e as Error;
    }
    if (++failures >= 5) break;
    await sleep(1500 * 2 ** failures);
  }
  throw lastErr;
}

/** Translate paragraphs; if the checks reject a chunk, split it and try the halves. */
async function translateParagraphs(
  paragraphs: string[],
  ctx: Record<string, string | undefined>,
  opts: TranslateOpts,
  depth = 0,
  onWait?: (msg: string) => void,
): Promise<string[]> {
  try {
    const r = await callTranslate({ mode: 'text', paragraphs, relaxed: paragraphs.length === 1 && depth > 0, ...ctx }, opts, onWait);
    if (!r.paragraphs || r.paragraphs.length !== paragraphs.length) throw new ValidationFailed('count mismatch');
    return r.paragraphs;
  } catch (e) {
    if (!(e instanceof ValidationFailed)) throw e;
    if (paragraphs.length > 1) {
      const mid = Math.ceil(paragraphs.length / 2);
      const left = await translateParagraphs(paragraphs.slice(0, mid), ctx, opts, depth + 1, onWait);
      const right = await translateParagraphs(paragraphs.slice(mid), ctx, opts, depth + 1, onWait);
      return [...left, ...right];
    }
    if (depth < 6) {
      // One stubborn paragraph: split it at sentence boundaries and rejoin.
      const sentences = paragraphs[0].split(/(?<=[.!?。！？…”」』"])\s*/).filter(Boolean);
      if (sentences.length > 1) {
        const mid = Math.ceil(sentences.length / 2);
        const a = await translateParagraphs([sentences.slice(0, mid).join(' ')], ctx, opts, depth + 1, onWait);
        const b = await translateParagraphs([sentences.slice(mid).join(' ')], ctx, opts, depth + 1, onWait);
        return [`${a[0]} ${b[0]}`];
      }
    }
    const r = await callTranslate({ mode: 'text', paragraphs, relaxed: true, ...ctx }, opts, onWait).catch(() => null);
    if (r?.paragraphs?.length === 1) return r.paragraphs;
    throw new UserFacingError('The translation could not be verified for one passage. Please try again.');
  }
}

export async function translateBook(
  book: Book,
  opts: TranslateOpts,
  onProgress: Progress,
  from = 0.15,
  to = 0.85,
): Promise<Book> {
  const { signal } = opts;
  onProgress(from, 'Translating the title and chapter headings');
  const titlesIn = [book.title, book.author || '', ...book.chapters.map((c) => c.title)];
  let titlesOut = titlesIn;
  try {
    const r = await callTranslate({ mode: 'titles', titles: titlesIn }, opts, (m) => onProgress(from, m));
    if (r.titles && r.titles.length === titlesIn.length) titlesOut = r.titles;
  } catch (e) {
    if (e instanceof UserFacingError) throw e; // key / access problems are fatal
  }

  type Job = { ci: number; idx: number; total: number; paragraphs: string[] };
  const jobs: Job[] = [];
  const results: string[][][] = book.chapters.map(() => []);
  let totalWords = 0;
  book.chapters.forEach((ch, ci) => {
    if (ch.failed || looksEnglish(ch.paragraphs.join(' '))) {
      results[ci] = [ch.paragraphs];
      return;
    }
    const chunks = chunkParagraphs(ch.paragraphs, 900);
    results[ci] = new Array(chunks.length);
    chunks.forEach((paragraphs, idx) => {
      jobs.push({ ci, idx, total: chunks.length, paragraphs });
      totalWords += countWords(paragraphs.join(' '));
    });
  });

  let doneWords = 0;
  await pool(
    jobs,
    6,
    async (job) => {
      const ch = book.chapters[job.ci];
      results[job.ci][job.idx] = await translateParagraphs(
        job.paragraphs,
        {
          bookTitle: titlesOut[0],
          author: titlesOut[1],
          chapterTitle: titlesOut[2 + job.ci] || ch.title,
          part: job.total > 1 ? `${job.idx + 1} of ${job.total}` : undefined,
        },
        opts,
        0,
        (m) => onProgress(from + (to - from) * (doneWords / Math.max(1, totalWords)), m),
      );
      doneWords += countWords(job.paragraphs.join(' '));
      const f = from + (to - from) * (doneWords / Math.max(1, totalWords));
      onProgress(f, `Translating — ${Math.round((doneWords / Math.max(1, totalWords)) * 100)}% of the text`);
    },
    signal,
  );

  const translatedParas = results.reduce((a, r) => a + r.flat().length, 0);
  const sourceParas = book.chapters.reduce((a, c) => a + c.paragraphs.length, 0);
  return {
    ...book,
    report: book.report && {
      ...book.report,
      translation:
        translatedParas === sourceParas
          ? `all ${sourceParas.toLocaleString('en-US')} paragraphs translated and checked against the original`
          : `translated ${translatedParas} of ${sourceParas} paragraphs`,
    },
    title: titlesOut[0] || book.title,
    author: titlesOut[1] || book.author,
    translated: true,
    chapters: book.chapters.map((ch, ci) => ({
      title: titlesOut[2 + ci] || ch.title,
      paragraphs: results[ci].flat(),
    })),
  };
}

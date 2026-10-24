import { chunkParagraphs, countWords, looksEnglish } from './text';
import type { Book, Candidate, Chapter, PageResult } from './types';

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

/** "Chapter 4 - My Novel - SomeSite" -> "Chapter 4" */
function tidyTitle(pageTitle: string, linkTitle?: string): string {
  if (linkTitle) return linkTitle;
  const segs = pageTitle.split(/\s[|\-–—_·]\s/).map((s) => s.trim()).filter(Boolean);
  return segs.find((s) => /chapter|第|제|章|話|话/i.test(s)) || segs[0] || pageTitle;
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

/** Download the text of the chosen source. `limit` caps how many web chapters to read. */
export async function loadBook(
  c: Candidate,
  limit: number,
  onProgress: Progress,
  signal?: AbortSignal,
): Promise<Book> {
  if (c.ref.kind === 'gutenberg') {
    onProgress(0.05, 'Downloading the text from Project Gutenberg');
    const book = await json<Book>(await fetch(`/api/book?id=${c.ref.id}`, { signal }));
    return book;
  }

  const links = c.pageInfo?.chapterLinks;
  const chapters: Chapter[] = [];
  let lang: string | undefined = c.language === 'English' ? 'English' : c.language;

  if (links?.length) {
    const take = links.slice(0, limit);
    const slots: (Chapter | null)[] = new Array(take.length).fill(null);
    let done = 0;
    await pool(
      take,
      4,
      async (l, i) => {
        try {
          const p = await fetchPage(l.url, signal);
          const t = tidyTitle(p.title, l.title);
          slots[i] = { title: t, paragraphs: dropDuplicateTitle(p.paragraphs, t) };
        } catch (e) {
          if ((e as UserFacingError).code === 'aborted') throw e;
          slots[i] = { title: l.title, paragraphs: ['[This chapter could not be retrieved from the source.]'] };
        }
        done++;
        onProgress(0.02 + 0.13 * (done / take.length), `Reading chapter ${done} of ${take.length}`);
      },
      signal,
    );
    chapters.push(...(slots as Chapter[]));
  } else {
    let url: string | undefined = c.ref.url;
    const seen = new Set<string>();
    while (url && chapters.length < limit && !seen.has(url)) {
      seen.add(url);
      onProgress(0.02 + 0.13 * (chapters.length / limit), `Reading page ${chapters.length + 1}`);
      let p: PageResult;
      try {
        p = await fetchPage(url, signal);
      } catch (e) {
        if (!chapters.length) throw e;
        break;
      }
      const t = tidyTitle(p.title);
      chapters.push({ title: t, paragraphs: dropDuplicateTitle(p.paragraphs, t) });
      url = p.next;
    }
  }
  if (!chapters.some((ch) => ch.paragraphs.length)) {
    throw new UserFacingError("Couldn't find any readable text at that address.");
  }
  return {
    title: c.title,
    author: c.author,
    language: lang,
    sourceName: c.sourceName,
    sourceUrl: c.url,
    chapters,
  };
}

export function bookIsEnglish(book: Book): boolean {
  const sample = book.chapters
    .slice(0, 4)
    .flatMap((c) => c.paragraphs)
    .join(' ');
  return looksEnglish(sample);
}

type TranslateOpts = { accessCode?: string; signal?: AbortSignal };

async function callTranslate(payload: object, { accessCode, signal }: TranslateOpts) {
  let lastErr: Error = new Error('translation failed');
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal?.aborted) throw new UserFacingError('Cancelled', 'aborted');
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(accessCode ? { 'x-access-code': accessCode } : {}) },
        body: JSON.stringify(payload),
        signal,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data as { text?: string; titles?: string[]; truncated?: boolean };
      if (data.error === 'missing-key') {
        throw new UserFacingError(
          'Translation isn’t configured yet. Add ANTHROPIC_API_KEY in the Vercel project settings (Environment Variables) and redeploy.',
          'missing-key',
        );
      }
      if (data.error === 'access-code-required') {
        throw new UserFacingError('This site is locked. Enter the access code.', 'access-code');
      }
      if (data.error === 'upstream' && [401, 402, 403].includes(res.status)) {
        throw new UserFacingError(
          `The AI translation service refused the request (${String(data.detail || res.status).slice(0, 140)}). ` +
            'Check billing/credits for AI Gateway on the Vercel team, or set ANTHROPIC_API_KEY in the project settings.',
          'missing-key',
        );
      }
      lastErr = new Error(data.detail || data.error || `HTTP ${res.status}`);
      if (res.status === 400 || res.status === 413) break;
    } catch (e) {
      if (e instanceof UserFacingError) throw e;
      if (signal?.aborted) throw new UserFacingError('Cancelled', 'aborted');
      lastErr = e as Error;
    }
    await sleep(1500 * 2 ** attempt);
  }
  throw lastErr;
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
    const r = await callTranslate({ mode: 'titles', titles: titlesIn }, opts);
    if (r.titles && r.titles.length === titlesIn.length) titlesOut = r.titles;
  } catch (e) {
    if (e instanceof UserFacingError) throw e; // key / access problems are fatal
  }

  type Job = { ci: number; idx: number; total: number; paragraphs: string[] };
  const jobs: Job[] = [];
  const results: string[][][] = book.chapters.map(() => []);
  let totalWords = 0;
  book.chapters.forEach((ch, ci) => {
    if (looksEnglish(ch.paragraphs.join(' '))) {
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
    4,
    async (job) => {
      const ch = book.chapters[job.ci];
      const r = await callTranslate(
        {
          mode: 'text',
          text: job.paragraphs.join('\n\n'),
          bookTitle: titlesOut[0],
          author: titlesOut[1],
          chapterTitle: titlesOut[2 + job.ci] || ch.title,
          part: job.total > 1 ? `${job.idx + 1} of ${job.total}` : undefined,
        },
        opts,
      );
      results[job.ci][job.idx] = (r.text || '')
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean);
      doneWords += countWords(job.paragraphs.join(' '));
      const f = from + (to - from) * (doneWords / Math.max(1, totalWords));
      onProgress(f, `Translating — ${Math.round((doneWords / Math.max(1, totalWords)) * 100)}% of the text`);
    },
    signal,
  );

  return {
    ...book,
    title: titlesOut[0] || book.title,
    author: titlesOut[1] || book.author,
    translated: true,
    chapters: book.chapters.map((ch, ci) => ({
      title: titlesOut[2 + ci] || ch.title,
      paragraphs: results[ci].flat(),
    })),
  };
}

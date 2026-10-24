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

class ValidationFailed extends Error {}

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
      if (res.ok) return data as { paragraphs?: string[]; titles?: string[] };
      if (data.error === 'missing-key') {
        throw new UserFacingError(
          'Translation isn’t configured yet. Add OPENROUTER_API_KEY (or GEMINI_API_KEY / GROQ_API_KEY) in the Vercel project settings under Environment Variables, then redeploy.',
          'missing-key',
        );
      }
      if (data.error === 'access-code-required') {
        throw new UserFacingError('This site is locked. Enter the access code.', 'access-code');
      }
      if (res.status === 422 && data.error === 'validation') throw new ValidationFailed(data.detail);
      if (data.error === 'upstream' && [401, 402, 403].includes(res.status)) {
        throw new UserFacingError(
          `The AI service refused the request (${String(data.detail || res.status).slice(0, 160)}). Check the API key and its billing/quota.`,
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
    await sleep(1500 * 2 ** attempt);
  }
  throw lastErr;
}

/** Translate paragraphs; if the checks reject a chunk, split it and try the halves. */
async function translateParagraphs(
  paragraphs: string[],
  ctx: Record<string, string | undefined>,
  opts: TranslateOpts,
  depth = 0,
): Promise<string[]> {
  try {
    const r = await callTranslate({ mode: 'text', paragraphs, relaxed: paragraphs.length === 1 && depth > 0, ...ctx }, opts);
    if (!r.paragraphs || r.paragraphs.length !== paragraphs.length) throw new ValidationFailed('count mismatch');
    return r.paragraphs;
  } catch (e) {
    if (!(e instanceof ValidationFailed)) throw e;
    if (paragraphs.length > 1) {
      const mid = Math.ceil(paragraphs.length / 2);
      const left = await translateParagraphs(paragraphs.slice(0, mid), ctx, opts, depth + 1);
      const right = await translateParagraphs(paragraphs.slice(mid), ctx, opts, depth + 1);
      return [...left, ...right];
    }
    if (depth < 6) {
      // One stubborn paragraph: split it at sentence boundaries and rejoin.
      const sentences = paragraphs[0].split(/(?<=[.!?。！？…”」』"])\s*/).filter(Boolean);
      if (sentences.length > 1) {
        const mid = Math.ceil(sentences.length / 2);
        const a = await translateParagraphs([sentences.slice(0, mid).join(' ')], ctx, opts, depth + 1);
        const b = await translateParagraphs([sentences.slice(mid).join(' ')], ctx, opts, depth + 1);
        return [`${a[0]} ${b[0]}`];
      }
    }
    const r = await callTranslate({ mode: 'text', paragraphs, relaxed: true, ...ctx }, opts).catch(() => null);
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
    const chunks = chunkParagraphs(ch.paragraphs, 650);
    results[ci] = new Array(chunks.length);
    chunks.forEach((paragraphs, idx) => {
      jobs.push({ ci, idx, total: chunks.length, paragraphs });
      totalWords += countWords(paragraphs.join(' '));
    });
  });

  let doneWords = 0;
  await pool(
    jobs,
    3,
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
      );
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

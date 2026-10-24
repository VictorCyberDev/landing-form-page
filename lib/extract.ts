import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { safeFetch, readText } from './safe-fetch';
import { countWords } from './text';
import type { PageResult } from './types';

const CHAPTER_RE =
  /(\bchapter\b|\bchap\.?\s*\d|\bch\.?\s*\d|\bepisode\b|\bep\.?\s*\d|\bprologue\b|\bepilogue\b|第\s*[\d〇零一二三四五六七八九十百千两]+\s*[章回节節話话卷篇]|제\s*\d+\s*[화장]|\d+\s*[화話话章])/i;
const NEXT_RE =
  /^\s*(next\b|next chapter|›|»|→|>|下一章|下一页|下一頁|下一节|下一節|次へ|次の話|次話|다음|siguiente|suivant|weiter|следующ)/i;

function clean(s: string): string {
  return s
    .replace(/[ 　]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstInt(s: string): number | null {
  const m = /\d+/.exec(s);
  return m ? Number(m[0]) : null;
}

function sameSite(a: URL, b: URL) {
  return a.hostname.replace(/^www\./, '') === b.hostname.replace(/^www\./, '');
}

function collectChapterLinks(document: Document, base: string) {
  const baseUrl = new URL(base);
  const seen = new Set<string>([baseUrl.href.split('#')[0]]);
  const out: { title: string; url: string }[] = [];
  for (const a of Array.from(document.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) continue;
    let u: URL;
    try {
      u = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (!sameSite(u, baseUrl)) continue;
    const key = u.href.split('#')[0];
    if (seen.has(key)) continue;
    const text = clean(a.textContent || '');
    if (!text || text.length > 140) continue;
    if (!CHAPTER_RE.test(text) && !/chapter/i.test(u.pathname)) continue;
    seen.add(key);
    out.push({ title: text, url: key });
  }
  // Many web-novel sites list the newest chapter first.
  const nums = out.map((l) => firstInt(l.title));
  const a = nums[0];
  const b = nums[nums.length - 1];
  if (a != null && b != null && a > b) out.reverse();
  return out;
}

const NAV_TEXT = /^(home|login|log in|sign in|register|contact|about|menu|search|next|previous|prev|back|top|index|contents|toc|table of contents|rss|help|privacy|terms|more)$/i;

function shapeKey(u: URL): string {
  return (u.pathname + u.search).replace(/\d+/g, '#').replace(/%[0-9a-f]{2}/gi, '%');
}

/** Largest run of same-site links that share a URL shape, e.g. /book/12/#.html — a typical chapter list. */
function collectPatternLinks(document: Document, base: string) {
  const baseUrl = new URL(base);
  const groups = new Map<string, { title: string; url: string }[]>();
  const seen = new Set<string>([baseUrl.href.split('#')[0]]);
  for (const a of Array.from(document.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) continue;
    let u: URL;
    try {
      u = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (!sameSite(u, baseUrl)) continue;
    const key = u.href.split('#')[0];
    const text = clean(a.textContent || '');
    if (!text || text.length > 120 || NAV_TEXT.test(text) || seen.has(key)) continue;
    seen.add(key);
    const shape = shapeKey(u);
    if (!/#/.test(shape)) continue;
    const g = groups.get(shape) || [];
    g.push({ title: text, url: key });
    groups.set(shape, g);
  }
  let best: { title: string; url: string }[] = [];
  for (const g of groups.values()) if (g.length > best.length) best = g;
  return best;
}

/** Sub-pages of the current page (Wikisource-style hierarchies: Work/Volume/Chapter). */
function collectChildLinks(document: Document, base: string) {
  const baseUrl = new URL(base);
  const prefix = baseUrl.pathname.replace(/\/$/, '') + '/';
  const seen = new Set<string>([baseUrl.href.split('#')[0]]);
  const out: { title: string; url: string }[] = [];
  for (const a of Array.from(document.querySelectorAll('a[href]'))) {
    let u: URL;
    try {
      u = new URL(a.getAttribute('href') || '', baseUrl);
    } catch {
      continue;
    }
    if (!sameSite(u, baseUrl) || !u.pathname.startsWith(prefix) || /[?&](action|oldid|redlink)=/.test(u.search)) continue;
    const key = u.href.split('#')[0];
    const text = clean(a.textContent || '');
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push({ title: text, url: key });
  }
  return out;
}

function findNext(document: Document, base: string): string | undefined {
  const baseUrl = new URL(base);
  const cands = Array.from(document.querySelectorAll('link[rel~="next"], a[rel~="next"], a[href]'));
  for (const el of cands) {
    const isRel = el.getAttribute('rel')?.includes('next');
    const text = clean(el.textContent || '');
    if (!isRel && !NEXT_RE.test(text)) continue;
    try {
      const u = new URL(el.getAttribute('href') || '', baseUrl);
      if (sameSite(u, baseUrl) && u.href.split('#')[0] !== baseUrl.href.split('#')[0]) {
        return u.href.split('#')[0];
      }
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

function toParagraphs(lines: string[]): string[] {
  return lines
    .map(clean)
    .filter((p) => p.length > 1)
    .filter((p) => !(p.length < 40 && NEXT_RE.test(p)));
}

export async function extractPage(url: string): Promise<PageResult> {
  const res = await safeFetch(url);
  if (!res.ok) throw new Error(`The site answered with status ${res.status}.`);
  const ctype = res.headers.get('content-type') || '';
  const body = await readText(res);

  if (/text\/plain/i.test(ctype)) {
    const paragraphs = toParagraphs(body.split(/\n\s*\n/));
    return {
      title: decodeURIComponent(new URL(url).pathname.split('/').pop() || 'Untitled'),
      url,
      paragraphs,
      words: countWords(paragraphs.join(' ')),
    };
  }
  if (!/html|xml/i.test(ctype) && ctype) {
    throw new Error(`Unsupported content type (${ctype.split(';')[0]}).`);
  }

  const linkDoc = parseHTML(body).document as unknown as Document;
  const byText = collectChapterLinks(linkDoc, url);
  const byShape = collectPatternLinks(linkDoc, url);
  const byChild = collectChildLinks(linkDoc, url);
  const next = findNext(linkDoc, url);

  const doc = parseHTML(body).document as unknown as Document;
  const article = new Readability(doc, { charThreshold: 120 }).parse();
  let paragraphs: string[] = [];
  let title = clean(article?.title || linkDoc.title || 'Untitled');

  if (article?.content) {
    const frag = parseHTML(`<div id="r">${article.content.replace(/<br\s*\/?>/gi, '\n')}</div>`)
      .document as unknown as Document;
    paragraphs = toParagraphs(
      Array.from(frag.querySelectorAll('p')).map((p) => p.textContent || ''),
    );
    const viaText = toParagraphs((article.textContent || '').split(/\n+/));
    // Some sites don't use <p>; fall back to line-based text when it holds more.
    if (countWords(viaText.join(' ')) > countWords(paragraphs.join(' ')) * 1.4) {
      paragraphs = viaText;
    }
  }
  if (!paragraphs.length) {
    paragraphs = toParagraphs((linkDoc.body?.textContent || '').split(/\n+/));
  }
  const words = countWords(paragraphs.join(' '));
  const lang = linkDoc.documentElement?.getAttribute('lang')?.split(/[-_]/)[0]?.toLowerCase() || undefined;
  const result: PageResult = { title, url, paragraphs, words, next, lang };
  let best = byText;
  if (byShape.length > best.length) best = byShape;
  if (words < 1200 && byChild.length >= 2 && (byChild.length >= best.length || best.length < 6)) best = byChild;
  if ((best.length >= 6 && words < 2500) || (best === byChild && best.length >= 2 && words < 1200)) {
    result.chapterLinks = best;
  }
  return result;
}

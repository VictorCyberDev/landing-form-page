import { safeFetch, readText } from './safe-fetch';
import { countWords, matchScore } from './text';
import type { Chapter } from './types';

const xmlDecode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, '&');

export type GutenbergHit = { id: string; title: string; author?: string; language?: string; score: number };

/** Search Project Gutenberg's catalogue (OPDS feed). `lang` is an ISO code like "en". */
export async function searchGutenberg(query: string, lang?: string): Promise<GutenbergHit[]> {
  const q = (lang ? `l.${lang} ` : '') + query;
  const res = await safeFetch(
    `https://www.gutenberg.org/ebooks/search.opds/?query=${encodeURIComponent(q)}`,
    { timeoutMs: 15000 },
  );
  if (!res.ok) throw new Error(`Gutenberg search answered ${res.status}`);
  const xml = await readText(res);
  const hits: GutenbergHit[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const id = /<id>https?:\/\/www\.gutenberg\.org\/ebooks\/(\d+)\.opds<\/id>/.exec(e)?.[1];
    if (!id) continue;
    let title = xmlDecode(/<title>([\s\S]*?)<\/title>/.exec(e)?.[1] || '').trim();
    const author = xmlDecode(/<content[^>]*>([\s\S]*?)<\/content>/.exec(e)?.[1] || '').trim();
    const langMatch = /\s\(([A-Z][a-z]+(?: [A-Z][a-z]+)*)\)$/.exec(title);
    const language = langMatch ? langMatch[1] : lang === 'en' ? 'English' : undefined;
    if (langMatch) title = title.slice(0, langMatch.index).trim();
    const score = matchScore(query, `${title} ${author}`);
    hits.push({ id, title, author: author || undefined, language, score });
  }
  return hits;
}

export async function fetchGutenbergRaw(id: string): Promise<string> {
  if (!/^\d+$/.test(id)) throw new Error('Bad Gutenberg id');
  const urls = [
    `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`,
    `https://www.gutenberg.org/ebooks/${id}.txt.utf-8`,
    `https://www.gutenberg.org/files/${id}/${id}-0.txt`,
  ];
  let lastErr = 'not found';
  for (const u of urls) {
    try {
      const res = await safeFetch(u, { timeoutMs: 40000 });
      if (res.ok) return await readText(res);
      lastErr = `status ${res.status}`;
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  throw new Error(`Could not download Gutenberg book ${id} (${lastErr}).`);
}

const SMALL = new Set(['of', 'the', 'and', 'a', 'an', 'in', 'on', 'to', 'for', 'at', 'by', 'or']);
function titleCase(s: string): string {
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (!letters || letters !== letters.toUpperCase()) return s;
  return s
    .toLowerCase()
    .split(/(\s+)/)
    .map((w, i) => {
      if (/^[ivxlcdm]+[.,:]?$/i.test(w)) return w.toUpperCase();
      if (i > 0 && SMALL.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join('');
}

function tidyHeading(raw: string): string {
  const t = raw
    .replace(/\[\d+\]/g, '')
    .replace(/[\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.:]$/, '');
  return titleCase(
    t.replace(/^(CHAPTER|BOOK|PART|VOLUME|LETTER|STAVE|CANTO|ACT|SECTION)\b/, (m) => m[0] + m.slice(1).toLowerCase()),
  );
}

const STRUCT =
  'chapter|chapitre|capitulo|capítulo|capitolo|kapitel|livre|libro|buch|book|part|partie|volume|letter|lettre|stave|canto|act|acte|section';
const ORDINAL =
  'first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|last|one|two|three|four|five|six|seven|eight|nine|ten|premier|première|deuxième|troisième|quatrième|cinquième|sixième|septième|huitième|neuvième|dixième|onzième|douzième|primero|segundo|tercero|primo|secondo|terzo|erstes|zweites|drittes';
// A structural heading needs a number ("Chapter 4", "Book Ninth") so that ordinary one-line paragraphs
// beginning with "Part…" or "Book…" are never mistaken for headings and removed from the text.
const HEAD_WORD = new RegExp(
  `^((?:${STRUCT})\\s+(?:[IVXLCDM]+\\b|\\d+|(?:${ORDINAL})\\b)|(?:preface|préface|introduction|prologue|epilogue|épilogue|foreword|afterword|appendix|dedication|conclusion|letter\\b)(?:\\b|$))`,
  'i',
);

const HEAD_LABEL =
  /^(chapter|chapitre|capitulo|capítulo|capitolo|kapitel|livre|book|part|partie|letter|lettre|stave|canto|act|acte)\s+[IVXLCDM\d]+(?:\[\d+\])?(?![A-Za-z])/i;
const LABEL_ONLY =
  /^(chapter|chapitre|capitulo|capítulo|capitolo|kapitel|livre|book|part|partie|letter|lettre|stave|canto|act|acte)\s+[IVXLCDM\d]+(?:\[\d+\])?[.:]?$/i;
const ROMAN = /^[IVXLCDM]{1,8}\.?(\s+\S[^\n]{0,70})?$/;
const NUM = /^\d{1,3}\.?(\s+\S[^\n]{0,70})?$/;

const CANONICAL_ROMAN = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;
/** "IV.", "XII. The Storm" — but not "M. Madeleine" or "MM. Gillenormand" (abbreviations, not numerals). */
function isRomanHeading(t: string): boolean {
  const m = /^([IVXLCDM]{1,8})\.?(\s+\S.{0,70})?$/.exec(t);
  if (!m || !CANONICAL_ROMAN.test(m[1])) return false;
  const value = [...m[1]].reduce((acc, ch, i, arr) => {
    const v: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    return acc + (v[ch] < (v[arr[i + 1]] || 0) ? -v[ch] : v[ch]);
  }, 0);
  if (value > 200) return false;
  return !(m[1].length === 1 && m[2]);
}

function isUpper(l: string): boolean {
  const letters = l.replace(/[^A-Za-z]/g, '');
  return letters.length >= 3 && letters === letters.toUpperCase();
}

function toParagraph(block: string): string | null {
  const lines = block
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const joined = lines.join(' ');
  if (/^\[(Illustration|Footnote|Transcriber|Note|Decoration)/i.test(joined)) return null;
  if (/^\{\d+\}$/.test(joined)) return null;
  const verse =
    lines.length >= 3 && lines.every((l) => l.length < 62) && lines.join('').length / lines.length < 44;
  if (verse) return lines.join('\n');
  return joined.replace(/\s+/g, ' ');
}

export function parseGutenbergText(raw: string): {
  title?: string;
  author?: string;
  language?: string;
  chapters: Chapter[];
} {
  const text = raw.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  const meta = (k: string) => new RegExp(`^${k}:[ \\t]*(.+)$`, 'mi').exec(text)?.[1]?.trim();
  const title = meta('Title');
  const author = meta('Author');
  const language = meta('Language');

  const start = /\*\*\* ?START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i.exec(text);
  const end = /\*\*\* ?END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK/i.exec(text);
  const body = text.slice(start ? start.index + start[0].length : 0, end ? end.index : undefined);
  const lines = body.split('\n').map((l) => l.replace(/\s+$/, ''));

  type Head = { line: number; title: string; bodyStart: number };
  const heads: Head[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.length > 80) continue;
    if (i > 0 && lines[i - 1].trim() !== '') continue;
    const next = lines[i + 1]?.trim() ?? '';
    const after = lines[i + 2]?.trim() ?? '';
    const looksHead = HEAD_WORD.test(t) || isRomanHeading(t) || NUM.test(t);
    if (!looksHead) continue;
    if (/^contents?\b/i.test(t)) continue;
    if (next === '') {
      heads.push({ line: i, title: t, bodyStart: i + 1 });
    } else if (HEAD_WORD.test(t) && isUpper(t) && isUpper(next)) {
      // A long all-caps heading wrapped over several lines.
      const parts = [t];
      let k = i + 1;
      while (k < lines.length && lines[k].trim() && isUpper(lines[k].trim()) && parts.length < 5 && lines[k].trim().length < 80) {
        parts.push(lines[k].trim());
        k++;
      }
      if ((lines[k]?.trim() ?? '') === '') heads.push({ line: i, title: parts.join(' '), bodyStart: k });
    } else if (HEAD_LABEL.test(t)) {
      // "CHAPTER I." with its title on the next one to three lines.
      const parts = [t.replace(/[.:]$/, '')];
      let k = i + 1;
      while (k < lines.length && lines[k].trim() && lines[k].trim().length < 80 && parts.length < 4) {
        parts.push(lines[k].trim());
        k++;
      }
      if ((lines[k]?.trim() ?? '') === '' && parts.length > 1) {
        const joiner = LABEL_ONLY.test(t) ? ': ' : ' ';
        heads.push({ line: i, title: `${parts[0]}${joiner}${parts.slice(1).join(' ')}`, bodyStart: k });
      }
    }
  }

  const sections: Chapter[] = [];
  for (let h = 0; h < heads.length; h++) {
    const from = heads[h].bodyStart;
    const to = h + 1 < heads.length ? heads[h + 1].line : lines.length;
    const paragraphs = lines
      .slice(from, to)
      .join('\n')
      .split(/\n\s*\n/)
      .map(toParagraph)
      .filter((p): p is string => !!p);
    // A table-of-contents entry has no body, or only a one-line title-like body, before the next heading.
    // Short real chapters (a few sentences) must be kept — dropping them would silently lose text.
    if (!paragraphs.length) continue;
    const bodyLines = lines.slice(from, to).filter((l) => l.trim());
    const titleLike = bodyLines.length <= 2 && bodyLines.every((l) => l.trim().length < 55);
    if (titleLike && countWords(paragraphs.join(' ')) < 12 && h + 1 < heads.length && to - from <= 6) continue;
    sections.push({
      title: tidyHeading(heads[h].title),
      paragraphs,
    });
  }

  if (sections.length >= 2) return { title, author, language, chapters: sections };

  // No usable chapter structure: slice into parts of roughly equal size.
  const paragraphs = body
    .split(/\n\s*\n/)
    .map(toParagraph)
    .filter((p): p is string => !!p);
  const total = countWords(paragraphs.join(' '));
  if (total < 7000) {
    return { title, author, language, chapters: [{ title: title || 'Text', paragraphs }] };
  }
  const chapters: Chapter[] = [];
  let cur: string[] = [];
  let w = 0;
  for (const p of paragraphs) {
    cur.push(p);
    w += countWords(p);
    if (w >= 4500) {
      chapters.push({ title: `Part ${chapters.length + 1}`, paragraphs: cur });
      cur = [];
      w = 0;
    }
  }
  if (cur.length) chapters.push({ title: `Part ${chapters.length + 1}`, paragraphs: cur });
  return { title, author, language, chapters };
}

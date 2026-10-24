const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/g;
const NON_LATIN_LETTERS = /[Ѐ-ӿ֐-ۿऀ-ॿ฀-๿぀-ヿ㐀-䶿一-鿿가-힯]/g;

/** Word count that also copes with scripts written without spaces. */
export function countWords(s: string): number {
  const cjk = (s.match(CJK) || []).length;
  const latin = s.replace(CJK, ' ').split(/\s+/).filter(Boolean).length;
  return Math.round(latin + cjk * 0.6);
}

const EN_WORDS = new Set(
  'the and of to a in that was he she it his her with as for had you not but is at on be by this which they were have from said what all there when an one would their we him been has who will no if so up out them then do could into more other than now very only my me our your i or are'.split(
    ' ',
  ),
);

/** Cheap heuristic: is this (sample of a) text already English? */
export function looksEnglish(text: string): boolean {
  const sample = text.slice(0, 8000);
  const letters = sample.replace(/[^\p{L}]/gu, '');
  if (letters.length < 40) return false;
  const nonLatin = (letters.match(NON_LATIN_LETTERS) || []).length;
  if (nonLatin / letters.length > 0.15) return false;
  const tokens = sample.toLowerCase().match(/[a-z']+/g) || [];
  if (tokens.length < 20) return false;
  let hits = 0;
  for (const t of tokens) if (EN_WORDS.has(t)) hits++;
  return hits / tokens.length > 0.28;
}

/** Group paragraphs into chunks of at most ~maxWords words. */
export function chunkParagraphs(paragraphs: string[], maxWords: number): string[][] {
  const pieces: string[] = [];
  for (const p of paragraphs) {
    if (countWords(p) <= maxWords) {
      pieces.push(p);
      continue;
    }
    // Over-long paragraph: break on sentence boundaries.
    const sentences = p.split(/(?<=[.!?。！？…”」』"])\s*/).filter(Boolean);
    let cur = '';
    for (const s of sentences) {
      if (cur && countWords(cur + ' ' + s) > maxWords) {
        pieces.push(cur);
        cur = s;
      } else {
        cur = cur ? cur + ' ' + s : s;
      }
    }
    if (cur) pieces.push(cur);
  }
  const chunks: string[][] = [];
  let cur: string[] = [];
  let w = 0;
  for (const p of pieces) {
    const pw = countWords(p);
    if (cur.length && w + pw > maxWords) {
      chunks.push(cur);
      cur = [];
      w = 0;
    }
    cur.push(p);
    w += pw;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export function normalizeTokens(s: string): string[] {
  const stop = new Set(['the', 'a', 'an', 'of', 'and', 'by', 'novel', 'book', 'in', 'on', 'to']);
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t && !stop.has(t));
}

/** Fraction of query tokens found in the haystack (0..1). */
export function matchScore(query: string, haystack: string): number {
  const q = normalizeTokens(query);
  if (!q.length) return 0;
  const h = new Set(normalizeTokens(haystack));
  let hit = 0;
  for (const t of q) if (h.has(t)) hit++;
  return hit / q.length;
}

/** How closely a result must match what was typed: every word for short names, two thirds of the words for long ones. */
export function matchThreshold(query: string): number {
  const n = normalizeTokens(query).length;
  return n <= 2 ? 0.99 : 0.66;
}

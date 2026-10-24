/** Completeness checks: are all the chapters of the source present, in order, with none missing? */

const CN: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function chineseNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0;
  let cur = 0;
  let seen = false;
  for (const ch of s) {
    if (ch in CN) {
      cur = CN[ch];
      seen = true;
    } else if (ch === '十') {
      total += (cur || 1) * 10;
      cur = 0;
      seen = true;
    } else if (ch === '百') {
      total += (cur || 1) * 100;
      cur = 0;
      seen = true;
    } else if (ch === '千') {
      total += (cur || 1) * 1000;
      cur = 0;
      seen = true;
    } else return null;
  }
  return seen ? total + cur : null;
}

function romanNumber(s: string): number | null {
  if (!/^[ivxlcdm]+$/i.test(s)) return null;
  const v: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  let t = 0;
  const r = s.toLowerCase();
  for (let i = 0; i < r.length; i++) {
    const a = v[r[i]];
    const b = v[r[i + 1]] || 0;
    t += a < b ? -a : a;
  }
  return t;
}

/** "Chapter XII: The Storm" -> 12, "第十二回 ..." -> 12, "Letter 3" -> 3 */
export function chapterNumber(title: string): number | null {
  const t = title.trim();
  let m = /(?:chapter|chapitre|capítulo|capitulo|capitolo|kapitel|chap\.?|ch\.?|letter|lettre|stave|canto|episode)\s+([ivxlcdm]+|\d+)\b/i.exec(t);
  if (m) return romanNumber(m[1]) ?? (/^\d+$/.test(m[1]) ? Number(m[1]) : null);
  if (/^(chapitre|chapter|capítulo|capitulo|capitolo)\s+(premier|première|primero|primo|first)\b/i.test(t)) return 1;
  m = /第\s*([\d〇零一二三四五六七八九十百千两]+)\s*[章回节節話话]/.exec(t);
  if (m) return chineseNumber(m[1]);
  m = /제\s*(\d+)\s*[화장]/.exec(t);
  if (m) return Number(m[1]);
  m = /^(\d{1,4})[.:]\s+\p{Lu}/u.exec(t);
  if (m && t.length < 70) return Number(m[1]);
  return null;
}

export type Verification = {
  chapters: number;
  /** Highest chapter number seen in the numbering (the number of chapters the source itself declares). */
  declared: number | null;
  missing: number[];
  message: string;
  ok: boolean;
};

export function verifyChapters(titles: string[]): Verification {
  const nums = titles.map(chapterNumber);
  const numbered = nums.filter((n): n is number => n != null);
  if (numbered.length < Math.max(2, titles.length * 0.6)) {
    return {
      chapters: titles.length,
      declared: null,
      missing: [],
      ok: true,
      message: `${titles.length} section${titles.length === 1 ? '' : 's'} (the source does not number its chapters)`,
    };
  }
  // Split into runs wherever numbering restarts (Volume 2 starts at chapter 1 again).
  const runs: number[][] = [];
  for (const n of numbered) {
    const run = runs[runs.length - 1];
    if (!run || n <= run[run.length - 1]) runs.push([n]);
    else run.push(n);
  }
  const missing: number[] = [];
  for (const run of runs) {
    const have = new Set(run);
    const lo = runs.length === 1 ? 1 : run[0] === 1 ? 1 : run[0];
    for (let i = lo; i <= run[run.length - 1]; i++) if (!have.has(i)) missing.push(i);
  }
  const declared = runs.reduce((a, r) => a + r[r.length - 1], 0);
  const ok = missing.length === 0;
  const range = runs.length === 1 ? `chapters 1–${runs[0][runs[0].length - 1]}` : `${runs.length} volumes, ${numbered.length} numbered chapters`;
  return {
    chapters: titles.length,
    declared,
    missing,
    ok,
    message: ok
      ? `${titles.length} chapters, ${range} — none missing`
      : `${titles.length} chapters found; missing ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? '…' : ''}`,
  };
}

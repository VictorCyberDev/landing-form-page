import { NextResponse } from 'next/server';
import { complete, getProviders, LLMError } from '@/lib/llm';
import { checkAccess, rateLimited } from '@/lib/auth';
import { countWords } from '@/lib/text';

export const maxDuration = 60;

const SYSTEM = `You are a professional literary translator producing a faithful, complete English edition of a novel.

ABSOLUTE RULES
1. Translate EVERY sentence of EVERY paragraph. Never summarise, shorten, merge, skip, censor, soften or add anything. No notes, no commentary, no explanations, and NO bracketed glosses or parenthetical clarifications that are not in the original (do not explain names, puns, allusions or terms).
2. Be as close to word-for-word as natural English allows: keep the author's meaning, sentence order, imagery, tone, names, numbers and punctuation. Prefer literal fidelity first, then fluency.
3. The passage is split into numbered paragraphs marked [[1]], [[2]], ... Output the SAME markers in the SAME order, each followed by the English translation of that paragraph only. Never drop, repeat, merge or renumber a marker.
4. Dialogue stays dialogue, with standard English quotation marks. Emphasis may use *single asterisks*; use no other markdown.
5. Names: Hanyu Pinyin (no tone marks) for Chinese, Hepburn for Japanese, Revised Romanization for Korean; keep established English forms for famous names; spell every name identically throughout.
6. A paragraph that is a scene break (ornaments, rules) becomes: * * *
7. If a paragraph is already English, copy it unchanged.
8. Output ONLY the markers and translations, nothing else.`;

const NON_LATIN = /[Ѐ-ӿ֐-ۿऀ-ॿ฀-๿぀-ヿ㐀-䶿一-鿿가-힯]/g;

function parseMarked(text: string, n: number): string[] | null {
  const parts = text.split(/\[\[(\d+)\]\]/);
  // parts: [pre, "1", body, "2", body, ...]
  const out: string[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    if (Number(parts[i]) !== out.length + 1) return null;
    out.push(parts[i + 1].trim());
  }
  return out.length === n ? out : null;
}

function validate(input: string[], output: string[], relaxed: boolean): string | null {
  if (output.some((o) => !o)) return 'a paragraph came back empty';
  if (output.some((o) => o.includes('[['))) return 'marker text leaked into a paragraph';
  const joined = output.join(' ');
  const letters = joined.replace(/[^\p{L}]/gu, '');
  if (letters.length > 40 && (joined.match(NON_LATIN) || []).length / letters.length > 0.08) {
    return 'part of the text was left untranslated';
  }
  if (relaxed) return null;
  const inW = countWords(input.join(' '));
  const outW = countWords(joined);
  if (inW > 40 && (outW / inW < 0.55 || outW / inW > 2.4)) return `length mismatch (${inW} -> ${outW} words)`;
  for (let i = 0; i < input.length; i++) {
    const a = countWords(input[i]);
    if (a >= 30 && countWords(output[i]) / a < 0.45) return `paragraph ${i + 1} looks shortened`;
  }
  return null;
}

type Body = {
  mode?: 'text' | 'titles';
  paragraphs?: string[];
  titles?: string[];
  bookTitle?: string;
  author?: string;
  chapterTitle?: string;
  part?: string;
  relaxed?: boolean;
};

export async function POST(req: Request) {
  const denied = checkAccess(req);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });
  if (rateLimited(req, 240)) return NextResponse.json({ error: 'rate-limited' }, { status: 429 });
  const providers = await getProviders();
  if (!providers.length) return NextResponse.json({ error: 'missing-key' }, { status: 503 });

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad-request' }, { status: 400 });
  }

  try {
    if (body.mode === 'titles') {
      const titles = (body.titles || []).slice(0, 700).map((t) => String(t).slice(0, 300));
      const { text } = await complete(providers, {
        system:
          'You translate book metadata into English. Input is a JSON array of strings (book title, author name, then chapter titles). ' +
          'Return ONLY a JSON array of the same length, each string in English: translate titles faithfully and gracefully, ' +
          'romanize personal names (Hanyu Pinyin for Chinese, Hepburn for Japanese). Keep numbering such as "Chapter 3". ' +
          'Strings already in English stay unchanged. No code fences, no commentary.',
        user: JSON.stringify(titles),
        maxTokens: Math.min(8000, 300 + titles.length * 80),
      });
      const s = text.indexOf('[');
      const e = text.lastIndexOf(']');
      const arr = s >= 0 && e > s ? (JSON.parse(text.slice(s, e + 1)) as unknown[]) : [];
      return NextResponse.json({ titles: arr.map(String) });
    }

    const paragraphs = (body.paragraphs || []).map((p) => String(p));
    if (!paragraphs.length) return NextResponse.json({ paragraphs: [] });
    const words = countWords(paragraphs.join(' '));
    if (words > 2500 || paragraphs.join('').length > 30_000) {
      return NextResponse.json({ error: 'chunk-too-large' }, { status: 413 });
    }
    const header = [
      body.bookTitle && `Book: ${String(body.bookTitle).slice(0, 200)}`,
      body.author && `Author: ${String(body.author).slice(0, 200)}`,
      body.chapterTitle && `Chapter: ${String(body.chapterTitle).slice(0, 200)}`,
      body.part && `Passage ${String(body.part).slice(0, 20)}`,
    ]
      .filter(Boolean)
      .join('\n');
    const marked = paragraphs.map((p, i) => `[[${i + 1}]]\n${p}`).join('\n\n');
    const maxTokens = Math.min(8000, 800 + words * 3);

    let problem = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const user =
        `${header}\n\n` +
        (problem
          ? `YOUR PREVIOUS ANSWER WAS REJECTED: ${problem}. Translate every paragraph completely and keep every [[n]] marker.\n\n`
          : '') +
        `--- PASSAGE (${paragraphs.length} paragraphs) ---\n${marked}\n--- END ---`;
      const { text, via } = await complete(providers, { system: SYSTEM, user, maxTokens });
      const out = parseMarked(text.trim(), paragraphs.length);
      if (!out) {
        problem = `the ${paragraphs.length} numbered markers were not all returned in order`;
        continue;
      }
      const bad = validate(paragraphs, out, !!body.relaxed);
      if (bad) {
        problem = bad;
        continue;
      }
      return NextResponse.json({ paragraphs: out, via });
    }
    return NextResponse.json({ error: 'validation', detail: problem }, { status: 422 });
  } catch (e) {
    const status = e instanceof LLMError ? e.status : 502;
    return NextResponse.json(
      { error: 'upstream', detail: (e as Error).message.slice(0, 240) },
      { status: status >= 400 && status < 600 ? status : 502 },
    );
  }
}

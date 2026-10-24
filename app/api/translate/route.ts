import { NextResponse } from 'next/server';
import { getLLM } from '@/lib/llm';
import { checkAccess, rateLimited } from '@/lib/auth';
import { countWords } from '@/lib/text';

export const maxDuration = 60;

const SYSTEM = `You are an award-winning literary translator preparing a published English edition of a novel for a reader.

Rules:
- Translate the passage completely and faithfully into natural, elegant, idiomatic English that reads like a well-edited book. Never summarise, skip, censor, or add commentary, notes or translator's remarks.
- Match the author's register and period: formal where the original is formal, colloquial where it is colloquial. Keep the rhythm of the prose.
- Keep paragraph breaks: one blank line between paragraphs. Keep dialogue as dialogue, using standard English quotation marks.
- A pause or scene change shown by ornaments, rules or blank space becomes a line containing only: * * *
- Mark emphasis or thoughts with *single asterisks* sparingly. Do not use any other markdown.
- Render personal and place names consistently through the whole book: Hanyu Pinyin without tone marks for Chinese, Hepburn for Japanese, Revised Romanization for Korean, standard English forms for well-known names. Keep honorifics only when they carry meaning.
- If a passage is already English, return it unchanged.
- Output ONLY the translated text, nothing before or after it.`;

export async function POST(req: Request) {
  const denied = checkAccess(req);
  if (denied) return NextResponse.json({ error: denied }, { status: 401 });
  if (rateLimited(req)) return NextResponse.json({ error: 'rate-limited' }, { status: 429 });
  const llm = await getLLM();
  if (!llm) return NextResponse.json({ error: 'missing-key' }, { status: 503 });
  const { client, model } = llm;

  let body: {
    mode?: 'text' | 'titles';
    text?: string;
    titles?: string[];
    bookTitle?: string;
    author?: string;
    chapterTitle?: string;
    part?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad-request' }, { status: 400 });
  }

  try {
    if (body.mode === 'titles') {
      const titles = (body.titles || []).slice(0, 600).map((t) => String(t).slice(0, 300));
      const msg = await client.messages.create({
        model,
        max_tokens: Math.min(8000, 200 + titles.length * 60),
        system:
          'You translate book metadata into English. Input is a JSON array of strings (book title, author name, then chapter titles). ' +
          'Return ONLY a JSON array of the same length with each string rendered in English: translate titles gracefully, ' +
          'romanize personal names (Hanyu Pinyin for Chinese, Hepburn for Japanese). Keep numbering words like "Chapter 3". ' +
          'Strings already in English stay unchanged.',
        messages: [{ role: 'user', content: JSON.stringify(titles) }],
      });
      const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      const s = text.indexOf('[');
      const e = text.lastIndexOf(']');
      const arr = s >= 0 && e > s ? (JSON.parse(text.slice(s, e + 1)) as unknown[]) : [];
      return NextResponse.json({ titles: arr.map(String) });
    }

    const text = String(body.text || '');
    if (!text.trim()) return NextResponse.json({ text: '' });
    if (countWords(text) > 3500 || text.length > 40_000) {
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
    const msg = await client.messages.create({
      model,
      max_tokens: 8000,
      system: SYSTEM,
      messages: [{ role: 'user', content: `${header}\n\n--- BEGIN PASSAGE ---\n${text}\n--- END PASSAGE ---` }],
    });
    const out = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
    if (!out) return NextResponse.json({ error: 'empty-translation' }, { status: 502 });
    return NextResponse.json({ text: out, truncated: msg.stop_reason === 'max_tokens' });
  } catch (e) {
    const status = (e as { status?: number }).status;
    return NextResponse.json(
      { error: 'upstream', detail: (e as Error).message.slice(0, 200) },
      { status: status && status >= 400 && status < 600 ? status : 502 },
    );
  }
}

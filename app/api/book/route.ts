import { NextResponse } from 'next/server';
import { fetchGutenbergRaw, parseGutenbergText } from '@/lib/gutenberg';
import type { Book } from '@/lib/types';

export const maxDuration = 60;

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('id') || '';
  try {
    const parsed = parseGutenbergText(await fetchGutenbergRaw(id));
    const book: Book = {
      title: parsed.title || `Gutenberg #${id}`,
      author: parsed.author,
      language: parsed.language,
      sourceName: 'Project Gutenberg',
      sourceUrl: `https://www.gutenberg.org/ebooks/${id}`,
      chapters: parsed.chapters,
    };
    return NextResponse.json(book);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

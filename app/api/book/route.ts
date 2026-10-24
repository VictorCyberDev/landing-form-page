import { NextResponse } from 'next/server';
import { fetchGutenbergRaw, parseGutenbergText } from '@/lib/gutenberg';
import { fetchArchiveText } from '@/lib/search';
import type { Book } from '@/lib/types';

export const maxDuration = 60;

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const id = params.get('id') || '';
  try {
    if (params.get('src') === 'archive') {
      const parsed = parseGutenbergText(await fetchArchiveText(id));
      const book: Book = {
        title: params.get('title') || parsed.title || id,
        author: params.get('author') || undefined,
        sourceName: 'Internet Archive',
        sourceUrl: `https://archive.org/details/${id}`,
        chapters: parsed.chapters,
      };
      return NextResponse.json(book);
    }
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

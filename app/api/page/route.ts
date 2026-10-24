import { NextResponse } from 'next/server';
import { extractPage } from '@/lib/extract';

export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const { url } = await req.json();
    return NextResponse.json(await extractPage(String(url)));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

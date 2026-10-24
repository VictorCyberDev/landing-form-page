import { bookmarkletSource } from '@/lib/bookmarklet';

/** The full bookmark script, loaded by the short one-line version (easy to paste on a phone). */
export async function GET(req: Request) {
  return new Response(bookmarkletSource(new URL(req.url).origin), {
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}

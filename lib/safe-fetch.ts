import dns from 'node:dns/promises';
import net from 'node:net';

export const UA =
  'Mozilla/5.0 (compatible; NovelToPDF/1.0; personal offline-reading tool)';

const MAX_BYTES = 12 * 1024 * 1024;

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;
  if (v6.startsWith('::ffff:')) return isPrivateV4(v6.slice(7));
  return /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

async function assertPublicHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('That address is not a public website.');
  }
  const addrs = net.isIP(host)
    ? [host]
    : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (!addrs.length || addrs.some(isPrivateIp)) {
    throw new Error('That address is not a public website.');
  }
}

/** fetch() restricted to public http(s) hosts, with a size cap and timeout. */
export async function safeFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  let current = new URL(url);
  for (let hop = 0; hop < 6; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new Error('Only http(s) links are supported.');
    }
    await assertPublicHost(current.hostname);
    const res = await fetch(current, {
      ...init,
      redirect: 'manual',
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'accept-language': 'en,*;q=0.5',
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(init.timeoutMs ?? 25000),
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current);
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects.');
}

/** Read a body as text, honouring the charset (Shift_JIS, GBK, etc.). */
export async function readText(res: Response): Promise<string> {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error('That page is too large.');
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) throw new Error('That page is too large.');
  let charset = /charset=([\w-]+)/i.exec(res.headers.get('content-type') || '')?.[1];
  if (!charset) {
    const head = new TextDecoder('latin1').decode(buf.subarray(0, 4096));
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

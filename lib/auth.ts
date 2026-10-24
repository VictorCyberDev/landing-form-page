/**
 * Optional shared passcode. If ACCESS_CODE is set in the environment, the
 * translate endpoint (the only one that spends API credit) requires it.
 */
export function checkAccess(req: Request): string | null {
  const code = process.env.ACCESS_CODE;
  if (!code) return null;
  return req.headers.get('x-access-code') === code ? null : 'access-code-required';
}

const hits = new Map<string, number[]>();

/** Best-effort per-instance rate limit: `max` calls per `windowMs` per client. */
export function rateLimited(req: Request, max = 90, windowMs = 60_000): boolean {
  const ip = (req.headers.get('x-forwarded-for') || 'local').split(',')[0].trim();
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > max;
}

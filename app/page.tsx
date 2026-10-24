'use client';

import { useEffect, useRef, useState } from 'react';
import type { AboutLink, Book, Candidate, ResolveResult } from '@/lib/types';
import { bookIsEnglish, loadBook, translateBook, UserFacingError } from '@/lib/pipeline';
import type { Candidate as Cand, Report } from '@/lib/types';

type WebState = { loading: boolean; candidates: Candidate[]; about: AboutLink[]; blocked: AboutLink[]; problem: string };
type Phase = 'idle' | 'searching' | 'found' | 'working' | 'done' | 'error';

const fmt = (n: number) => n.toLocaleString('en-US');
const slug = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'book';

function estimate(words: number) {
  const minutes = Math.max(1, Math.round((words / 900 / 4) * 0.45));
  return minutes < 2 ? 'about a minute' : `about ${minutes} minutes`;
}

const defaultLimit = (c?: Cand | null) =>
  c?.pageInfo?.chapterLinks?.length ? Math.min(c.pageInfo.chapterLinks.length, 2000) : c?.pageInfo?.next ? 100 : 1;

function Cover({ src, alt }: { src?: string; alt: string }) {
  const [bad, setBad] = useState(false);
  return src && !bad ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="cover" src={src} alt={`Cover of ${alt}`} loading="lazy" onError={() => setBad(true)} />
  ) : (
    <div className="cover blank" aria-hidden>📖</div>
  );
}

function looksLikeText(s: string) {
  return s.length > 500 || (s.match(/\n/g) || []).length >= 3;
}

export default function Home() {
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [web, setWeb] = useState<WebState>({ loading: false, candidates: [], about: [], blocked: [], problem: '' });
  const [progress, setProgress] = useState({ f: 0, msg: '' });
  const [pdf, setPdf] = useState<{ url: string; name: string; mb: string; title: string; report?: Report } | null>(null);
  const [error, setError] = useState<{ msg: string; code?: string } | null>(null);
  const [code, setCode] = useState('');
  const abort = useRef<AbortController | null>(null);
  const webSeq = useRef(0);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      setCode(localStorage.getItem('access-code') || '');
    } catch {}
  }, []);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 220) + 'px';
  }, [input]);
  useEffect(() => () => { if (pdf) URL.revokeObjectURL(pdf.url); }, [pdf]);

  function reset() {
    abort.current?.abort();
    setPhase('idle');
    setResult(null);
    setSelected(null);
    setPdf(null);
    setError(null);
  }

  async function produce(getBook: (sig: AbortSignal, p: (f: number, m: string) => void) => Promise<Book>) {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setPhase('working');
    setError(null);
    setPdf(null);
    const p = (f: number, msg: string) => setProgress({ f, msg });
    try {
      p(0.02, 'Getting the text');
      let book = await getBook(ac.signal, p);
      if (!bookIsEnglish(book)) {
        book = await translateBook(book, { accessCode: code || undefined, signal: ac.signal }, p);
      }
      p(0.86, 'Typesetting your book');
      const { makePdf } = await import('@/lib/pdf');
      const blob = await makePdf(book, (f, m) => p(0.86 + 0.14 * f, m));
      const url = URL.createObjectURL(blob);
      const name = `${slug(book.title)}${book.author ? '-' + slug(book.author) : ''}.pdf`;
      setPdf({ url, name, mb: (blob.size / 1048576).toFixed(1), title: book.title, report: book.report });
      setPhase('done');
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      const err = e as UserFacingError;
      if (err.code === 'aborted' || ac.signal.aborted) return;
      setError({ msg: err.message || 'Something went wrong.', code: err.code });
      setPhase('error');
    }
  }

  async function submit(e?: React.FormEvent, override?: string) {
    e?.preventDefault();
    const q = (override ?? input).trim();
    if (!q || phase === 'searching' || phase === 'working') return;
    setResult(null);
    setSelected(null);
    setPdf(null);
    setError(null);
    setWeb({ loading: false, candidates: [], about: [], blocked: [], problem: '' });

    if (looksLikeText(q)) {
      const lines = q.split(/\n+/).map((l) => l.trim()).filter(Boolean);
      const hasTitle = lines[0].length <= 90 && lines.length > 3;
      const title = hasTitle ? lines[0] : 'Untitled';
      const paragraphs = hasTitle ? lines.slice(1) : lines;
      await produce(async () => ({
        title,
        sourceName: 'Pasted text',
        sourceUrl: 'Provided by the reader',
        chapters: [{ title, paragraphs }],
      }));
      return;
    }

    setPhase('searching');
    try {
      const res = await fetch('/api/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: q }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Search failed');
      const r = data as ResolveResult;
      setResult(r);
      setSelected(r.english[0] || r.foreign[0] || null);
      setLimits({});
      setPhase('found');
      // The whole-web search runs alongside and fills in as it finishes.
      setWeb({ loading: true, candidates: [], about: [], blocked: [], problem: '' });
      const id = ++webSeq.current;
      fetch(`/api/websearch?q=${encodeURIComponent(q)}`)
        .then((w) => w.json())
        .then((w) => {
          if (id === webSeq.current) setWeb({ loading: false, candidates: w.candidates || [], about: w.about || [], blocked: w.blocked || [], problem: w.problem || w.error || '' });
        })
        .catch(() => id === webSeq.current && setWeb({ loading: false, candidates: [], about: [], blocked: [], problem: 'the web search did not answer' }));
    } catch (err) {
      setError({ msg: (err as Error).message });
      setPhase('error');
    }
  }

  function start(c: Candidate, lim: number) {
    setSelected(c);
    // If a source turns out to be incomplete (an index, a summary, a stub), move on to the next candidate.
    const sameKind = (x: Candidate) => (x.language === 'English') === (c.language === 'English');
    const queue = [c, ...candidates.filter((x) => x.key !== c.key && sameKind(x))];
    void produce(async (sig, p) => {
      let last: unknown;
      for (const [i, cand] of queue.entries()) {
        try {
          return await loadBook(cand, i === 0 ? lim : defaultLimit(cand), p, sig, i === queue.length - 1);
        } catch (e) {
          if ((e as UserFacingError).code === 'aborted' || (e as UserFacingError).code === 'missing-key') throw e;
          last = e;
          if (i < queue.length - 1) p(0.02, `${(e as Error).message} Trying another source…`);
        }
      }
      throw last;
    });
  }

  function saveCode(v: string) {
    setCode(v);
    try {
      localStorage.setItem('access-code', v);
    } catch {}
  }

  const busy = phase === 'searching' || phase === 'working';
  const candidates: Candidate[] = (() => {
    const seen = new Set<string>();
    const all = [...(result?.english ?? []), ...(result?.foreign ?? []), ...web.candidates].filter((c) => {
      const k = c.url;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    // English copies first (one-click download), then the rest.
    return [...all.filter((c) => c.language === 'English'), ...all.filter((c) => c.language !== 'English')];
  })();
  const english0 = candidates.some((c) => c.language === 'English');

  function Source({ c }: { c: Candidate }) {
    return (
      <>
        {c.author ? `${c.author} · ` : ''}
        <a className="link" href={c.url} target="_blank" rel="noreferrer">
          {c.sourceName}
        </a>
        {c.pageInfo?.chapterLinks?.length
          ? ` · ${fmt(c.pageInfo.chapterLinks.length)} chapters`
          : c.pageInfo?.words
            ? ` · ${fmt(c.pageInfo.words)} words`
            : ''}
      </>
    );
  }

  return (
    <main className="shell">
      <div className="brand"><i /> Novel to PDF <i /></div>
      <h1>Any novel, in English,<br />ready to read offline.</h1>
      <p className="lede">
        Paste a link, a title, or the text itself. We find where it lives online, read it, and typeset it as a
        beautiful PDF — or hand you the English copy in one tap if one already exists.
      </p>

      <form className="search" onSubmit={submit}>
        <textarea
          ref={area}
          value={input}
          rows={1}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !looksLikeText(input)) submit();
          }}
          placeholder="Pride and Prejudice · https://… · or paste a whole chapter"
          aria-label="Novel title, link, or text"
          disabled={busy}
          spellCheck={false}
        />
        <div className="search-row">
          <span className="hint">Searches the whole web, plus Gutenberg, Internet Archive, Open Library and Wikisource.</span>
          <button className="btn" type="submit" disabled={busy || !input.trim()}>
            {phase === 'searching' ? <><span className="spin" /> Searching</> : looksLikeText(input) ? 'Make PDF' : 'Find it'}
          </button>
        </div>
      </form>

      {phase === 'searching' && (
        <section className="card" aria-live="polite">
          <div className="eyebrow"><span className="spin" /> Looking</div>
          <p className="msg">Checking where this is online and whether an English copy already exists…</p>
        </section>
      )}

      {phase === 'found' && result && (
        <>
          {result.suggestions.length > 0 && (
            <section className="card">
              <div className="eyebrow">Is this the novel?</div>
              {result.suggestions.map((sg, i) => (
                <div className={`pick${i === 0 ? ' best' : ''}`} key={`${sg.title}|${sg.author}`}>
                  <Cover src={sg.coverUrl} alt={sg.title} />
                  <div className="pick-body">
                    <h3>{sg.title}</h3>
                    <p className="meta">{[sg.author, sg.year].filter(Boolean).join(' · ') || ' '}</p>
                    {sg.blurb && i === 0 && <p className="blurb">{sg.blurb}</p>}
                    {i === 0 && sg.url && (
                      <a className="link" href={sg.url} target="_blank" rel="noreferrer">More about it ↗</a>
                    )}
                  </div>
                  {i > 0 && (
                    <button
                      className="btn ghost"
                      onClick={() => {
                        const q = `${sg.title} ${sg.author || ''}`.trim();
                        setInput(q);
                        void submit(undefined, q);
                      }}
                    >
                      Search this
                    </button>
                  )}
                </div>
              ))}
            </section>
          )}

          <section className="card">
            <div className="eyebrow">
              {candidates.length ? `Where it’s online (${candidates.length})` : 'Where it’s online'}
              {web.loading && <><span className="spin" /> still searching the whole web…</>}
            </div>
            {candidates.map((c, i) => {
              const links = c.pageInfo?.chapterLinks?.length;
              const english = c.language === 'English';
              const lim = limits[c.key] ?? defaultLimit(c);
              return (
                <div className={`pick src${i === 0 ? ' best' : ''}`} key={c.key}>
                  <Cover src={c.image} alt={c.title} />
                  <div className="pick-body">
                    <h3>{c.title}</h3>
                    <p className="meta">
                      <Source c={c} />
                      <span className="chip">{c.language}</span>
                    </p>
                    {c.pageInfo?.verification && <p className="meta verify-line">✓ {c.pageInfo.verification}</p>}
                    {c.blurb && <p className="blurb">{c.blurb}</p>}
                    {!english && c.pageInfo?.words ? (
                      <p className="note" style={{ margin: '4px 0 8px' }}>
                        Will be translated to English — {estimate(c.pageInfo.words)}.
                      </p>
                    ) : null}
                    {(links || c.pageInfo?.next) ? (
                      <div className="row" style={{ margin: '4px 0 8px' }}>
                        <label htmlFor={`lim-${i}`}>{links ? `Chapters (${links} found), take the first` : 'Follow “next chapter” for'}</label>
                        <input
                          id={`lim-${i}`}
                          type="number"
                          min={1}
                          max={links || 500}
                          value={lim}
                          onChange={(e) => setLimits({ ...limits, [c.key]: Math.max(1, Number(e.target.value) || 1) })}
                        />
                      </div>
                    ) : null}
                    <button className="btn" onClick={() => start(c, lim)} disabled={busy}>
                      {english ? 'Download PDF' : 'Translate to English & download PDF'}
                    </button>
                  </div>
                </div>
              );
            })}
            {!candidates.length && !web.loading && (
              <p className="meta">
                Nothing readable turned up yet for “{input.trim()}”. Paste a link to any page that has it (links are never
                filtered), or paste the text itself.
              </p>
            )}
            {web.problem && !candidates.length && <p className="warn">Web search: {web.problem}</p>}
          </section>

          {(web.about.length > 0 || web.blocked.length > 0) && (
            <section className="card">
              {web.blocked.length > 0 && (
                <>
                  <div className="eyebrow">Found online, but the site doesn’t let this app read it</div>
                  {web.blocked.map((b) => (
                    <div className="alt" key={b.url}>
                      <span>
                        <strong>{b.title}</strong>
                        <br />
                        <span className="meta">{b.description || new URL(b.url).hostname}</span>
                      </span>
                      <a className="btn ghost" href={b.url} target="_blank" rel="noreferrer">Open</a>
                    </div>
                  ))}
                  <p className="note">Open it, copy the chapters, and paste the text in the box above.</p>
                </>
              )}
              {web.about.length > 0 && (
                <>
                  <div className="eyebrow" style={{ marginTop: web.blocked.length ? 18 : 0 }}>More about it</div>
                  {web.about.map((b) => (
                    <div className="alt" key={b.url}>
                      <span>
                        <strong>{b.title}</strong>
                        <br />
                        <span className="meta">{b.description || new URL(b.url).hostname}</span>
                      </span>
                      <a className="btn ghost" href={b.url} target="_blank" rel="noreferrer">Open</a>
                    </div>
                  ))}
                </>
              )}
            </section>
          )}

          {!english0 && result.elsewhere.length > 0 && (
            <section className="card">
              <div className="eyebrow">An English edition exists, but not as a free download</div>
              {result.elsewhere.map((e) => (
                <div className="alt" key={e.url}>
                  <span>
                    <strong>{e.title}</strong>
                    <br />
                    <span className="meta">{[e.author, e.year, e.access].filter(Boolean).join(' · ')}</span>
                  </span>
                  <a className="btn ghost" href={e.url} target="_blank" rel="noreferrer">View</a>
                </div>
              ))}
            </section>
          )}

          {result.warnings.length > 0 && <p className="warn">{result.warnings.join(' · ')}.</p>}
        </>
      )}

      {phase === 'working' && (
        <section className="card" aria-live="polite">
          <div className="eyebrow"><span className="spin" /> Working on your book</div>
          <div className="bar" role="progressbar" aria-valuenow={Math.round(progress.f * 100)} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${Math.max(3, progress.f * 100)}%` }} />
          </div>
          <p className="msg">{progress.msg}</p>
          <p className="note">Keep this tab open — the PDF is built right here on your device.</p>
          <p style={{ marginTop: 14 }}>
            <button className="btn ghost" onClick={reset}>Cancel</button>
          </p>
        </section>
      )}

      {phase === 'done' && pdf && (
        <section className="card">
          <div className="eyebrow ok">✓ Your book is ready</div>
          <h2>{pdf.title}</h2>
          <p className="meta">{pdf.mb} MB · PDF · works offline</p>
          {pdf.report && (
            <ul className="verify">
              <li className={pdf.report.verified ? 'ok' : 'bad'}>
                {pdf.report.verified ? '✓' : '⚠'} {pdf.report.verification}
              </li>
              <li className="ok">✓ {fmt(pdf.report.words)} words, carried over from the source as written</li>
              {pdf.report.translation && <li className="ok">✓ {pdf.report.translation}</li>}
              {pdf.report.failed.length > 0 && (
                <li className="bad">
                  ⚠ {pdf.report.failed.length} chapter(s) could not be retrieved from the source and are marked in the PDF:{' '}
                  {pdf.report.failed.slice(0, 6).join(', ')}
                </li>
              )}
            </ul>
          )}
          <a className="btn big" href={pdf.url} download={pdf.name}>Download PDF</a>
          <p className="note">If the download didn’t start by itself, use the button above.</p>
          <p style={{ marginTop: 14 }}>
            <button className="btn ghost" onClick={() => { reset(); setInput(''); area.current?.focus(); }}>Make another</button>
          </p>
        </section>
      )}

      {phase === 'error' && error && (
        <section className="card error" role="alert">
          <div className="eyebrow">Something went wrong</div>
          <p className="msg">{error.msg}</p>
          {error.code === 'access-code' && (
            <p>
              <input className="code" type="password" placeholder="Access code" value={code} onChange={(e) => saveCode(e.target.value)} />
            </p>
          )}
          <p style={{ marginTop: 14 }}>
            {selected && (
              <button className="btn" onClick={() => start(selected, limits[selected.key] ?? defaultLimit(selected))} style={{ marginRight: 10 }}>Try again</button>
            )}
            <button className="btn ghost" onClick={reset}>Start over</button>
          </p>
        </section>
      )}

      <footer>
        For personal reading. Please only convert works you have the right to read.
        <br />
        Translations are made by AI and can contain mistakes.
      </footer>
    </main>
  );
}


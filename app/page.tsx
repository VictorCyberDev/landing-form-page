'use client';

import { useEffect, useRef, useState } from 'react';
import type { Book, Candidate, ResolveResult } from '@/lib/types';
import { bookIsEnglish, loadBook, translateBook, UserFacingError } from '@/lib/pipeline';

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

function looksLikeText(s: string) {
  return s.length > 500 || (s.match(/\n/g) || []).length >= 3;
}

export default function Home() {
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [limit, setLimit] = useState(30);
  const [progress, setProgress] = useState({ f: 0, msg: '' });
  const [pdf, setPdf] = useState<{ url: string; name: string; mb: string; title: string } | null>(null);
  const [error, setError] = useState<{ msg: string; code?: string } | null>(null);
  const [code, setCode] = useState('');
  const abort = useRef<AbortController | null>(null);
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
      setPdf({ url, name, mb: (blob.size / 1048576).toFixed(1), title: book.title });
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

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const q = input.trim();
    if (!q || phase === 'searching' || phase === 'working') return;
    setResult(null);
    setSelected(null);
    setPdf(null);
    setError(null);

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
      const first = r.english[0] || r.foreign[0] || null;
      setSelected(first);
      setLimit(Math.min(first?.pageInfo?.chapterLinks?.length || 30, 30));
      setPhase('found');
    } catch (err) {
      setError({ msg: (err as Error).message });
      setPhase('error');
    }
  }

  function start(c: Candidate) {
    setSelected(c);
    void produce((sig, p) => loadBook(c, limit, p, sig));
  }

  function saveCode(v: string) {
    setCode(v);
    try {
      localStorage.setItem('access-code', v);
    } catch {}
  }

  const busy = phase === 'searching' || phase === 'working';
  const eng = result?.english[0];
  const alt = result?.english.slice(1) ?? [];
  const foreign = result?.foreign ?? [];

  function Source({ c }: { c: Candidate }) {
    return (
      <>
        {c.author ? `${c.author} · ` : ''}
        <a className="link" href={c.url} target="_blank" rel="noreferrer">
          {c.sourceName}
        </a>
        {c.pageInfo?.words ? ` · ${fmt(c.pageInfo.words)} words` : ''}
      </>
    );
  }

  function Options({ c }: { c: Candidate }) {
    const links = c.pageInfo?.chapterLinks;
    const canMore = !!links?.length || !!c.pageInfo?.next;
    if (!canMore) return null;
    const max = links?.length || 200;
    return (
      <div className="row">
        <label htmlFor="limit">
          {links ? `This page lists ${links.length} chapters. Include the first` : 'Follow “next chapter” links for'}
        </label>
        <input
          id="limit"
          type="number"
          min={1}
          max={max}
          value={limit}
          onChange={(e) => setLimit(Math.max(1, Math.min(max, Number(e.target.value) || 1)))}
        />
        <span>{links ? 'chapters' : 'chapters in total'}</span>
      </div>
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
          <span className="hint">Titles are searched in Project Gutenberg, Open Library, Wikisource and the web.</span>
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
          {eng && (
            <section className="card">
              <div className="eyebrow ok">✓ English copy found</div>
              <h2>{eng.title}</h2>
              <p className="meta"><Source c={eng} /></p>
              <Options c={eng} />
              <button className="btn big" onClick={() => start(eng)} disabled={busy}>
                Download PDF
              </button>
              <p className="note">Typeset from the free public text as a clean, readable book — usually ready in a few seconds.</p>
              {alt.length > 0 && (
                <details className="alts">
                  <summary>Other English editions ({alt.length})</summary>
                  {alt.map((c) => (
                    <div className="alt" key={c.key}>
                      <span><strong>{c.title}</strong><br /><span className="meta"><Source c={c} /></span></span>
                      <button className="btn ghost" onClick={() => start(c)}>Download</button>
                    </div>
                  ))}
                </details>
              )}
            </section>
          )}

          {!eng && foreign.length > 0 && selected && (
            <section className="card">
              <div className="eyebrow">No English copy online</div>
              <h2>{selected.title}</h2>
              <p className="meta">
                <Source c={selected} />
                <span className="chip">{selected.language}</span>
              </p>
              <p className="note" style={{ marginTop: 0, marginBottom: 16 }}>
                We found it online in {selected.language}. We’ll read it, translate it into English chapter by chapter,
                and typeset the book
                {selected.pageInfo?.words
                  ? ` — ${fmt(selected.pageInfo.words)} words, ${estimate(selected.pageInfo.words)}`
                  : ''}
                .
              </p>
              <Options c={selected} />
              <button className="btn big" onClick={() => start(selected)} disabled={busy}>
                Translate to English &amp; make PDF
              </button>
              {foreign.length > 1 && (
                <details className="alts">
                  <summary>Other places it’s online ({foreign.length - 1})</summary>
                  {foreign.filter((c) => c.key !== selected.key).map((c) => (
                    <div className="alt" key={c.key}>
                      <span>
                        <strong>{c.title}</strong>
                        <span className="chip">{c.language}</span>
                        <br />
                        <span className="meta"><Source c={c} /></span>
                      </span>
                      <button
                        className="btn ghost"
                        onClick={() => {
                          setSelected(c);
                          setLimit(Math.min(c.pageInfo?.chapterLinks?.length || 30, 30));
                        }}
                      >
                        Use this
                      </button>
                    </div>
                  ))}
                </details>
              )}
            </section>
          )}

          {!eng && !foreign.length && (
            <section className="card">
              <div className="eyebrow">Not found</div>
              <h2>We couldn’t find a readable copy online</h2>
              <p className="meta">
                Try the author’s name with the title, or paste a link to a page where it can be read (a chapter list
                works best). You can also paste the text itself.
              </p>
            </section>
          )}

          {!eng && result.elsewhere.length > 0 && (
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
              <button className="btn" onClick={() => start(selected)} style={{ marginRight: 10 }}>Try again</button>
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


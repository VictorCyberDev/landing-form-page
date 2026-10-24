/**
 * The "Send to Novel PDF" bookmark. It runs inside the reader's own browser, on the novel site they are
 * already looking at, so the site sees an ordinary visit by the person. It collects the chapter list,
 * reads each chapter (politely, two at a time) and hands the text to this app in a new tab.
 */
export function bookmarkletSource(appOrigin: string): string {
  return `(async () => {
  const APP = ${JSON.stringify(appOrigin)};
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;background:#15203a;color:#f4ecd9;padding:12px 16px;border-radius:10px;font:14px/1.35 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.4);max-width:320px';
  document.body.appendChild(box);
  const say = (m) => { box.textContent = 'Novel PDF — ' + m; };
  const clean = (s) => (s || '').replace(/[\\u00a0\\u3000]/g, ' ').replace(/\\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const CH = /chapter|chap\\.?\\s*\\d|episode|prologue|epilogue|第\\s*[\\d〇零一二三四五六七八九十百千两]+\\s*[章回节節話话]|제\\s*\\d+/i;
  const NEXT = /^(next|next chapter|›|»|→|>|下一章|下一页|下一頁|下一节|次へ|다음)/i;

  const anchors = [...document.querySelectorAll('a[href]')].map((a) => {
    try { return { t: clean(a.textContent), u: new URL(a.getAttribute('href'), location.href) }; } catch (e) { return null; }
  }).filter((x) => x && x.u.origin === location.origin && x.t && x.t.length < 140 && x.u.href.split('#')[0] !== location.href.split('#')[0]);
  const seen = new Set();
  const uniq = anchors.filter((x) => { const k = x.u.href.split('#')[0]; if (seen.has(k)) return false; seen.add(k); return true; });
  const shape = (u) => (u.pathname + u.search).replace(/\\d+/g, '#');
  const groups = new Map();
  for (const x of uniq) { const k = shape(x.u); if (!k.includes('#')) continue; (groups.get(k) || groups.set(k, []).get(k)).push(x); }
  let best = [];
  for (const g of groups.values()) if (g.length > best.length) best = g;
  const byText = uniq.filter((x) => CH.test(x.t));
  if (byText.length > best.length) best = byText;
  let links = best.length >= 3 ? best : [];
  const nums = links.map((l) => (/\\d+/.exec(l.t) || [])[0]).map(Number);
  if (nums.length > 2 && nums[0] > nums[nums.length - 1]) links = links.slice().reverse();

  function extract(doc) {
    let bestEl = null, bestLen = 0;
    for (const el of doc.querySelectorAll('article, main, section, div, td')) {
      let len = 0;
      for (const p of el.querySelectorAll(':scope > p, :scope > div > p, :scope > br')) len += (p.textContent || '').length;
      if (len > bestLen) { bestLen = len; bestEl = el; }
    }
    let paras = [];
    if (bestEl) paras = [...bestEl.querySelectorAll('p')].map((p) => clean(p.textContent)).filter((t) => t.length > 1);
    if (paras.join('').length < 400) paras = (doc.body.innerText || doc.body.textContent || '').split(/\\n+/).map(clean).filter((t) => t.length > 1);
    const h = doc.querySelector('h1, h2, .chapter-title, .entry-title');
    return { title: clean(h ? h.textContent : doc.title).slice(0, 160), paragraphs: paras };
  }
  async function get(url) {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(url, { credentials: 'include' });
        if (r.ok) return extract(new DOMParser().parseFromString(await r.text(), 'text/html'));
      } catch (e) {}
      await sleep(1500 * (i + 1));
    }
    return null;
  }

  const chapters = [];
  const failed = [];
  if (links.length) {
    say('found ' + links.length + ' chapters, reading…');
    let done = 0, idx = 0;
    const slots = new Array(links.length);
    const worker = async () => {
      while (idx < links.length) {
        const i = idx++;
        const c = await get(links[i].u.href);
        if (c && c.paragraphs.length) { c.title = links[i].t || c.title; slots[i] = c; } else failed.push(links[i].t);
        done++; say('reading chapter ' + done + ' of ' + links.length + (failed.length ? ' (' + failed.length + ' failed)' : ''));
        await sleep(250);
      }
    };
    await Promise.all([worker(), worker()]);
    for (const s of slots) if (s) chapters.push(s);
  } else {
    say('no chapter list here — following "next chapter" links…');
    let doc = document, url = location.href, n = 0;
    const visited = new Set();
    while (doc && n < 500 && !visited.has(url)) {
      visited.add(url);
      const c = extract(doc);
      if (c.paragraphs.length) chapters.push(c);
      n++; say('read ' + n + ' page' + (n === 1 ? '' : 's'));
      const nx = [...doc.querySelectorAll('a[rel~=next], a[href]')].find((a) => a.matches('[rel~=next]') || NEXT.test(clean(a.textContent)));
      if (!nx) break;
      try { url = new URL(nx.getAttribute('href'), url).href; } catch (e) { break; }
      await sleep(300);
      try { const r = await fetch(url, { credentials: 'include' }); doc = r.ok ? new DOMParser().parseFromString(await r.text(), 'text/html') : null; } catch (e) { doc = null; }
    }
  }
  if (!chapters.length) { say('could not read any chapters from this page.'); return; }
  const title = clean(document.title).split(/\\s[|\\-–—]\\s/)[0] || 'Untitled';
  const payload = { type: 'novel-pdf-import', title, source: location.href, chapters, failed };
  say('sending ' + chapters.length + ' chapters to the app…');
  const w = window.open(APP + '/?import=1', '_blank');
  const onMsg = (e) => { if (e.origin === APP && e.data && e.data.type === 'novel-pdf-ready') { w.postMessage(payload, APP); say('sent! Continue in the other tab.'); window.removeEventListener('message', onMsg); } };
  window.addEventListener('message', onMsg);
  setTimeout(() => { if (box.textContent.indexOf('sent!') < 0) say('if the app tab did not open, allow pop-ups for this site and run the bookmark again.'); }, 15000);
})();`;
}

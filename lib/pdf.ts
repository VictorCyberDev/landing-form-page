import PDFDocument from 'pdfkit';
import Hypher from 'hypher';
import enUs from 'hyphenation.en-us';
import type { Book } from './types';

// 6 x 9 in trade paperback page.
const W = 432;
const H = 648;
const MT = 66;
const MB = 74;
const MX = 56;
const TEXT_W = W - MX * 2;

const INK = '#26221d';
const MUTED = '#8b8174';
const PAPER = '#fcfaf4';
const COVER_BG = '#15203a';
const GOLD = '#c9a762';
const CREAM = '#f4ecd9';

const BODY = 11.6;
const LEAD = 1.8; // extra leading, in pt

type Fonts = Record<string, ArrayBuffer>;
let fontCache: Promise<Fonts> | null = null;

function loadFonts(): Promise<Fonts> {
  if (!fontCache) {
    const files: Record<string, string> = {
      Body: 'EBGaramond_400Regular',
      BodyItalic: 'EBGaramond_400Regular_Italic',
      BodyBold: 'EBGaramond_700Bold',
      Display: 'CormorantGaramond_500Medium',
      DisplayItalic: 'CormorantGaramond_500Medium_Italic',
      DisplayBold: 'CormorantGaramond_600SemiBold',
    };
    fontCache = Promise.all(
      Object.entries(files).map(async ([k, f]) => {
        const r = await fetch(`/fonts/${f}.ttf`);
        if (!r.ok) throw new Error(`Could not load font ${f}`);
        return [k, await r.arrayBuffer()] as const;
      }),
    )
      .then((e) => Object.fromEntries(e))
      .catch((err) => {
        fontCache = null;
        throw err;
      });
  }
  return fontCache;
}

/** Straight quotes/apostrophes -> typographic ones (for titles and headings). */
function smart(s: string): string {
  return s
    .replace(/(^|[\s([{—-])"/g, '$1“')
    .replace(/"/g, '”')
    .replace(/(^|[\s([{—-])'/g, '$1‘')
    .replace(/'/g, '’');
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** "Chapter 12: The Storm" -> label "Chapter 12", title "The Storm". */
export function splitHeading(raw: string): { label: string; title: string } {
  const t = raw.trim();
  const m = /^((?:chapter|book|part|volume|letter|stave|canto|act|section|episode)\s+[\w.-]+)\s*[:.\-–—]?\s*(.*)$/i.exec(t);
  if (m) return { label: m[1].replace(/[.:]$/, ''), title: m[2].trim() };
  return { label: '', title: t };
}

type Seg = { t: string; i: boolean };
function splitItalics(s: string): Seg[] {
  const cleaned = s.replace(/\*\*(.+?)\*\*/g, '$1');
  const out: Seg[] = [];
  for (const part of cleaned.split(/(_[^_\n]{1,400}_|\*[^*\n]{1,400}\*)/)) {
    if (!part) continue;
    if (/^(_|\*)[^_*]+(_|\*)$/.test(part) && part[0] === part[part.length - 1]) {
      out.push({ t: part.slice(1, -1), i: true });
    } else out.push({ t: part, i: false });
  }
  return out;
}

const isSceneBreak = (p: string) => /^(\s*[*•·~–—-]\s*){3,}$/.test(p) || /^[=_\-~*#\s]{4,}$/.test(p);

export async function makePdf(
  book: Book,
  onProgress: (fraction: number, message: string) => void = () => {},
): Promise<Blob> {
  const fonts = await loadFonts();

  const doc = new PDFDocument({
    size: [W, H],
    margins: { top: MT, bottom: MB, left: MX, right: MX },
    bufferPages: true,
    autoFirstPage: false,
    // pdfkit 0.20 no longer bundles Helvetica; start from our own face instead.
    font: fonts.Body as unknown as string,
    info: {
      Title: book.title,
      Author: book.author || '',
      Subject: book.translated ? 'English edition (translated)' : 'English edition',
      Creator: 'Novel to PDF',
    },
  });
  const parts: Uint8Array[] = [];
  doc.on('data', (c: Uint8Array) => parts.push(c));
  const finished = new Promise<Blob>((resolve) =>
    doc.on('end', () => resolve(new Blob(parts as BlobPart[], { type: 'application/pdf' }))),
  );
  for (const [name, data] of Object.entries(fonts)) doc.registerFont(name, data);

  let paper = PAPER;
  doc.on('pageAdded', () => {
    doc.save();
    doc.rect(0, 0, W, H).fill(paper);
    doc.restore();
    doc.fillColor(INK);
  });
  const pageIndex = () => doc.bufferedPageRange().count - 1;

  const diamond = (cx: number, cy: number, r: number, color: string, fill = true) => {
    doc.save();
    doc.moveTo(cx, cy - r).lineTo(cx + r, cy).lineTo(cx, cy + r).lineTo(cx - r, cy).closePath();
    if (fill) doc.fillColor(color).fill();
    else doc.lineWidth(0.5).strokeColor(color).stroke();
    doc.restore();
  };
  const ornament = (cy: number, color: string, span = 70) => {
    doc.save();
    doc.lineWidth(0.5).strokeColor(color);
    doc.moveTo(W / 2 - span, cy).lineTo(W / 2 - 9, cy).stroke();
    doc.moveTo(W / 2 + 9, cy).lineTo(W / 2 + span, cy).stroke();
    doc.restore();
    diamond(W / 2, cy, 3.2, color);
  };
  const fitTitle = (text: string, font: string, max: number, min: number, width: number, maxH: number) => {
    let size = max;
    doc.font(font);
    for (; size > min; size -= 1) {
      doc.fontSize(size);
      if (doc.heightOfString(text, { width, align: 'center' }) <= maxH) break;
    }
    doc.fontSize(size);
    return size;
  };

  const title = smart(book.title || 'Untitled');
  const author = smart(book.author || '');

  // ---------- Cover ----------
  paper = COVER_BG;
  doc.addPage();
  paper = PAPER;
  doc.lineWidth(0.9).strokeColor(GOLD).rect(22, 22, W - 44, H - 44).stroke();
  doc.lineWidth(0.4).strokeColor(GOLD).rect(28, 28, W - 56, H - 56).stroke();
  diamond(W / 2, 112, 5, GOLD);
  doc.lineWidth(0.5).strokeColor(GOLD);
  doc.moveTo(W / 2 - 60, 112).lineTo(W / 2 - 12, 112).stroke();
  doc.moveTo(W / 2 + 12, 112).lineTo(W / 2 + 60, 112).stroke();
  doc.fillColor(CREAM);
  fitTitle(title, 'DisplayBold', 44, 20, W - 130, 250);
  const th = doc.heightOfString(title, { width: W - 130, align: 'center' });
  doc.text(title, 65, 300 - th / 2, { width: W - 130, align: 'center', lineGap: 2 });
  ornament(H - 215, GOLD, 40);
  if (author) {
    doc.font('Display').fontSize(14).fillColor(GOLD);
    doc.text(author.toUpperCase(), 50, H - 190, { width: W - 100, align: 'center', characterSpacing: 3 });
  }
  doc.font('DisplayItalic').fontSize(12).fillColor(CREAM);
  doc.text(book.translated ? 'Translated into English' : 'English edition', 50, H - 95, {
    width: W - 100,
    align: 'center',
  });

  // ---------- Title page ----------
  doc.addPage();
  doc.fillColor(INK);
  fitTitle(title, 'DisplayBold', 34, 18, TEXT_W, 200);
  const tth = doc.heightOfString(title, { width: TEXT_W, align: 'center' });
  doc.text(title, MX, 215 - tth / 2, { width: TEXT_W, align: 'center', lineGap: 2 });
  ornament(215 + tth / 2 + 28, GOLD);
  if (author) {
    doc.font('Display').fontSize(14).fillColor(INK);
    doc.text(author.toUpperCase(), MX, 215 + tth / 2 + 52, { width: TEXT_W, align: 'center', characterSpacing: 3 });
  }
  doc.font('DisplayItalic').fontSize(12).fillColor(MUTED);
  doc.text(book.translated ? 'An English translation' : 'English edition', MX, H - 130, {
    width: TEXT_W,
    align: 'center',
  });

  // ---------- About this edition ----------
  doc.addPage();
  doc.font('Body').fontSize(9.5).fillColor(MUTED);
  const date = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
  const about: string[] = [`${title}${author ? ` — ${author}` : ''}`];
  about.push(`Source: ${book.sourceName}\n${book.sourceUrl}`);
  if (book.translated) {
    about.push(
      `This English text is an AI translation${book.language ? ` of the ${book.language} original` : ''}, ` +
        `prepared for personal reading. It is not an authorised edition and may contain errors or omissions.`,
    );
  }
  about.push(`Typeset for offline reading on ${date}.`);
  doc.text(about.join('\n\n'), MX + 20, H - MB - 190, { width: TEXT_W - 40, align: 'center', lineGap: 2.5 });

  // ---------- Reserve contents pages ----------
  const n = book.chapters.length;
  const tocPages = n < 2 ? 0 : n <= 20 ? 1 : 1 + Math.ceil((n - 20) / 24);
  const tocStart = pageIndex() + 1;
  for (let i = 0; i < tocPages; i++) doc.addPage();

  // ---------- Chapters ----------
  // Own line layout: justified text with hyphenation, correct spacing around italics,
  // and widow/orphan control. (pdfkit's built-in wrapper drops spaces next to italic runs.)
  const hypher = new Hypher(enUs);
  const LEADING = BODY * 1.45;
  const wcache = new Map<string, number>();
  const measure = (t: string, it: boolean) => {
    const k = (it ? 'i|' : 'r|') + t;
    let w = wcache.get(k);
    if (w === undefined) {
      doc.font(it ? 'BodyItalic' : 'Body').fontSize(BODY);
      w = doc.widthOfString(t);
      wcache.set(k, w);
    }
    return w;
  };
  const SPACE = measure(' ', false);

  type Tok = { t: string; it: boolean; w: number; sp: boolean };
  type Line = { toks: Tok[]; last: boolean; indent: number };

  const tokenize = (p: string): Tok[] => {
    const toks: Tok[] = [];
    let pending = false;
    for (const seg of splitItalics(p)) {
      for (const part of seg.t.split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) {
          pending = true;
          continue;
        }
        part.split(/(?<=[—–])(?=[^\s—–])/).forEach((pc, i) => {
          toks.push({ t: pc, it: seg.i, w: measure(pc, seg.i), sp: i === 0 && pending && toks.length > 0 });
        });
        pending = false;
      }
    }
    return toks;
  };

  const hyphenate = (word: string): string[] | null => {
    const m = /^([^A-Za-z]*)([A-Za-z]{7,})([^A-Za-z]*)$/.exec(word);
    if (!m) return null;
    const parts = hypher.hyphenate(m[2]);
    if (parts.length < 2) return null;
    parts[0] = m[1] + parts[0];
    parts[parts.length - 1] += m[3];
    return parts;
  };

  const layout = (toks: Tok[], indent: number): Line[] => {
    const lines: Line[] = [];
    let cur: Tok[] = [];
    let curW = 0;
    let limit = TEXT_W - indent;
    let curIndent = indent;
    const flush = (last = false) => {
      lines.push({ toks: cur, last, indent: curIndent });
      cur = [];
      curW = 0;
      limit = TEXT_W;
      curIndent = 0;
    };
    for (const tok of toks) {
      const gap = cur.length && tok.sp ? SPACE : 0;
      if (curW + gap + tok.w <= limit) {
        cur.push(tok);
        curW += gap + tok.w;
        continue;
      }
      const parts = cur.length ? hyphenate(tok.t) : null;
      if (parts) {
        let best = 0;
        for (let k = parts.length - 1; k >= 1; k--) {
          const head = parts.slice(0, k).join('') + '-';
          if (curW + gap + measure(head, tok.it) <= limit) {
            best = k;
            break;
          }
        }
        if (best > 0) {
          const head = parts.slice(0, best).join('') + '-';
          cur.push({ t: head, it: tok.it, w: measure(head, tok.it), sp: tok.sp });
          flush();
          const tail = parts.slice(best).join('');
          cur = [{ t: tail, it: tok.it, w: measure(tail, tok.it), sp: false }];
          curW = cur[0].w;
          continue;
        }
      }
      if (cur.length) flush();
      cur = [tok];
      curW = tok.w;
    }
    if (cur.length) flush(true);
    return lines;
  };

  const drawLine = (line: Line, y: number) => {
    const toks = line.toks;
    let spaces = 0;
    let natural = 0;
    toks.forEach((t, i) => {
      natural += t.w;
      if (i > 0 && t.sp) {
        spaces++;
        natural += SPACE;
      }
    });
    const extra = !line.last && spaces > 0 ? Math.max(0, (TEXT_W - line.indent - natural) / spaces) : 0;
    const runs: { it: boolean; text: string; x: number }[] = [];
    let x = MX + line.indent;
    toks.forEach((t, i) => {
      const gap = i > 0 && t.sp;
      if (gap) x += SPACE + extra;
      const run = runs[runs.length - 1];
      if (run && run.it === t.it) run.text += (gap ? ' ' : '') + t.t;
      else {
        if (run && gap) run.text += ' ';
        runs.push({ it: t.it, text: t.t, x });
      }
      x += t.w;
    });
    for (const r of runs) {
      doc.font(r.it ? 'BodyItalic' : 'Body').fontSize(BODY).fillColor(INK);
      doc.text(r.text, r.x, y, extra > 0 ? { lineBreak: false, wordSpacing: extra } : { lineBreak: false });
    }
  };

  const chapterStart: number[] = [];
  const openerPages = new Set<number>();
  let y = MT;
  const newPage = () => {
    doc.addPage();
    y = MT;
  };

  const paragraph = (p: string, indent: number) => {
    const lines = layout(tokenize(p), indent);
    let i = 0;
    while (i < lines.length) {
      const room = Math.floor((H - MB - y + 0.5) / LEADING);
      const remaining = lines.length - i;
      let take = remaining;
      if (room < remaining) {
        take = room;
        if (take < 2 && y > MT + 1) take = 0; // no lone first line at the foot of a page
        else if (remaining - take === 1 && take > 2) take -= 1; // no lone last line on the next page
        if (take < 1 && y <= MT + 1) take = Math.max(1, room);
      }
      if (take === 0) {
        newPage();
        continue;
      }
      for (let k = 0; k < take; k++) drawLine(lines[i + k], y + k * LEADING);
      y += take * LEADING;
      i += take;
      if (i < lines.length) newPage();
    }
  };

  for (let ci = 0; ci < n; ci++) {
    const ch = book.chapters[ci];
    doc.addPage();
    chapterStart.push(pageIndex());
    openerPages.add(pageIndex());
    doc.outline.addItem(ch.title || `Chapter ${ci + 1}`);

    const { label, title: ctitle } = splitHeading(smart(ch.title || `Chapter ${ci + 1}`));
    let hy = MT + 64;
    doc.fillColor(MUTED);
    if (label) {
      doc.font('Display').fontSize(11);
      doc.text(label.toUpperCase(), MX, hy, { width: TEXT_W, align: 'center', characterSpacing: 3.2 });
      hy = doc.y + 12;
    }
    if (ctitle) {
      doc.fillColor(INK);
      fitTitle(ctitle, 'DisplayBold', 25, 15, TEXT_W, 120);
      doc.text(ctitle, MX, hy, { width: TEXT_W, align: 'center', lineGap: 1 });
      hy = doc.y + 14;
    } else if (!label) {
      hy += 6;
    }
    ornament(hy + 4, GOLD, 34);
    y = hy + 36;

    let first = true;
    for (const raw of ch.paragraphs) {
      const p = raw.trim();
      if (!p) continue;
      if (isSceneBreak(p)) {
        if (y + 40 > H - MB) newPage();
        for (const dx of [-14, 0, 14]) diamond(W / 2 + dx, y + 9, 1.9, MUTED);
        y += 26;
        first = true;
        continue;
      }
      if (p.includes('\n')) {
        // verse / lines that must keep their breaks
        for (const line of p.split('\n')) {
          if (y + LEADING > H - MB) newPage();
          doc.font('Body').fontSize(BODY).fillColor(INK);
          doc.text(line.trim(), MX + 22, y, { lineBreak: false });
          y += LEADING - 1;
        }
        y += 8;
        first = true;
        continue;
      }
      paragraph(p, first ? 0 : 15);
      first = false;
    }
    if (ci % 3 === 0) {
      onProgress((ci + 1) / n, `Typesetting chapter ${ci + 1} of ${n}`);
      await tick();
    }
  }
  const lastChapterEnd = pageIndex();

  // ---------- Contents ----------
  const numberOf = (idx: number) => idx - chapterStart[0] + 1;
  if (tocPages) {
    let page = 0;
    let row = 0;
    const startRow = (p: number) => (p === 0 ? MT + 78 : MT + 6);
    const perPage = (p: number) => (p === 0 ? 20 : 24);
    doc.switchToPage(tocStart);
    doc.font('DisplayBold').fontSize(22).fillColor(INK);
    doc.text('Contents', MX, MT + 14, { width: TEXT_W, align: 'center' });
    ornament(MT + 52, GOLD, 30);
    for (let ci = 0; ci < n; ci++) {
      if (row >= perPage(page)) {
        page++;
        row = 0;
        doc.switchToPage(tocStart + page);
      }
      const yy = startRow(page) + row * 21;
      const label = smart(book.chapters[ci].title || `Chapter ${ci + 1}`);
      const num = String(numberOf(chapterStart[ci]));
      doc.font('Body').fontSize(11).fillColor(INK);
      const numW = doc.widthOfString(num);
      let text = label;
      const maxW = TEXT_W - numW - 22;
      while (text.length > 4 && doc.widthOfString(text) > maxW) text = text.slice(0, -2);
      if (text !== label) text = text.trimEnd() + '…';
      const m = doc.page.margins;
      doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };
      doc.text(text, MX, yy, { lineBreak: false });
      const tw = doc.widthOfString(text);
      doc.text(num, W - MX - numW, yy, { lineBreak: false });
      doc.save();
      doc.lineWidth(0.5).strokeColor('#b9b0a2').dash(0.6, { space: 2.4 });
      doc.moveTo(MX + tw + 6, yy + 9).lineTo(W - MX - numW - 6, yy + 9).stroke();
      doc.undash();
      doc.restore();
      doc.page.margins = m;
      row++;
    }
  }

  // ---------- Running heads and folios ----------
  const first = chapterStart[0] ?? 0;
  for (let i = first; i <= lastChapterEnd; i++) {
    doc.switchToPage(i);
    const m = doc.page.margins;
    doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };
    const num = i - first + 1;
    if (!openerPages.has(i)) {
      let ci = 0;
      for (let k = 0; k < chapterStart.length; k++) if (chapterStart[k] <= i) ci = k;
      const head = num % 2 === 0 ? title : smart(splitHeading(book.chapters[ci].title).title || book.chapters[ci].title);
      doc.font('Display').fontSize(8.5).fillColor(MUTED);
      let h = head.toUpperCase();
      while (h.length > 4 && doc.widthOfString(h) + h.length * 1.6 > TEXT_W) h = h.slice(0, -2);
      if (h.length < head.length) h = h.trimEnd() + '…';
      doc.text(h, MX, 36, { width: TEXT_W, align: 'center', characterSpacing: 1.6, lineBreak: false });
    }
    doc.font('Body').fontSize(10).fillColor(MUTED);
    doc.text(String(num), MX, H - 44, { width: TEXT_W, align: 'center', lineBreak: false });
    doc.page.margins = m;
  }

  onProgress(1, 'Finishing the file');
  doc.end();
  return finished;
}

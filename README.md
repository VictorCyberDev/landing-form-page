# Novel to PDF

Paste a link, a title, or the text of a novel. The site finds where it is online
(Project Gutenberg, Open Library, Wikisource, any web page), and:

- if an **English copy exists**, one button downloads it as a typeset PDF;
- otherwise it **reads the original, translates it into English with Claude**, and typesets a book-style PDF
  (cover, contents, running heads, hyphenated justified text) that you can read offline.

The PDF is built in the browser (pdfkit + EB Garamond / Cormorant Garamond), so book size isn't limited by
serverless response limits.

## Configuration (environment variables)

| Variable | Purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | Preferred. Translation (Claude Sonnet via OpenRouter, DeepSeek as fallback) and web search. |
| `GEMINI_API_KEY` | Translation + web search (Google AI Studio key). Preferred for Chinese and other non-European sources. |
| `GROQ_API_KEY` | Translation fallback when Gemini is rate-limited or down. |
| `ANTHROPIC_API_KEY` | Optional. If set, Claude is used first. |
| `GEMINI_MODEL`, `GROQ_MODEL`, `TRANSLATION_MODEL` | Optional model overrides. |
| `ACCESS_CODE` | Optional. If set, translation requires this code (protects your AI quota on a public URL). |

Every translated passage is numbered and checked on return (all paragraphs present, no shortening, nothing left
untranslated). A failed check retries, then splits the passage and retries the halves.

## Develop

```
npm install
npm run dev
```

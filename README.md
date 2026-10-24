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
| `ANTHROPIC_API_KEY` | Optional. Uses Anthropic directly. If absent, on Vercel the app uses Vercel AI Gateway via the deployment's OIDC token. |
| `AI_GATEWAY_API_KEY` | Optional. Use an AI Gateway key outside Vercel. |
| `TRANSLATION_MODEL` | Optional model override. |
| `ACCESS_CODE` | Optional. If set, translation requires this code (protects your AI credit on a public URL). |

## Develop

```
npm install
npm run dev
```

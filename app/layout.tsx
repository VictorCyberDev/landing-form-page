import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Novel to PDF — read any novel in English, offline',
  description:
    'Paste a link or a title. We find where the novel is online, read it, and typeset a beautiful English PDF you can read offline — or hand you the existing English copy in one click.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#15203a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

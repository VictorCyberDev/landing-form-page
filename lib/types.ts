export type Chapter = { title: string; paragraphs: string[]; failed?: boolean; src?: string };

export type Report = {
  chapters: number;
  words: number;
  verification: string;
  verified: boolean;
  failed: string[];
  translation?: string;
};

export type Book = {
  title: string;
  author?: string;
  /** Language of the text as found online (e.g. "French"). */
  language?: string;
  sourceName: string;
  sourceUrl: string;
  chapters: Chapter[];
  /** True when the text in `chapters` was translated by us. */
  translated?: boolean;
  report?: Report;
};

export type Ref =
  | { kind: 'gutenberg'; id: string }
  | { kind: 'archive'; id: string }
  | { kind: 'url'; url: string };

export type PageInfo = {
  words: number;
  /** Result of checking the chapter numbering, when the source has been read. */
  verification?: string;
  chapters?: number;
  chapterLinks?: { title: string; url: string }[];
  next?: string;
};

export type Candidate = {
  key: string;
  title: string;
  author?: string;
  language: string;
  sourceName: string;
  url: string;
  ref: Ref;
  pageInfo?: PageInfo;
  note?: string;
  image?: string;
  blurb?: string;
};

export type ElsewhereEdition = {
  title: string;
  author?: string;
  url: string;
  access: string;
  year?: number;
};

export type Suggestion = {
  title: string;
  author?: string;
  year?: number;
  languages: string[];
  coverUrl?: string;
  blurb?: string;
  url?: string;
};

export type AboutLink = { title: string; url: string; description?: string; reason?: string };

export type ResolveResult = {
  /** "Did you mean…": works matching the name, with their authors. */
  suggestions: Suggestion[];
  english: Candidate[];
  foreign: Candidate[];
  elsewhere: ElsewhereEdition[];
  searched: string[];
  warnings: string[];
};

export type PageResult = {
  title: string;
  author?: string;
  url: string;
  paragraphs: string[];
  words: number;
  chapterLinks?: { title: string; url: string }[];
  next?: string;
  /** Value of <html lang>, if the page declares one. */
  lang?: string;
  image?: string;
  blurb?: string;
};

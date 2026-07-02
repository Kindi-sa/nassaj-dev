import {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  createContext,
  useContext,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import type { Components } from 'react-markdown';
import { useTranslation } from 'react-i18next';
import FocusTrap from 'focus-trap-react';
import {
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  PanelLeft,
  Copy,
  Check,
  List,
} from 'lucide-react';
import WikiMermaidDiagram from './WikiMermaidDiagram';
import WikiSearchField from '../WikiSearchField';
import { useWikiSearch, normalizeArabic } from '../useWikiSearch';
import { slugify, extractToc } from '../wikiUtils';
import './wiki-panel.css';

// ---------------------------------------------------------------------------
// Hook: responsive sidebar state — driven by matchMedia to handle rotation
// ---------------------------------------------------------------------------

/** Returns true while viewport width >= 768px, updates on breakpoint cross. */
function useIsDesktop(): boolean {
  const mq =
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 768px)') : null;
  const [isDesktop, setIsDesktop] = useState<boolean>(() => mq?.matches ?? true);

  useEffect(() => {
    if (!mq) return;
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    // Modern API
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
    // Legacy
    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return isDesktop;
}

// ---------------------------------------------------------------------------
// Wiki content loaded at build-time via Vite import.meta.glob (?raw).
// ---------------------------------------------------------------------------
const RAW_PAGES = import.meta.glob('/docs/team-wiki/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

import indexJson from '../../../../docs/team-wiki/index.json';

type WikiPage = {
  file: string;
  title: string;
};

const PAGES: WikiPage[] = (indexJson as { pages: WikiPage[] }).pages;

const RAW_BY_FILE: Record<string, string> = {};
for (const page of PAGES) {
  const raw = RAW_PAGES[`/docs/team-wiki/${page.file}`];
  if (typeof raw === 'string') RAW_BY_FILE[page.file] = raw;
}

function getPageContent(file: string): string | null {
  const raw = RAW_BY_FILE[file];
  return typeof raw === 'string' ? collapseHtmlBlocks(raw) : null;
}

/**
 * remark treats a blank line inside a raw HTML block as the end of that block,
 * which causes large multi-line SVGs (that contain blank separator lines) to be
 * split: only the first chunk is treated as HTML, the rest becomes paragraphs
 * or code blocks.
 *
 * This function collapses blank lines that appear *inside* an SVG element so
 * remark sees the whole tag as a single contiguous HTML block, and wraps each
 * SVG in a horizontally-scrollable container so dense diagrams stay legible on
 * narrow (mobile) viewports instead of shrinking to an unreadable size
 * (app-wide viewport disables pinch-zoom). It does NOT touch other content.
 */
function collapseHtmlBlocks(markdown: string): string {
  // Collapse blank lines inside <svg>…</svg>, then wrap in a scroll container.
  return markdown.replace(
    /(<svg[\s\S]*?<\/svg>)/g,
    (match) =>
      `<div class="wiki-diagram-scroll">${match.replace(/\n{2,}/g, '\n')}</div>`,
  );
}

// ---------------------------------------------------------------------------
// Internal context — shared between WikiPanel and markdown components
// ---------------------------------------------------------------------------

type WikiInternalContext = {
  setActiveFile: (file: string) => void;
  /** Ref to the scrollable container (data-wiki-scroll) */
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  /**
   * Returns false on the very first call per page (so the first H1 is hidden),
   * and true on every subsequent call. Reset by WikiPanel on activeFile change.
   */
  consumeFirstH1: () => boolean;
};

const WikiCtx = createContext<WikiInternalContext>({
  setActiveFile: () => undefined,
  scrollContainerRef: { current: null },
  consumeFirstH1: () => true,
});

// ---------------------------------------------------------------------------
// Copy button for code blocks
// ---------------------------------------------------------------------------

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }, [code]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? 'تم النسخ' : 'نسخ الكود'}
      className={[
        'absolute end-2 top-2 rounded p-1 transition-colors',
        copied
          ? 'bg-primary/20 text-primary'
          : 'bg-muted text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100',
      ].join(' ')}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Code block with copy button — handles both inline and fenced code
// ---------------------------------------------------------------------------

/**
 * react-markdown v10 routes ALL <code> nodes here (via components.code).
 * It also wraps fenced code blocks in its own <pre> before calling this
 * component, which would cause <pre>-inside-<pre> nesting if we render
 * another <pre>.  We break the nesting by also overriding components.pre
 * (below) to render a transparent pass-through — so the only real <pre>
 * wrapper lives here, inside CodeBlock.
 *
 * Inline detection: a code node is "inline" when it has no language class
 * AND its text content contains no newline.  Both conditions must hold:
 *   - language-* class  → always fenced block (explicit language)
 *   - contains \n       → multi-line → block even without a language tag
 */
function CodeBlock({
  className,
  children,
}: React.HTMLAttributes<HTMLElement> & { inline?: boolean }) {
  const lang = /language-(\w+)/.exec(className ?? '')?.[1] ?? '';
  const rawText = String(children);
  const code = rawText.replace(/\n$/, '');

  // Inline: no language class AND no newline in content
  const isInline = !lang && !rawText.includes('\n');

  if (isInline) {
    // Render as a styled <code> span — no <pre>, no copy button
    return (
      <code className="wiki-inline-code rounded px-1 py-0.5 text-sm font-mono">
        {children}
      </code>
    );
  }

  if (lang === 'mermaid') {
    // Use the wiki-specific wrapper that adds a zoom button
    return <WikiMermaidDiagram code={code} />;
  }

  return (
    <div className="group relative">
      <pre className="my-3 overflow-x-auto rounded-lg border border-border bg-muted/50 p-4 pe-10 text-sm">
        <code className={className}>{children}</code>
      </pre>
      <CopyButton code={code} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Heading with anchor id — P0-B
// ---------------------------------------------------------------------------

/** Recursively extract plain text from React children */
function extractTextFromChildren(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(extractTextFromChildren).join('');
  if (children !== null && typeof children === 'object' && 'props' in (children as object)) {
    const el = children as React.ReactElement<{ children?: React.ReactNode }>;
    return extractTextFromChildren(el.props?.children);
  }
  return '';
}

function HeadingWithId({
  level,
  children,
  className,
}: {
  level: 1 | 2 | 3;
  children: React.ReactNode;
  className: string;
}) {
  const { scrollContainerRef, consumeFirstH1 } = useContext(WikiCtx);

  const text = extractTextFromChildren(children);
  const id = slugify(text);

  // Suppress the very first H1 — toolbar already displays the page title
  if (level === 1 && !consumeFirstH1()) {
    return null;
  }

  const Tag = `h${level}` as 'h1' | 'h2' | 'h3';

  const handleAnchorClick = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = scrollContainerRef.current;
    const target = document.getElementById(id);
    if (target && container) {
      container.scrollTop = target.offsetTop - container.offsetTop - 16;
    }
  };

  return (
    <Tag id={id} className={className}>
      <a
        href={`#${id}`}
        onClick={handleAnchorClick}
        className="no-underline hover:underline decoration-primary/40"
        aria-label={`رابط للقسم: ${text}`}
      >
        {children}
      </a>
    </Tag>
  );
}

// ---------------------------------------------------------------------------
// Anchor link — P0-A: three cases (external / internal .md / anchor #)
// ---------------------------------------------------------------------------

function AnchorLink({
  href,
  children,
}: {
  href?: string;
  children?: React.ReactNode;
}) {
  const { setActiveFile, scrollContainerRef } = useContext(WikiCtx);

  // Case 1: anchor (#section)
  if (href?.startsWith('#')) {
    const handleClick = (e: React.MouseEvent) => {
      e.preventDefault();
      const id = href.slice(1);
      const container = scrollContainerRef.current;
      const target = document.getElementById(id);
      if (target && container) {
        container.scrollTop = target.offsetTop - container.offsetTop - 16;
      } else {
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };
    return (
      <a href={href} onClick={handleClick} className="text-primary underline-offset-2 hover:underline">
        {children}
      </a>
    );
  }

  // Case 2: internal .md link
  if (href && href.endsWith('.md') && !href.startsWith('http')) {
    const handleClick = (e: React.MouseEvent) => {
      e.preventDefault();
      const filename = href.split('/').pop() ?? href;
      if (PAGES.some((p) => p.file === filename)) {
        setActiveFile(filename);
      }
    };
    return (
      <a
        href={href}
        onClick={handleClick}
        className="cursor-pointer text-primary underline-offset-2 hover:underline"
      >
        {children}
      </a>
    );
  }

  // Case 3: external link
  return (
    <a
      href={href}
      className="text-primary underline-offset-2 hover:underline"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Markdown components map (stable reference — recreated only once)
// ---------------------------------------------------------------------------

const MARKDOWN_COMPONENTS: Components = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  code: CodeBlock as any,
  // react-markdown wraps fenced code blocks in its own <pre> before handing
  // them to the `code` renderer.  Without this override the DOM ends up with
  // <pre (remark)><pre (CodeBlock)>…</pre></pre>.  We dissolve the outer <pre>
  // by rendering a transparent fragment — CodeBlock owns the only real <pre>.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pre: ({ children }: React.HTMLAttributes<HTMLPreElement>) => <>{children}</>,
  h1: ({ children }) => (
    <HeadingWithId level={1} className="mb-4 mt-0 text-2xl font-bold text-foreground">
      {children}
    </HeadingWithId>
  ),
  h2: ({ children }) => (
    <HeadingWithId
      level={2}
      className="mb-3 mt-6 border-b pb-2 text-xl font-semibold text-foreground [border-bottom-color:var(--wiki-border-strong,hsl(var(--foreground)/0.18))]"
    >
      {children}
    </HeadingWithId>
  ),
  h3: ({ children }) => (
    <HeadingWithId level={3} className="mb-2 mt-4 text-base font-semibold text-foreground">
      {children}
    </HeadingWithId>
  ),
  p: ({ children }) => (
    <p className="my-3 leading-relaxed text-foreground">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 ps-6 text-foreground">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1 ps-6 text-foreground">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-s-4 border-primary/40 ps-4 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  a: AnchorLink as any,
  table: ({ children }) => (
    /* البند 5: مؤشر تمرير خفيف (ظل على الحافة اليسرى) على الجوال */
    <div className="wiki-table-scroll my-3 overflow-x-auto rounded-lg border border-border">
      <table className="min-w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/50">{children}</thead>,
  th: ({ children }) => (
    /* البند 5: px-2 على الجوال لتقليل فيض الجداول، px-4 على الديسكتوب */
    <th className="border-b border-border px-2 py-2 text-start text-xs font-semibold uppercase tracking-wide text-muted-foreground md:px-4">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-border/40 px-2 py-2 align-top text-start text-foreground/90 md:px-4">
      {children}
    </td>
  ),
  hr: () => (
    <hr
      className="my-6 border-0 border-t"
      style={{ borderTopColor: 'var(--wiki-border-strong, hsl(var(--foreground) / 0.18))' }}
    />
  ),
};

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeRaw];

// ---------------------------------------------------------------------------
// TOC component — P1-A
// ---------------------------------------------------------------------------

function TableOfContents({
  toc,
  scrollContainerRef,
}: {
  toc: ReturnType<typeof extractToc>;
  scrollContainerRef: React.RefObject<HTMLElement | null>;
}) {
  // البند 2: مطويّ افتراضياً على الجوال (<768px)، مفتوح على الديسكتوب
  const isDesktop = useIsDesktop();
  const [open, setOpen] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 768px)').matches : true
  );

  // تحديث عند تغيّر breakpoint (تدوير، تغيير حجم النافذة)
  useEffect(() => {
    setOpen(isDesktop);
  }, [isDesktop]);
  const [activeId, setActiveId] = useState<string>('');

  // Scroll spy
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || toc.length === 0) return;

    const handleScroll = () => {
      let current = toc[0]?.id ?? '';
      for (const entry of toc) {
        const el = document.getElementById(entry.id);
        if (!el) continue;
        if (container.scrollTop >= el.offsetTop - container.offsetTop - 32) {
          current = entry.id;
        }
      }
      setActiveId(current);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => container.removeEventListener('scroll', handleScroll);
  }, [toc, scrollContainerRef]);

  if (toc.length === 0) return null;

  const scrollToId = (id: string) => {
    const container = scrollContainerRef.current;
    const target = document.getElementById(id);
    if (target && container) {
      container.scrollTop = target.offsetTop - container.offsetTop - 16;
    }
  };

  return (
    /* البند 6: border/80 بدل border/50 لأفضل تباين ممكن مع الـtoken الحالي */
    <div className="mb-5 rounded-lg border border-border/80 bg-muted/20 text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg px-4 py-2.5 text-right font-semibold text-foreground transition-colors hover:bg-accent/40"
      >
        <List className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="flex-1">في هذه الصفحة</span>
        {open ? (
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        )}
      </button>
      {open && (
        <ul className="pb-2 pt-1">
          {toc.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => scrollToId(entry.id)}
                className={[
                  'w-full py-1 text-right transition-colors hover:bg-accent/40',
                  entry.level === 3 ? 'ps-8 text-xs' : 'ps-6 text-sm',
                  activeId === entry.id ? 'font-medium text-primary' : 'text-muted-foreground',
                ].join(' ')}
              >
                {entry.text}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prev / Next navigation bar — P1-B
// ---------------------------------------------------------------------------

function PrevNextNav({
  activeFile,
  onNavigate,
}: {
  activeFile: string;
  onNavigate: (file: string) => void;
}) {
  const idx = PAGES.findIndex((p) => p.file === activeFile);
  const prevPage = idx > 0 ? PAGES[idx - 1] : null;
  const nextPage = idx < PAGES.length - 1 ? PAGES[idx + 1] : null;

  if (!prevPage && !nextPage) return null;

  return (
    <div className="mt-8 flex items-center justify-between border-t border-border/40 pt-4">
      {/* Previous — base glyph points back (←); rtl:rotate-180 flips it to (→),
          the "back" direction in RTL. Mirrors the rtl flip used elsewhere. */}
      {prevPage ? (
        <button
          type="button"
          onClick={() => onNavigate(prevPage.file)}
          className="flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4 flex-shrink-0 rtl:rotate-180" aria-hidden="true" />
          <span className="max-w-[140px] truncate">{prevPage.title}</span>
        </button>
      ) : (
        <div />
      )}

      {/* Next — base glyph points forward (→); rtl:rotate-180 flips it to (←),
          the "forward" direction in RTL. */}
      {nextPage ? (
        <button
          type="button"
          onClick={() => onNavigate(nextPage.file)}
          className="flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <span className="max-w-[140px] truncate">{nextPage.title}</span>
          <ChevronRight className="h-4 w-4 flex-shrink-0 rtl:rotate-180" aria-hidden="true" />
        </button>
      ) : (
        <div />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search highlight utility (B-2: highlight matched term inside article DOM)
// ---------------------------------------------------------------------------

/** CSS class injected for the temporary highlight animation. */
const HIGHLIGHT_CLASS = 'wiki-search-highlight';

/**
 * After a search result is selected, scroll to the first text node inside
 * `container` that contains `term` (Arabic-normalized), and apply a brief
 * highlight that fades out.
 *
 * Strategy: walk the DOM tree looking for Element nodes whose textContent
 * (normalized) contains the normalized term. Prefer the deepest match so we
 * land on the paragraph/heading rather than the article root.
 */
function scrollToMatchedTerm(
  container: HTMLElement,
  term: string,
): void {
  const normalizedTerm = normalizeArabic(term.trim());
  if (!normalizedTerm) return;

  // BFS/DFS: collect candidate elements whose textContent contains the term.
  // We want the deepest element (smallest subtree) to avoid highlighting the
  // whole article.
  let bestMatch: HTMLElement | null = null;

  const walk = (node: HTMLElement) => {
    const nodeText = normalizeArabic(node.textContent ?? '');
    if (!nodeText.includes(normalizedTerm)) return; // prune subtree

    // This node contains the term. Record it (last one visited = deepest).
    bestMatch = node;

    // Recurse into children for a deeper match
    for (const child of Array.from(node.children)) {
      walk(child as HTMLElement);
    }
  };

  walk(container);

  if (!bestMatch) return;

  const el = bestMatch as HTMLElement;

  // Scroll the matched element into view inside the scroll container
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Apply highlight: add class, remove after 2s
  el.classList.add(HIGHLIGHT_CLASS);
  setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), 2000);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function WikiPanel() {
  const { t } = useTranslation();
  const [activeFile, setActiveFile] = useState<string>(PAGES[0]?.file ?? '');

  // البند 1: مغلق افتراضياً على الجوال (<768px)، مفتوح على الديسكتوب
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 768px)').matches : true
  );

  // تحديث sidebarOpen عند تغيّر breakpoint (تدوير الجهاز اللوحي، تغيير حجم النافذة)
  const isDesktop = useIsDesktop();
  useEffect(() => {
    setSidebarOpen(isDesktop);
  }, [isDesktop]);

  const searchInputRef = useRef<HTMLInputElement>(null) as React.RefObject<HTMLInputElement>;
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const articleRef = useRef<HTMLElement | null>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement | null>(null);

  // A11y: polite live announcement when the index drawer closes via keyboard.
  const [closeAnnouncement, setCloseAnnouncement] = useState('');

  // B-2: track the matched term from the last search selection
  const pendingMatchTerm = useRef<string | null>(null);

  const { query, setQuery, clearQuery, results, isSearching } = useWikiSearch({
    pages: PAGES,
    rawContents: RAW_BY_FILE,
  });

  // H1 suppression: first H1 per page is hidden (toolbar shows the title already)
  // consumeFirstH1 returns false on the very first call (→ skip), true thereafter.
  const firstH1Done = useRef(false);
  const consumeFirstH1 = useCallback((): boolean => {
    if (!firstH1Done.current) {
      firstH1Done.current = true;
      return false; // tell HeadingWithId: do NOT render this one
    }
    return true;
  }, []);

  // Reset the flag whenever the active page changes
  useEffect(() => {
    firstH1Done.current = false;
  }, [activeFile]);

  // B-2: after page content renders, scroll to and highlight the matched term
  useEffect(() => {
    const term = pendingMatchTerm.current;
    if (!term || !articleRef.current) return;
    pendingMatchTerm.current = null;

    // Give ReactMarkdown a frame to render before walking the DOM
    const id = requestAnimationFrame(() => {
      if (articleRef.current) {
        scrollToMatchedTerm(articleRef.current, term);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [activeFile]);

  const wikiCtxValue = useMemo<WikiInternalContext>(
    () => ({
      setActiveFile,
      scrollContainerRef: scrollContainerRef as React.RefObject<HTMLElement | null>,
      consumeFirstH1,
    }),
    [consumeFirstH1],
  );

  // Keyboard shortcuts — P1-C
  // B-1: on mobile, Escape closes the drawer first (if open and no query)
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable;

      if (e.key === 'Escape') {
        if (query.trim()) {
          clearQuery();
        } else {
          // A11y (WCAG SC 2.1.1, 3.2.2): when the drawer is open and Escape
          // collapses it, return focus to the toggle button and announce the
          // change so screen-reader users aren't left on a hidden region.
          setSidebarOpen((open) => {
            if (open) {
              setCloseAnnouncement(t('wiki.indexClosed', 'تم إغلاق الفهرس'));
              requestAnimationFrame(() => sidebarToggleRef.current?.focus());
            }
            return false;
          });
        }
        return;
      }

      // Ctrl+K / Cmd+K — focus search
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setSidebarOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
        return;
      }

      // "/" — focus search (only when not already in an input)
      if (e.key === '/' && !inInput) {
        e.preventDefault();
        setSidebarOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
    },
    [query, clearQuery, t],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // B-2: when a search result is selected, record the matched term then navigate
  const handleSelectResult = useCallback((file: string, matchedTerm?: string) => {
    if (matchedTerm) {
      pendingMatchTerm.current = matchedTerm;
    }
    setActiveFile(file);
  }, []);

  const content = useMemo(() => getPageContent(activeFile), [activeFile]);
  const activeTitle = PAGES.find((p) => p.file === activeFile)?.title ?? '';

  // TOC derived from raw markdown — P1-A
  const toc = useMemo(() => (content ? extractToc(content) : []), [content]);

  // B-1: sidebar state — on mobile it's a drawer (overlay), on desktop it's a column.
  // We detect "mobile" at render time via a media query, but the sidebar open/close
  // state is shared — the same boolean controls both the column width (desktop) and
  // the drawer visibility (mobile).
  //
  // Implementation: on mobile (<md breakpoint = 768 px) the sidebar becomes
  // position:fixed covering the viewport, with a backdrop. On desktop it remains
  // the flex-column layout.

  return (
    <WikiCtx.Provider value={wikiCtxValue}>
      <div
        className="flex h-full overflow-hidden bg-background"
        dir="rtl"
        lang="ar"
        role="region"
        aria-label={t('wiki.panelAriaLabel', 'ويكي نسّاج')}
      >
        {/* A11y: polite live region for keyboard-driven drawer close. */}
        <div aria-live="polite" className="sr-only">
          {closeAnnouncement}
        </div>

        {/* ── B-1: Mobile drawer backdrop ────────────────────────────────────── */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/40 md:hidden"
            aria-hidden="true"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* ── Sidebar nav ─────────────────────────────────────────────────────
            Desktop (md+): regular flex column — pushes main content.
            Mobile (<md):  fixed drawer from inline-start (right in RTL), overlaid.
            البند 1: FocusTrap فقط على الجوال حين يكون الدرج مفتوحاً (modal behaviour).
        */}
        <FocusTrap
          active={!isDesktop && sidebarOpen}
          focusTrapOptions={{
            allowOutsideClick: true,
            returnFocusOnDeactivate: false, // نعيد التركيز يدوياً لزر ☰
            onDeactivate: () => {
              setSidebarOpen(false);
              requestAnimationFrame(() => sidebarToggleRef.current?.focus());
            },
          }}
        >
          <nav
            id="wiki-sidebar"
            aria-label={t('wiki.sidebarAriaLabel', 'فهرس الويكي')}
            aria-modal={!isDesktop && sidebarOpen ? true : undefined}
            className={[
              // البند 1: خلفية الـnav — مُصمتة على الجوال، شفافة على الديسكتوب
              'overflow-y-auto border-e border-border/60 transition-all duration-200',
              'bg-background md:bg-muted/20',
              // Desktop: normal flex-shrink-0 column, width controlled by sidebarOpen
              'md:relative md:z-auto md:flex-shrink-0',
              sidebarOpen ? 'md:w-56 lg:w-64' : 'md:w-0 md:overflow-hidden',
              // Mobile: fixed drawer from RIGHT edge (RTL), always full height, slides in/out.
              // Use physical `right-0` (not `start-0`) because <html> has no dir="rtl" so
              // logical `start-0` resolves as `left:0` (LTR), placing the drawer on the wrong edge.
              'fixed inset-y-0 right-0 z-40 w-[min(280px,85vw)]',
              'md:inset-y-auto md:right-auto md:w-auto md:transform-none',
            ].join(' ')}
            data-wiki-drawer={sidebarOpen ? 'open' : 'closed'}
          >
            {/* ── البند 8: شعار نسّاج — بارز أعلى الفهرس ──────────────────── */}
            <div className="flex items-center px-4 pb-2 pt-3">
              {/* Light mode */}
              <img
                src="/nassaj-logo-on-light.svg"
                alt="نسّاج"
                className="h-7 w-auto dark:hidden md:h-8"
              />
              {/* Dark mode */}
              <img
                src="/nassaj-logo-on-dark.svg"
                alt="نسّاج"
                className="hidden h-7 w-auto dark:block md:h-8"
              />
            </div>

            <WikiSearchField
              query={query}
              onQueryChange={setQuery}
              onClear={clearQuery}
              results={results}
              isSearching={isSearching}
              onSelectResult={handleSelectResult}
              inputRef={searchInputRef}
            />

            {!isSearching && (
              <div className="px-2 pb-4">
                <ul role="list" className="space-y-0.5">
                  {PAGES.map((page) => {
                    const isActive = page.file === activeFile;
                    return (
                      <li key={page.file}>
                        <button
                          type="button"
                          onClick={() => {
                            setActiveFile(page.file);
                            // On mobile, close the drawer after selecting a page
                            if (!isDesktop) setSidebarOpen(false);
                          }}
                          aria-current={isActive ? 'page' : undefined}
                          className={`flex min-h-[44px] w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm transition-colors md:min-h-0 ${
                            isActive
                              ? 'bg-primary/10 font-medium text-primary'
                              : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                          }`}
                        >
                          {isActive && (
                            <ChevronRight
                              className="h-3 w-3 flex-shrink-0 rotate-180"
                              aria-hidden="true"
                            />
                          )}
                          <span className={isActive ? '' : 'ps-5'}>{page.title}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>

                {/* ── البند 8: شعار الكندي — مظلة خفيفة أسفل الفهرس ──────── */}
                <div className="mt-4 flex flex-col items-center gap-1 border-t border-border/30 pt-4">
                  <span className="text-[10px] text-muted-foreground">علامة من دار الكندي</span>
                  <img
                    src="/alkindy-symbol.svg"
                    alt="دار الكندي"
                    className="h-5 w-auto opacity-70"
                  />
                </div>
              </div>
            )}
          </nav>
        </FocusTrap>

        {/* Content area */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden" aria-label={activeTitle}>
          {/* Toolbar */}
          <div className="flex flex-shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2">
            {/* البند 4: هدف لمس ≥44×44px على الجوال، مع نص "الفهرس" مرئي تحت md */}
            <button
              ref={sidebarToggleRef}
              type="button"
              onClick={() => setSidebarOpen((v) => !v)}
              aria-label={
                sidebarOpen
                  ? t('wiki.closeSidebar', 'إخفاء الفهرس')
                  : t('wiki.openSidebar', 'إظهار الفهرس')
              }
              aria-expanded={sidebarOpen}
              aria-controls="wiki-sidebar"
              aria-describedby="wiki-sidebar-hint"
              className={[
                'flex items-center gap-1.5 rounded-md text-muted-foreground',
                'hover:bg-accent hover:text-foreground',
                // الجوال: هدف لمس 44×44px
                'min-h-[44px] min-w-[44px] justify-center px-2 md:min-h-0 md:min-w-0 md:p-1.5',
              ].join(' ')}
            >
              <PanelLeft className="h-4 w-4 flex-shrink-0 rtl:scale-x-[-1]" aria-hidden="true" />
              {/* نص "الفهرس" مرئي على الجوال فقط */}
              <span className="text-sm font-medium md:hidden">
                {t('wiki.sidebarLabel', 'الفهرس')}
              </span>
            </button>
            <span id="wiki-sidebar-hint" className="sr-only">
              {t('wiki.sidebarEscapeHint', 'اضغط Escape لإغلاق الفهرس')}
            </span>
            {/* البند 3+4: text-base على الجوال / text-sm على الديسكتوب — يبرز عنوان الصفحة كترويسة */}
            <h2 className="line-clamp-2 text-base font-bold text-foreground md:text-sm md:font-semibold">{activeTitle}</h2>
          </div>

          {/* Scrollable body */}
          {/* البند 7: حشوة أفقية px-4 على الجوال، px-6 على الديسكتوب */}
          <div
            className="flex-1 overflow-y-auto px-4 py-6 md:px-6"
            data-wiki-scroll="true"
            ref={(el) => {
              scrollContainerRef.current = el;
            }}
          >
            {content !== null ? (
              <article
                className="wiki-article prose prose-sm max-w-3xl"
                lang="ar"
                dir="rtl"
                ref={(el) => {
                  articleRef.current = el;
                }}
              >
                {toc.length > 0 && (
                  <TableOfContents
                    toc={toc}
                    scrollContainerRef={scrollContainerRef as React.RefObject<HTMLElement | null>}
                  />
                )}

                {/*
                  key={activeFile} resets the ReactMarkdown subtree on page change,
                  which is essential for the H1-suppression ref to work correctly.
                */}
                <ReactMarkdown
                  key={activeFile}
                  remarkPlugins={REMARK_PLUGINS}
                  rehypePlugins={REHYPE_PLUGINS}
                  components={MARKDOWN_COMPONENTS}
                >
                  {content}
                </ReactMarkdown>

                <PrevNextNav activeFile={activeFile} onNavigate={setActiveFile} />
              </article>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('wiki.pageNotFound', 'الصفحة غير موجودة')}
              </p>
            )}
          </div>
        </main>
      </div>
    </WikiCtx.Provider>
  );
}

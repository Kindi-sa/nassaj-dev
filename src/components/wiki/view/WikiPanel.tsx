import { useState, useEffect, useMemo, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { useTranslation } from 'react-i18next';
import { BookOpen, ChevronRight } from 'lucide-react';
import MermaidDiagram from '../../project-board/view/MermaidDiagram';

// ---------------------------------------------------------------------------
// Wiki content loaded at build-time via Vite import.meta.glob (?raw).
// No server changes needed; files are bundled as string literals.
// ---------------------------------------------------------------------------
// Vite resolves glob paths relative to project root when they start with '/'.
// The result keys are root-relative paths (e.g. '/docs/team-wiki/00-overview.md').
const RAW_PAGES = import.meta.glob('/docs/team-wiki/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// index.json imported directly — always consistent with the glob above
import indexJson from '../../../../docs/team-wiki/index.json';

type WikiPage = {
  file: string;
  title: string;
};

const PAGES: WikiPage[] = (indexJson as { pages: WikiPage[] }).pages;

// Resolve a page slug into its raw Markdown string (or null if not found)
function getPageContent(file: string): string | null {
  const key = `/docs/team-wiki/${file}`;
  const raw = RAW_PAGES[key];
  return typeof raw === 'string' ? raw : null;
}

// ---------------------------------------------------------------------------
// Markdown rendering helpers
// ---------------------------------------------------------------------------

// Custom code component: renders ```mermaid blocks as diagrams, rest as <pre>
function CodeBlock({
  className,
  children,
}: React.HTMLAttributes<HTMLElement> & { inline?: boolean }) {
  const lang = /language-(\w+)/.exec(className ?? '')?.[1] ?? '';
  const code = String(children).replace(/\n$/, '');

  if (lang === 'mermaid') {
    return <MermaidDiagram code={code} />;
  }

  return (
    <pre className="my-3 overflow-x-auto rounded-lg border border-border bg-muted/50 p-4 text-sm">
      <code className={className}>{children}</code>
    </pre>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  code: CodeBlock as any,
  h1: ({ children }) => (
    <h1 className="mb-4 mt-0 text-2xl font-bold text-foreground">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-3 mt-6 border-b border-border/40 pb-2 text-xl font-semibold text-foreground">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 mt-4 text-base font-semibold text-foreground">{children}</h3>
  ),
  p: ({ children }) => (
    <p className="my-3 leading-relaxed text-foreground/90">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 ps-6 text-foreground/90">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1 ps-6 text-foreground/90">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-s-4 border-primary/40 ps-4 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      className="text-primary underline-offset-2 hover:underline"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-border">
      <table className="min-w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-muted/50">{children}</thead>
  ),
  th: ({ children }) => (
    <th className="border-b border-border px-4 py-2 text-start text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-border/40 px-4 py-2 align-top text-foreground/90">
      {children}
    </td>
  ),
  hr: () => <hr className="my-6 border-border/40" />,
};

const REMARK_PLUGINS = [remarkGfm];

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function WikiPanel() {
  const { t } = useTranslation();
  const [activeFile, setActiveFile] = useState<string>(PAGES[0]?.file ?? '');
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Keyboard: Escape closes sidebar on mobile
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') setSidebarOpen(false);
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const content = useMemo(() => getPageContent(activeFile), [activeFile]);
  const activeTitle = PAGES.find((p) => p.file === activeFile)?.title ?? '';

  return (
    <div
      className="flex h-full overflow-hidden bg-background"
      dir="rtl"
      lang="ar"
      aria-label={t('wiki.panelAriaLabel', 'ويكي نسّاج')}
    >
      {/* Sidebar nav */}
      <nav
        aria-label={t('wiki.sidebarAriaLabel', 'فهرس الويكي')}
        className={`flex-shrink-0 overflow-y-auto border-e border-border/60 bg-muted/20 transition-all duration-200 ${
          sidebarOpen ? 'w-56 sm:w-64' : 'w-0 overflow-hidden'
        }`}
      >
        <div className="px-2 pb-4 pt-3">
          <ul role="list" className="space-y-0.5">
            {PAGES.map((page) => {
              const isActive = page.file === activeFile;
              return (
                <li key={page.file}>
                  <button
                    type="button"
                    onClick={() => setActiveFile(page.file)}
                    aria-current={isActive ? 'page' : undefined}
                    className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm transition-colors ${
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
        </div>
      </nav>

      {/* Content area */}
      <main
        className="flex min-w-0 flex-1 flex-col overflow-hidden"
        aria-label={activeTitle}
      >
        {/* Content toolbar */}
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2">
          <button
            type="button"
            onClick={() => setSidebarOpen((v) => !v)}
            aria-label={
              sidebarOpen
                ? t('wiki.closeSidebar', 'إخفاء الفهرس')
                : t('wiki.openSidebar', 'إظهار الفهرس')
            }
            aria-expanded={sidebarOpen}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <BookOpen className="h-4 w-4" aria-hidden="true" />
          </button>
          <h2 className="truncate text-sm font-semibold text-foreground">{activeTitle}</h2>
        </div>

        {/* Scrollable markdown body */}
        <div className="flex-1 overflow-y-auto px-6 py-6">
          {content !== null ? (
            <article
              className="prose prose-sm max-w-3xl text-right"
              lang="ar"
              dir="rtl"
            >
              <ReactMarkdown
                remarkPlugins={REMARK_PLUGINS}
                components={MARKDOWN_COMPONENTS}
              >
                {content}
              </ReactMarkdown>
            </article>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('wiki.pageNotFound', 'الصفحة غير موجودة')}
            </p>
          )}
        </div>
      </main>
    </div>
  );
}

/**
 * WikiSearchField — search input + results dropdown for the wiki sidebar.
 *
 * Responsibilities:
 *  - Render the search input with Search/X icons
 *  - Render a results list (role="listbox") beneath the input
 *  - Highlight the matched term inside snippets
 *  - Delegate all business logic to the parent via props / callbacks
 *
 * Intentionally a pure presentational component (no internal state) so the
 * parent (WikiPanel) can orchestrate Escape-key priority.
 */

import { useRef, useCallback } from 'react';
import { Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SearchMatch } from './useWikiSearch';

// ---------------------------------------------------------------------------
// Highlight helper
// ---------------------------------------------------------------------------

/**
 * Splits `text` around the first case-insensitive occurrence of `term` and
 * returns a <span> with <mark> wrapping the match.
 */
function HighlightedText({
  text,
  term,
}: {
  text: string;
  term: string;
}) {
  if (!term) return <>{text}</>;

  const lowerText = text.toLowerCase();
  const lowerTerm = term.toLowerCase();
  const idx = lowerText.indexOf(lowerTerm);
  if (idx === -1) return <>{text}</>;

  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + term.length);
  const after = text.slice(idx + term.length);

  return (
    <>
      {before}
      <mark className="rounded bg-primary/20 px-0.5 text-primary">{match}</mark>
      {after}
    </>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type WikiSearchFieldProps = {
  query: string;
  onQueryChange: (q: string) => void;
  onClear: () => void;
  results: SearchMatch[];
  isSearching: boolean;
  onSelectResult: (file: string) => void;
  /** Ref to forward focus back to the input after selecting a result */
  inputRef?: React.RefObject<HTMLInputElement>;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WikiSearchField({
  query,
  onQueryChange,
  onClear,
  results,
  isSearching,
  onSelectResult,
  inputRef: externalInputRef,
}: WikiSearchFieldProps) {
  const { t } = useTranslation();
  const internalRef = useRef<HTMLInputElement>(null);
  const inputRef = externalInputRef ?? internalRef;

  const handleSelect = useCallback(
    (file: string) => {
      onSelectResult(file);
      onClear();
      // Return focus to input so keyboard users can continue typing
      inputRef.current?.focus();
    },
    [onSelectResult, onClear, inputRef],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Escape is handled in WikiPanel (clears query first, then closes sidebar)
      // We only need to prevent default here so the event bubbles correctly.
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClear();
      }
    },
    [onClear],
  );

  const listboxId = 'wiki-search-listbox';
  const inputId = 'wiki-search-input';

  return (
    <div className="relative px-2 pb-2 pt-2">
      {/* ── Search input ── */}
      <div className="relative flex items-center">
        <Search
          className="pointer-events-none absolute start-2.5 h-3.5 w-3.5 text-muted-foreground"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          id={inputId}
          type="search"
          role="combobox"
          aria-expanded={isSearching && results.length > 0}
          aria-controls={listboxId}
          aria-label={t('wiki.searchAriaLabel', 'بحث في صفحات الويكي')}
          aria-autocomplete="list"
          autoComplete="off"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('wiki.searchPlaceholder', 'ابحث في الويكي…')}
          className={[
            'w-full rounded-md border border-border/60 bg-background py-1.5',
            'ps-8 pe-7 text-sm text-foreground placeholder:text-muted-foreground/70',
            'outline-none ring-offset-background',
            'focus:border-primary/50 focus:ring-1 focus:ring-primary/30',
            'transition-colors',
          ].join(' ')}
        />
        {query && (
          <button
            type="button"
            onClick={onClear}
            aria-label={t('wiki.searchClear', 'مسح البحث')}
            className="absolute end-1.5 rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* ── Results dropdown ── */}
      {isSearching && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={t('wiki.searchResultsAriaLabel', 'نتائج البحث')}
          className={[
            'absolute start-2 end-2 z-20 mt-1 overflow-y-auto rounded-lg border border-border/60',
            'bg-popover shadow-lg',
            results.length > 0 ? 'max-h-72' : '',
          ].join(' ')}
        >
          {results.length === 0 ? (
            <li
              role="option"
              aria-selected={false}
              className="px-3 py-3 text-center text-sm text-muted-foreground"
            >
              {t('wiki.searchNoResults', 'لا نتائج')}
            </li>
          ) : (
            results.map((match) => (
              <li key={match.file} role="option" aria-selected={false}>
                <button
                  type="button"
                  onClick={() => handleSelect(match.file)}
                  className={[
                    'flex w-full flex-col gap-0.5 px-3 py-2 text-start',
                    'hover:bg-accent/60 focus:bg-accent/60 focus:outline-none',
                    'transition-colors border-b border-border/30 last:border-b-0',
                  ].join(' ')}
                >
                  {/* Page title */}
                  <span className="text-sm font-medium text-foreground">
                    <HighlightedText text={match.title} term={match.matchedTerm} />
                  </span>
                  {/* Body snippet (if body matched) */}
                  {match.snippet && (
                    <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                      <HighlightedText text={match.snippet} term={match.matchedTerm} />
                    </span>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
      )}

      {/* Screen-reader count announcement */}
      {isSearching && results.length > 0 && (
        <p role="status" aria-live="polite" className="sr-only">
          {t('wiki.searchResultsCount', '{{count}} نتيجة', { count: results.length })}
        </p>
      )}
    </div>
  );
}

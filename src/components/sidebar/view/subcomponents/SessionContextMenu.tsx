import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { ExternalLink } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '../../../../lib/utils';
import { useRtl } from '../../../../contexts/RtlContext';

const MENU_WIDTH = 200;
const MENU_HEIGHT = 60;
const VIEWPORT_PADDING = 10;

type MenuPosition = { x: number; y: number };

/**
 * Clamp the menu inside the viewport. In RTL the menu grows toward the start
 * (the user's left in a mirrored layout), so we anchor its right edge to the
 * cursor; in LTR we anchor the left edge.
 */
function calculateMenuPosition(clientX: number, clientY: number, isRtl: boolean): MenuPosition {
  const anchoredX = isRtl ? clientX - MENU_WIDTH : clientX;
  const maxX = window.innerWidth - MENU_WIDTH - VIEWPORT_PADDING;
  const safeX = Math.min(Math.max(VIEWPORT_PADDING, anchoredX), Math.max(VIEWPORT_PADDING, maxX));

  const overflowsBottom = clientY + MENU_HEIGHT > window.innerHeight;
  const safeY = overflowsBottom ? window.innerHeight - MENU_HEIGHT - VIEWPORT_PADDING : clientY;

  return { x: safeX, y: Math.max(VIEWPORT_PADDING, safeY) };
}

type SessionContextMenuProps = {
  children: ReactNode;
  sessionUrl: string;
  t: TFunction;
};

/**
 * Right-click wrapper for a sidebar session row. Shows a custom context menu
 * with an "Open in new tab" action that targets the real session URL. The menu
 * closes on outside click or Escape, supports keyboard navigation, and respects
 * the app-wide RTL layout toggle.
 */
export default function SessionContextMenu({ children, sessionUrl, t }: SessionContextMenuProps) {
  const { rtlLayout } = useRtl();
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition>({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setIsOpen(false), []);

  const openMenuAtCursor = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setPosition(calculateMenuPosition(event.clientX, event.clientY, rtlLayout));
      setIsOpen(true);
    },
    [rtlLayout],
  );

  const openInNewTab = useCallback(() => {
    closeMenu();
    window.open(sessionUrl, '_blank', 'noopener,noreferrer');
  }, [closeMenu, sessionUrl]);

  // Move focus into the menu when it opens so keyboard users land on the action.
  useEffect(() => {
    if (isOpen) {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleOutsideMouseDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        closeMenu();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu();
      }
    };

    document.addEventListener('mousedown', handleOutsideMouseDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleOutsideMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeMenu, isOpen]);

  return (
    <>
      <div onContextMenu={openMenuAtCursor} className="contents">
        {children}
      </div>

      {isOpen && (
        <div
          ref={menuRef}
          role="menu"
          dir={rtlLayout ? 'rtl' : 'ltr'}
          aria-label={t('sessions.contextMenuLabel')}
          style={{ position: 'fixed', insetInlineStart: position.x, top: position.y, zIndex: 9999 }}
          className={cn(
            'min-w-[180px] px-1 py-1',
            'rounded-lg border border-border bg-popover shadow-lg',
            'animate-in fade-in-0 zoom-in-95',
          )}
        >
          <button
            role="menuitem"
            tabIndex={0}
            onClick={openInNewTab}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openInNewTab();
              }
            }}
            className={cn(
              'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm',
              'text-start transition-colors hover:bg-accent focus:bg-accent focus:outline-none',
            )}
          >
            <ExternalLink className="h-4 w-4 flex-shrink-0" />
            <span className="flex-1">{t('sessions.openInNewTab')}</span>
          </button>
        </div>
      )}
    </>
  );
}

import { useEffect, useReducer, useRef } from 'react';
import { onApplyServerPreference } from '../preferences/preferencesSync';

export type TabsDisplayMode = 'full' | 'compact' | 'minimal' | 'hidden';

const TABS_DISPLAY_MODES: readonly TabsDisplayMode[] = ['full', 'compact', 'minimal', 'hidden'];

type UiPreferences = {
  autoExpandTools: boolean;
  showRawParameters: boolean;
  showThinking: boolean;
  hideToolCalls: boolean;
  autoScrollToBottom: boolean;
  sendByCtrlEnter: boolean;
  sidebarVisible: boolean;
  // Source of truth for the header tab switcher: full (icons + text),
  // compact (icons only), minimal (tabs hidden, usage indicator visible),
  // or hidden (tab group and usage indicator both not rendered).
  tabsDisplayMode: TabsDisplayMode;
  // Derived mirror of `tabsDisplayMode === 'compact'`. Kept as a real, synced
  // preference so legacy consumers (the appearance "Compact tabs (icons only)"
  // checkbox, HeaderUsageIndicator, MainContentTabSwitcher) keep working with no
  // changes. The reducer reconciles it on every write so the two never drift.
  tabsIconOnly: boolean;
};

type UiPreferenceKey = keyof UiPreferences;

const parseTabsDisplayMode = (value: unknown, fallback: TabsDisplayMode): TabsDisplayMode => {
  if (typeof value === 'string' && (TABS_DISPLAY_MODES as readonly string[]).includes(value)) {
    return value as TabsDisplayMode;
  }
  return fallback;
};

type SetPreferenceAction = {
  type: 'set';
  key: UiPreferenceKey;
  value: unknown;
};

type SetManyPreferencesAction = {
  type: 'set_many';
  value?: Partial<Record<UiPreferenceKey, unknown>>;
};

type ResetPreferencesAction = {
  type: 'reset';
  value?: Partial<UiPreferences>;
};

type UiPreferencesAction =
  | SetPreferenceAction
  | SetManyPreferencesAction
  | ResetPreferencesAction;

const DEFAULTS: UiPreferences = {
  autoExpandTools: false,
  showRawParameters: false,
  showThinking: true,
  hideToolCalls: true,
  autoScrollToBottom: true,
  sendByCtrlEnter: false,
  sidebarVisible: true,
  tabsDisplayMode: 'full',
  tabsIconOnly: false,
};

const PREFERENCE_KEYS = Object.keys(DEFAULTS) as UiPreferenceKey[];
const VALID_KEYS = new Set<UiPreferenceKey>(PREFERENCE_KEYS); // prevents unknown keys from being written
const SYNC_EVENT = 'ui-preferences:sync';

type SyncEventDetail = {
  storageKey: string;
  sourceId: string;
  value: Partial<Record<UiPreferenceKey, unknown>>;
};

const parseBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }

  return fallback;
};

// Parses an arbitrary stored/incoming value for a single key, respecting its
// type (tabsDisplayMode is a string enum; everything else is boolean).
const parsePreferenceValue = <K extends UiPreferenceKey>(
  key: K,
  value: unknown,
  fallback: UiPreferences[K],
): UiPreferences[K] => {
  if (key === 'tabsDisplayMode') {
    return parseTabsDisplayMode(value, fallback as TabsDisplayMode) as UiPreferences[K];
  }
  return parseBoolean(value, fallback as boolean) as UiPreferences[K];
};

// Enforces the invariant tabsIconOnly === (tabsDisplayMode === 'compact').
// `lead` indicates which of the two keys the caller just wrote so the other is
// brought in line: writing tabsDisplayMode updates tabsIconOnly; toggling the
// legacy tabsIconOnly checkbox maps true->compact and false->full (never minimal
// or hidden, to preserve the existing two-state checkbox behaviour).
const reconcileTabsMode = (state: UiPreferences, lead: 'mode' | 'iconOnly'): UiPreferences => {
  if (lead === 'iconOnly') {
    // Checkbox: true→compact, false→full. minimal/hidden are unreachable from
    // the checkbox so the mapping stays a clean two-state toggle.
    const nextMode: TabsDisplayMode = state.tabsIconOnly ? 'compact' : 'full';
    return state.tabsDisplayMode === nextMode ? state : { ...state, tabsDisplayMode: nextMode };
  }
  // Mode is authoritative: tabsIconOnly mirrors compact only; full/minimal/hidden
  // all map to iconOnly=false.
  const nextIconOnly = state.tabsDisplayMode === 'compact';
  return state.tabsIconOnly === nextIconOnly ? state : { ...state, tabsIconOnly: nextIconOnly };
};

const readLegacyPreference = (key: UiPreferenceKey, fallback: boolean): boolean => {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;

    // Supports values written by both JSON.stringify and plain strings.
    const parsed = JSON.parse(raw);
    return parseBoolean(parsed, fallback);
  } catch {
    return fallback;
  }
};

const readInitialPreferences = (storageKey: string): UiPreferences => {
  if (typeof window === 'undefined') {
    return DEFAULTS;
  }

  try {
    const raw = localStorage.getItem(storageKey);

    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const parsedRecord = parsed as Record<string, unknown>;

        const next = PREFERENCE_KEYS.reduce((acc, key) => {
          (acc[key] as UiPreferences[typeof key]) = parsePreferenceValue(
            key,
            parsedRecord[key],
            DEFAULTS[key],
          );
          return acc;
        }, { ...DEFAULTS });

        // Stored value predating tabsDisplayMode carries only tabsIconOnly; let it
        // lead so the mode is derived. Otherwise the explicit mode is authoritative.
        const lead = 'tabsDisplayMode' in parsedRecord ? 'mode' : 'iconOnly';
        return reconcileTabsMode(next, lead);
      }
    }
  } catch {
    // Fall back to legacy keys when unified key is missing or invalid.
  }

  const legacy = PREFERENCE_KEYS.reduce((acc, key) => {
    if (key === 'tabsDisplayMode') {
      acc.tabsDisplayMode = DEFAULTS.tabsDisplayMode;
      return acc;
    }
    (acc[key] as boolean) = readLegacyPreference(key, DEFAULTS[key] as boolean);
    return acc;
  }, { ...DEFAULTS });

  // No legacy key for the new mode; derive it from the legacy tabsIconOnly flag.
  return reconcileTabsMode(legacy, 'iconOnly');
};

function reducer(state: UiPreferences, action: UiPreferencesAction): UiPreferences {
  switch (action.type) {
    case 'set': {
      const { key, value } = action;
      if (!VALID_KEYS.has(key)) {
        return state;
      }

      const nextValue = parsePreferenceValue(key, value, state[key]);
      if (state[key] === nextValue) {
        return state;
      }

      const nextState = { ...state, [key]: nextValue };
      if (key === 'tabsDisplayMode') {
        return reconcileTabsMode(nextState, 'mode');
      }
      if (key === 'tabsIconOnly') {
        return reconcileTabsMode(nextState, 'iconOnly');
      }
      return nextState;
    }
    case 'set_many': {
      const updates = action.value || {};
      let changed = false;
      const nextState = { ...state };

      for (const key of PREFERENCE_KEYS) {
        if (!(key in updates)) continue;

        const value = updates[key];
        const nextValue = parsePreferenceValue(key, value, state[key]);
        if (nextState[key] !== nextValue) {
          (nextState[key] as UiPreferences[typeof key]) = nextValue;
          changed = true;
        }
      }

      if (!changed) {
        return state;
      }

      // An external payload may carry an explicit mode (authoritative) or only the
      // legacy flag; let the mode lead when present, otherwise the flag.
      const lead = 'tabsDisplayMode' in updates ? 'mode' : 'iconOnly';
      return reconcileTabsMode(nextState, lead);
    }
    case 'reset':
      return reconcileTabsMode({ ...DEFAULTS, ...(action.value || {}) }, 'mode');
    default:
      return state;
  }
}

export function useUiPreferences(storageKey = 'uiPreferences') {
  const instanceIdRef = useRef(`ui-preferences-${Math.random().toString(36).slice(2)}`);
  const [state, dispatch] = useReducer(
    reducer,
    storageKey,
    readInitialPreferences
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    localStorage.setItem(storageKey, JSON.stringify(state));

    window.dispatchEvent(
      new CustomEvent<SyncEventDetail>(SYNC_EVENT, {
        detail: {
          storageKey,
          sourceId: instanceIdRef.current,
          value: state,
        },
      })
    );
  }, [state, storageKey]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const applyExternalUpdate = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return;
      }
      dispatch({ type: 'set_many', value: value as Partial<Record<UiPreferenceKey, unknown>> });
    };

    const handleStorageChange = (event: StorageEvent) => {
      if (event.key !== storageKey || event.newValue === null) {
        return;
      }

      try {
        const parsed = JSON.parse(event.newValue);
        applyExternalUpdate(parsed);
      } catch {
        // Ignore malformed storage updates.
      }
    };

    const handleSyncEvent = (event: Event) => {
      const syncEvent = event as CustomEvent<SyncEventDetail>;
      const detail = syncEvent.detail;
      if (!detail || detail.storageKey !== storageKey || detail.sourceId === instanceIdRef.current) {
        return;
      }

      applyExternalUpdate(detail.value);
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener(SYNC_EVENT, handleSyncEvent as EventListener);

    // Reflect an account-sourced value live after sign-in (server authoritative).
    const offApply = onApplyServerPreference(storageKey, (raw) => {
      if (raw === null) {
        return;
      }
      try {
        applyExternalUpdate(JSON.parse(raw));
      } catch {
        // Ignore malformed server value.
      }
    });

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener(SYNC_EVENT, handleSyncEvent as EventListener);
      offApply();
    };
  }, [storageKey]);

  const setPreference = (key: UiPreferenceKey, value: unknown) => {
    dispatch({ type: 'set', key, value });
  };

  const setPreferences = (value: Partial<Record<UiPreferenceKey, unknown>>) => {
    dispatch({ type: 'set_many', value });
  };

  const resetPreferences = (value?: Partial<UiPreferences>) => {
    dispatch({ type: 'reset', value });
  };

  return {
    preferences: state,
    setPreference,
    setPreferences,
    resetPreferences,
    dispatch,
  };
}

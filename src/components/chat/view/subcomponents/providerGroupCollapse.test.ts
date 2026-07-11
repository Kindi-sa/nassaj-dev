/**
 * Unit contract for the model-picker group collapse logic (T-871).
 *
 * Encodes the four behavioural rules from the task, all as pure-function
 * assertions (no DOM, no cmdk, no i18n): size default, selected-model
 * exception, stored-preference override, and search override — plus the
 * never-throw guarantees of the localStorage read/write helpers.
 */
import { describe, it, expect } from 'vitest';

import {
  COLLAPSE_STORAGE_KEY,
  DEFAULT_EXPAND_MAX,
  readCollapsedMap,
  writeCollapsedMap,
  resolveExpandedNoSearch,
  resolveGroupExpanded,
  type CollapsedMap,
} from './providerGroupCollapse';

describe('resolveExpandedNoSearch — default (no stored preference)', () => {
  it('starts a small group (≤ max) expanded', () => {
    expect(
      resolveExpandedNoSearch({
        storedCollapsed: undefined,
        modelCount: DEFAULT_EXPAND_MAX,
        containsSelected: false,
      }),
    ).toBe(true);
  });

  it('starts a large group (> max) collapsed', () => {
    expect(
      resolveExpandedNoSearch({
        storedCollapsed: undefined,
        modelCount: DEFAULT_EXPAND_MAX + 1,
        containsSelected: false,
      }),
    ).toBe(false);
  });

  it('keeps a large group expanded when it holds the selected model', () => {
    expect(
      resolveExpandedNoSearch({
        storedCollapsed: undefined,
        modelCount: 42,
        containsSelected: true,
      }),
    ).toBe(true);
  });
});

describe('resolveExpandedNoSearch — stored preference overrides the default', () => {
  it('a stored collapsed=true collapses even a tiny group', () => {
    expect(
      resolveExpandedNoSearch({
        storedCollapsed: true,
        modelCount: 1,
        containsSelected: false,
      }),
    ).toBe(false);
  });

  it('a stored collapsed=false expands even a large group', () => {
    expect(
      resolveExpandedNoSearch({
        storedCollapsed: false,
        modelCount: 99,
        containsSelected: false,
      }),
    ).toBe(true);
  });

  it('a stored collapsed=true wins over the selected-model exception', () => {
    // The user explicitly collapsed the group after selecting a model in it;
    // their choice must survive (localStorage overrides the default).
    expect(
      resolveExpandedNoSearch({
        storedCollapsed: true,
        modelCount: 10,
        containsSelected: true,
      }),
    ).toBe(false);
  });
});

describe('resolveGroupExpanded — search overrides collapse', () => {
  it('forces a large, unselected, non-stored group open while searching', () => {
    expect(
      resolveGroupExpanded({
        storedCollapsed: undefined,
        modelCount: 30,
        containsSelected: false,
        isSearching: true,
      }),
    ).toBe(true);
  });

  it('forces a user-collapsed group open while searching', () => {
    expect(
      resolveGroupExpanded({
        storedCollapsed: true,
        modelCount: 30,
        containsSelected: false,
        isSearching: true,
      }),
    ).toBe(true);
  });

  it('defers to the collapsed state once the search clears', () => {
    expect(
      resolveGroupExpanded({
        storedCollapsed: true,
        modelCount: 30,
        containsSelected: false,
        isSearching: false,
      }),
    ).toBe(false);
  });
});

/** In-memory Storage stub exposing only getItem/setItem. */
function makeStorage(seed?: string): Pick<Storage, 'getItem' | 'setItem'> {
  let value: string | null = seed ?? null;
  return {
    getItem: (key: string) => (key === COLLAPSE_STORAGE_KEY ? value : null),
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

describe('readCollapsedMap / writeCollapsedMap', () => {
  it('round-trips a map through storage', () => {
    const storage = makeStorage();
    const map: CollapsedMap = { opencode: true, antigravity: false };
    writeCollapsedMap(map, storage);
    expect(readCollapsedMap(storage)).toEqual(map);
  });

  it('returns an empty map for a cold storage (no key set)', () => {
    expect(readCollapsedMap(makeStorage())).toEqual({});
  });

  it('returns an empty map for malformed JSON instead of throwing', () => {
    expect(readCollapsedMap(makeStorage('{not json'))).toEqual({});
  });

  it('drops non-boolean and array/object shapes defensively', () => {
    const storage = makeStorage(
      JSON.stringify({ opencode: true, bogus: 'yes', nested: { x: 1 }, n: 3 }),
    );
    expect(readCollapsedMap(storage)).toEqual({ opencode: true });
  });

  it('treats a JSON array as empty (not a valid map)', () => {
    expect(readCollapsedMap(makeStorage('[1,2,3]'))).toEqual({});
  });

  it('is a no-op (no throw) when storage is null', () => {
    expect(() => writeCollapsedMap({ a: true }, null)).not.toThrow();
    expect(readCollapsedMap(null)).toEqual({});
  });
});

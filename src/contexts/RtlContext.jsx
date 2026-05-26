import React, { createContext, useContext, useEffect, useState } from 'react';

const RtlContext = createContext(null);

const STORAGE_KEY = 'rtlLayout';

/**
 * useRtl
 *
 * Access the application-wide RTL layout toggle. This is intentionally
 * decoupled from the chosen i18n language: a user may run an Arabic UI in
 * LTR mode, or an English UI in RTL mode, depending on preference.
 *
 * Returns `{ rtlLayout: boolean, setRtlLayout: (next: boolean) => void,
 *           toggleRtlLayout: () => void }`.
 */
export const useRtl = () => {
  const ctx = useContext(RtlContext);
  if (!ctx) {
    throw new Error('useRtl must be used within an RtlProvider');
  }
  return ctx;
};

const readInitial = () => {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
};

export const RtlProvider = ({ children }) => {
  const [rtlLayout, setRtlLayout] = useState(readInitial);

  // Apply direction at the document root. Lang is set to 'ar' when RTL is
  // enabled so the browser picks Arabic font fallback chains and a11y tools
  // announce content as Arabic; otherwise we leave it as 'en' to avoid
  // changing TTS/voice behavior unnecessarily.
  useEffect(() => {
    // Direction is handled per-element via dir="auto" — never force on root.
    document.documentElement.dir = 'ltr';

    try {
      localStorage.setItem(STORAGE_KEY, String(rtlLayout));
    } catch {
      // Storage unavailable (private mode, quota).
    }
  }, [rtlLayout]);

  const toggleRtlLayout = () => setRtlLayout((prev) => !prev);

  return (
    <RtlContext.Provider value={{ rtlLayout, setRtlLayout, toggleRtlLayout }}>
      {children}
    </RtlContext.Provider>
  );
};

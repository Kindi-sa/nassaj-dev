import React, { createContext, useContext, useEffect, useState } from 'react';

/**
 * @typedef {Object} ParticipantsBarContextValue
 * @property {boolean} showParticipantsBar
 * @property {(next: boolean) => void} setShowParticipantsBar
 * @property {() => void} toggleParticipantsBar
 */

/** @type {import('react').Context<ParticipantsBarContextValue | null>} */
const ParticipantsBarContext = createContext(null);

const STORAGE_KEY = 'showParticipantsBar';

/**
 * useParticipantsBar
 *
 * Access the application-wide "show participants bar" preference. This is a
 * pure UI preference (does not affect any network/identity behaviour) stored
 * in localStorage. Defaults to `true` so existing users see no behaviour
 * change; turning it off prevents the bar — and therefore its hook/polling —
 * from mounting at all.
 *
 * Returns `{ showParticipantsBar: boolean,
 *            setShowParticipantsBar: (next: boolean) => void,
 *            toggleParticipantsBar: () => void }`.
 */
export const useParticipantsBar = () => {
  const ctx = useContext(ParticipantsBarContext);
  if (!ctx) {
    throw new Error('useParticipantsBar must be used within a ParticipantsBarProvider');
  }
  return ctx;
};

const readInitial = () => {
  try {
    // Default ON: only an explicit 'false' disables the bar.
    return localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
};

export const ParticipantsBarProvider = ({ children }) => {
  const [showParticipantsBar, setShowParticipantsBar] = useState(readInitial);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(showParticipantsBar));
    } catch {
      // Storage unavailable (private mode, quota).
    }
  }, [showParticipantsBar]);

  const toggleParticipantsBar = () => setShowParticipantsBar((prev) => !prev);

  return (
    <ParticipantsBarContext.Provider
      value={{ showParticipantsBar, setShowParticipantsBar, toggleParticipantsBar }}
    >
      {children}
    </ParticipantsBarContext.Provider>
  );
};

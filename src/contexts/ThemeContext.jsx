import React, { createContext, useContext, useState, useEffect } from 'react';
import {
  loadThemePresetState,
  saveThemePresetState,
  applyThemePreset,
} from '../lib/theme-presets';

const ThemeContext = createContext();

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

export const ThemeProvider = ({ children }) => {
  // Check for saved theme preference or default to system preference
  const [isDarkMode, setIsDarkMode] = useState(() => {
    // Check localStorage first
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
      return savedTheme === 'dark';
    }
    
    // Check system preference
    if (window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    
    return false;
  });

  // Update document class and localStorage when theme changes
  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
      
      // Update iOS status bar style and theme color for dark mode
      const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
      if (statusBarMeta) {
        statusBarMeta.setAttribute('content', 'black-translucent');
      }
      
      const themeColorMeta = document.querySelector('meta[name="theme-color"]');
      if (themeColorMeta) {
        themeColorMeta.setAttribute('content', '#0c1117'); // Dark background color (hsl(222.2 84% 4.9%))
      }
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
      
      // Update iOS status bar style and theme color for light mode
      const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
      if (statusBarMeta) {
        statusBarMeta.setAttribute('content', 'default');
      }
      
      const themeColorMeta = document.querySelector('meta[name="theme-color"]');
      if (themeColorMeta) {
        themeColorMeta.setAttribute('content', '#ffffff'); // Light background color
      }
    }
  }, [isDarkMode]);

  // Listen for system theme changes
  useEffect(() => {
    if (!window.matchMedia) return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e) => {
      // Only update if user hasn't manually set a preference
      const savedTheme = localStorage.getItem('theme');
      if (!savedTheme) {
        setIsDarkMode(e.matches);
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  const toggleDarkMode = () => {
    setIsDarkMode(prev => !prev);
  };

  // Brand-tinted theme presets (see src/lib/theme-presets.ts). The preset is
  // applied on top of light/dark mode and re-derived whenever either changes.
  const [presetState, setPresetState] = useState(loadThemePresetState);

  useEffect(() => {
    applyThemePreset(presetState, isDarkMode);
    saveThemePresetState(presetState);
  }, [presetState, isDarkMode]);

  const setThemePreset = (preset) => {
    setPresetState(prev => ({ ...prev, preset }));
  };

  const setCustomThemeColors = (patch) => {
    setPresetState(prev => ({ ...prev, custom: { ...prev.custom, ...patch } }));
  };

  const value = {
    isDarkMode,
    toggleDarkMode,
    themePreset: presetState.preset,
    customThemeColors: presetState.custom,
    setThemePreset,
    setCustomThemeColors,
  };

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
};
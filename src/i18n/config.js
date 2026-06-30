/**
 * i18n Configuration
 *
 * Configures i18next for internationalization support.
 * Features:
 * - Lazy-loading of translation namespaces
 * - Language detection from localStorage
 * - Fallback to English for missing translations
 * - Development mode warnings for missing keys
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// Import translation resources
import enCommon from './locales/en/common.json';
import enSettings from './locales/en/settings.json';
import enAuth from './locales/en/auth.json';
import enSidebar from './locales/en/sidebar.json';
import enChat from './locales/en/chat.json';
import enCodeEditor from './locales/en/codeEditor.json';
import enTasks from './locales/en/tasks.json';
import enPresence from './locales/en/presence.json';
// eslint-disable-next-line import-x/order
import enProjectBoard from './locales/en/projectBoard.json';

import arCommon from './locales/ar/common.json';
import arSettings from './locales/ar/settings.json';
import arAuth from './locales/ar/auth.json';
import arSidebar from './locales/ar/sidebar.json';
import arChat from './locales/ar/chat.json';
import arCodeEditor from './locales/ar/codeEditor.json';
import arTasks from './locales/ar/tasks.json';
import arPresence from './locales/ar/presence.json';
// eslint-disable-next-line import-x/order
import arProjectBoard from './locales/ar/projectBoard.json';

import koCommon from './locales/ko/common.json';
import koSettings from './locales/ko/settings.json';
import koAuth from './locales/ko/auth.json';
import koSidebar from './locales/ko/sidebar.json';
import koChat from './locales/ko/chat.json';
import koCodeEditor from './locales/ko/codeEditor.json';
// eslint-disable-next-line import-x/order
import koProjectBoard from './locales/ko/projectBoard.json';

import zhCommon from './locales/zh-CN/common.json';
import zhSettings from './locales/zh-CN/settings.json';
import zhAuth from './locales/zh-CN/auth.json';
import zhSidebar from './locales/zh-CN/sidebar.json';
import zhChat from './locales/zh-CN/chat.json';
import zhCodeEditor from './locales/zh-CN/codeEditor.json';
// eslint-disable-next-line import-x/order
import zhProjectBoard from './locales/zh-CN/projectBoard.json';

import jaCommon from './locales/ja/common.json';
import jaSettings from './locales/ja/settings.json';
import jaAuth from './locales/ja/auth.json';
import jaSidebar from './locales/ja/sidebar.json';
import jaChat from './locales/ja/chat.json';
import jaCodeEditor from './locales/ja/codeEditor.json';
import jaTasks from './locales/ja/tasks.json';
// eslint-disable-next-line import-x/order
import jaProjectBoard from './locales/ja/projectBoard.json';

import ruCommon from './locales/ru/common.json';
import ruSettings from './locales/ru/settings.json';
import ruAuth from './locales/ru/auth.json';
import ruSidebar from './locales/ru/sidebar.json';
import ruChat from './locales/ru/chat.json';
import ruCodeEditor from './locales/ru/codeEditor.json';
import ruTasks from './locales/ru/tasks.json';
// eslint-disable-next-line import-x/order
import ruProjectBoard from './locales/ru/projectBoard.json';

import deCommon from './locales/de/common.json';
import deSettings from './locales/de/settings.json';
import deAuth from './locales/de/auth.json';
import deSidebar from './locales/de/sidebar.json';
import deChat from './locales/de/chat.json';
import deCodeEditor from './locales/de/codeEditor.json';
import deTasks from './locales/de/tasks.json';
// eslint-disable-next-line import-x/order
import deProjectBoard from './locales/de/projectBoard.json';

import trCommon from './locales/tr/common.json';
import trSettings from './locales/tr/settings.json';
import trAuth from './locales/tr/auth.json';
import trSidebar from './locales/tr/sidebar.json';
import trChat from './locales/tr/chat.json';
import trCodeEditor from './locales/tr/codeEditor.json';
import trTasks from './locales/tr/tasks.json';
import trProjectBoard from './locales/tr/projectBoard.json';
import itCommon from './locales/it/common.json';
import itSettings from './locales/it/settings.json';
import itAuth from './locales/it/auth.json';
import itSidebar from './locales/it/sidebar.json';
import itChat from './locales/it/chat.json';
import itCodeEditor from './locales/it/codeEditor.json';
import itTasks from './locales/it/tasks.json';
// eslint-disable-next-line import-x/order
import itProjectBoard from './locales/it/projectBoard.json';

// Import supported languages configuration
import { languages, FALLBACK_UI_LANGUAGE } from './languages.js';

const isSupportedLanguage = (value) => languages.some((lang) => lang.value === value);

// Resolve the language to start the UI in:
// - stored value that is still selectable  → use it
// - stored value no longer selectable (e.g. an old de/it/ko/ru/zh-CN/tr/ja)
//   → fall back to Arabic (app is Arabic-first), not English
// - no stored value at all (fresh visitor) → keep the historical English default
const getSavedLanguage = () => {
  try {
    const saved = localStorage.getItem('userLanguage');
    if (saved && isSupportedLanguage(saved)) {
      return saved;
    }
    if (saved) {
      // A previously selected, now-disabled language: drop the dead pref onto ar
      // so the picker (which only lists ar/en) and the active UI agree.
      return FALLBACK_UI_LANGUAGE;
    }
    return 'en';
  } catch {
    return 'en';
  }
};

// Initialize i18next
i18n
  .use(LanguageDetector) // Detect user language
  .use(initReactI18next) // Pass i18n instance to react-i18next
  .init({
    // Resources containing all translations
    resources: {
      en: {
        common: enCommon,
        settings: enSettings,
        auth: enAuth,
        sidebar: enSidebar,
        chat: enChat,
        codeEditor: enCodeEditor,
        tasks: enTasks,
        presence: enPresence,
        projectBoard: enProjectBoard,
      },
      ar: {
        common: arCommon,
        settings: arSettings,
        auth: arAuth,
        sidebar: arSidebar,
        chat: arChat,
        codeEditor: arCodeEditor,
        tasks: arTasks,
        presence: arPresence,
        projectBoard: arProjectBoard,
      },
      ko: {
        common: koCommon,
        settings: koSettings,
        auth: koAuth,
        sidebar: koSidebar,
        chat: koChat,
        codeEditor: koCodeEditor,
        projectBoard: koProjectBoard,
      },
      'zh-CN': {
        common: zhCommon,
        settings: zhSettings,
        auth: zhAuth,
        sidebar: zhSidebar,
        chat: zhChat,
        codeEditor: zhCodeEditor,
        projectBoard: zhProjectBoard,
      },
      ja: {
        common: jaCommon,
        settings: jaSettings,
        auth: jaAuth,
        sidebar: jaSidebar,
        chat: jaChat,
        codeEditor: jaCodeEditor,
        tasks: jaTasks,
        projectBoard: jaProjectBoard,
      },
      ru: {
        common: ruCommon,
        settings: ruSettings,
        auth: ruAuth,
        sidebar: ruSidebar,
        chat: ruChat,
        codeEditor: ruCodeEditor,
        tasks: ruTasks,
        projectBoard: ruProjectBoard,
      },
      de: {
        common: deCommon,
        settings: deSettings,
        auth: deAuth,
        sidebar: deSidebar,
        chat: deChat,
        codeEditor: deCodeEditor,
        tasks: deTasks,
        projectBoard: deProjectBoard,
      },
      tr: {
        common: trCommon,
        settings: trSettings,
        auth: trAuth,
        sidebar: trSidebar,
        chat: trChat,
        codeEditor: trCodeEditor,
        tasks: trTasks,
        projectBoard: trProjectBoard,
      },
      it: {
        common: itCommon,
        settings: itSettings,
        auth: itAuth,
        sidebar: itSidebar,
        chat: itChat,
        codeEditor: itCodeEditor,
        tasks: itTasks,
        projectBoard: itProjectBoard,
      },
    },

    // Default language
    lng: getSavedLanguage(),

    // Fallback language when a translation is missing
    fallbackLng: 'en',

    // Enable debug mode in development (logs missing keys to console)
    debug: false,

    // Namespaces - load only what's needed
    ns: ['common', 'settings', 'auth', 'sidebar', 'chat', 'codeEditor', 'tasks', 'presence', 'projectBoard'],
    defaultNS: 'common',

    // Key separator for nested keys (default: '.')
    keySeparator: '.',

    // Namespace separator (default: ':')
    nsSeparator: ':',

    // Save missing translations (disabled - requires manual review)
    saveMissing: false,

    // Interpolation settings
    interpolation: {
      escapeValue: false, // React already escapes values
    },

    // React-specific settings
    react: {
      useSuspense: true, // Use Suspense for lazy-loading
      bindI18n: 'languageChanged', // Re-render on language change
      bindI18nStore: false, // Don't re-render on resource changes
    },

    // Detection options
    detection: {
      // Order of language detection (local storage first)
      order: ['localStorage'],

      // Keys to look for in localStorage
      lookupLocalStorage: 'userLanguage',

      // Cache user language
      caches: ['localStorage'],
    },
  });

// Save language preference when it changes
i18n.on('languageChanged', (lng) => {
  try {
    localStorage.setItem('userLanguage', lng);
  } catch (error) {
    console.error('Failed to save language preference:', error);
  }
});

// Apply an account-sourced language live when the preferences sync layer
// hydrates it after sign-in (server is authoritative — no reload). The
// localStorage value is already written by the time this fires; changeLanguage
// only re-renders the UI. Guarded against unsupported values and no-op changes.
if (typeof window !== 'undefined') {
  window.addEventListener('preferences:apply', (event) => {
    const detail = event.detail;
    if (!detail || detail.storageKey !== 'userLanguage') {
      return;
    }
    // A server-synced value that is no longer selectable (old de/it/ko/…) is
    // coerced to Arabic so account-driven hydration matches the ar/en picker.
    const next = detail.rawValue
      ? (isSupportedLanguage(detail.rawValue) ? detail.rawValue : FALLBACK_UI_LANGUAGE)
      : null;
    if (next && i18n.language !== next) {
      i18n.changeLanguage(next);
    }
  });
}

export default i18n;

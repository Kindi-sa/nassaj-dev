/**
 * Supported Languages Configuration
 *
 * This file contains the list of supported languages for the application.
 * Each language includes:
 * - value: Language code (e.g., 'en', 'zh-CN')
 * - label: Display name in English
 * - nativeName: Native language name for display
 * - dir: (optional) preferred text direction hint for this language ('ltr' | 'rtl').
 *        Note: actual UI direction is controlled by the standalone RTL toggle in
 *        Appearance settings — language selection does NOT change direction.
 */

export const languages = [
  {
    value: 'en',
    label: 'English',
    nativeName: 'English',
    dir: 'ltr',
  },
  {
    value: 'ar',
    label: 'Arabic',
    nativeName: 'العربية',
    dir: 'rtl',
  },
  {
    value: 'ko',
    label: 'Korean',
    nativeName: '한국어',
    dir: 'ltr',
  },
  {
    value: 'zh-CN',
    label: 'Simplified Chinese',
    nativeName: '简体中文',
    dir: 'ltr',
  },
  {
    value: 'ja',
    label: 'Japanese',
    nativeName: '日本語',
    dir: 'ltr',
  },
  {
    value: 'ru',
    label: 'Russian',
    nativeName: 'Русский',
    dir: 'ltr',
  },
  {
    value: 'de',
    label: 'German',
    nativeName: 'Deutsch',
    dir: 'ltr',
  },
  {
    value: 'tr',
    label: 'Turkish',
    nativeName: 'Türkçe',
    dir: 'ltr',
  },
  {
    value: 'it',
    label: 'Italian',
    nativeName: 'Italiano',
    dir: 'ltr',
  },
];

/**
 * Get language object by value
 * @param {string} value - Language code
 * @returns {Object|undefined} Language object or undefined if not found
 */
export const getLanguage = (value) => {
  return languages.find(lang => lang.value === value);
};

/**
 * Get all language values
 * @returns {string[]} Array of language codes
 */
export const getLanguageValues = () => {
  return languages.map(lang => lang.value);
};

/**
 * Check if a language is supported
 * @param {string} value - Language code to check
 * @returns {boolean} True if language is supported
 */
export const isLanguageSupported = (value) => {
  return languages.some(lang => lang.value === value);
};

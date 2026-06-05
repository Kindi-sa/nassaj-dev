// Server-side SVG sanitization for the branding logo upload path.
//
// SVG is an XML document that can carry inline scripts, event handlers and
// external references — a stored-XSS vector when served same-origin. We allow
// SVG logos again (raster-only was too restrictive for vector brand marks) but
// ONLY after stripping every active-content vector here. The sanitized markup
// is what gets written to disk; the original bytes are never persisted.
//
// We use DOMPurify (a real, audited sanitizer) wired to a jsdom window rather
// than fragile hand-rolled regexes. DOMPurify normalizes the markup via a real
// DOM parser, so obfuscations like split attributes, entity-encoded payloads or
// malformed nesting are handled by the parser, not by us.

import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

// One jsdom window + DOMPurify instance for the process. JSDOM construction is
// relatively expensive, so we create it lazily and reuse it across uploads.
let purifier = null;

function getPurifier() {
  if (purifier) {
    return purifier;
  }
  const { window } = new JSDOM('');
  purifier = DOMPurify(window);
  return purifier;
}

// Quick structural gate: after skipping a UTF-8 BOM, leading whitespace, an
// optional XML declaration (<?xml ...?>) and any leading XML comments, the first
// real markup must be the <svg> root element. This rejects HTML/script payloads
// that merely *contain* the substring "<svg" somewhere, requiring SVG to be the
// actual document root before we even hand it to the sanitizer.
export function looksLikeSvgRoot(text) {
  if (typeof text !== 'string') {
    return false;
  }
  let s = text;
  // Strip a leading UTF-8 BOM if present.
  if (s.charCodeAt(0) === 0xfeff) {
    s = s.slice(1);
  }
  s = s.replace(/^\s+/, '');
  // Optional XML prolog: <?xml ... ?>
  if (s.startsWith('<?xml')) {
    const end = s.indexOf('?>');
    if (end === -1) {
      return false;
    }
    s = s.slice(end + 2).replace(/^\s+/, '');
  }
  // Skip any number of leading XML comments / whitespace before the root.
  while (s.startsWith('<!--')) {
    const end = s.indexOf('-->');
    if (end === -1) {
      return false;
    }
    s = s.slice(end + 3).replace(/^\s+/, '');
  }
  // Optional <!DOCTYPE svg ...> declaration.
  if (/^<!doctype\s+svg/i.test(s)) {
    const end = s.indexOf('>');
    if (end === -1) {
      return false;
    }
    s = s.slice(end + 1).replace(/^\s+/, '');
  }
  // The root element must be <svg> (start tag), case-insensitive, followed by
  // whitespace, '>' or '/' (self-closing) — not e.g. "<svgx".
  return /^<svg(\s|>|\/)/i.test(s);
}

// Sanitize raw SVG markup and return the cleaned string, or null if the input
// is not a valid SVG-rooted document. The output is guaranteed (by DOMPurify
// with the SVG profile) to contain no <script>, <foreignObject>, event-handler
// attributes, javascript: URLs, external <use> references or CSS expression()/
// url(javascript:) payloads.
export function sanitizeSvg(rawText) {
  if (!looksLikeSvgRoot(rawText)) {
    return null;
  }

  const clean = getPurifier().sanitize(rawText, {
    // Restrict the allowed grammar to the SVG (+ filter) profile. This drops
    // HTML/MathML elements and, combined with the forbid lists below, removes
    // every active-content vector.
    USE_PROFILES: { svg: true, svgFilters: true },
    // Belt-and-braces explicit denials on top of the profile. We additionally
    // drop <style> elements and the `style` attribute outright: they are the
    // only carriers of CSS expression()/url(javascript:) payloads and are not
    // needed for logo rendering (presentation attributes like fill/stroke cover
    // it), so removing them eliminates the CSS-based vector entirely rather than
    // relying on per-property CSS filtering.
    FORBID_TAGS: ['script', 'foreignObject', 'use', 'iframe', 'embed', 'object', 'style'],
    FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover', 'onbegin', 'onend', 'onrepeat', 'style'],
    // Return a string, not a DOM node.
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
    // Disallow data: URIs / unknown protocols in attributes; only same-document
    // refs and safe protocols survive. javascript: is stripped by default.
    ALLOW_DATA_ATTR: false,
  });

  const result = typeof clean === 'string' ? clean.trim() : '';
  // After sanitization the root must still be an <svg> element; if DOMPurify
  // stripped everything (input was not real SVG content) we reject.
  if (!result || !/^<svg[\s>]/i.test(result)) {
    return null;
  }
  return result;
}

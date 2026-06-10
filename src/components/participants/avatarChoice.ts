/**
 * Avatar identity choices (C-MU-UX-AVATAR-PICK).
 *
 * The `users.avatar_url` column is a single free-text string that already
 * propagates to every avatar surface (sidebar, presence, messages) via the
 * participant/presence queries. To avoid a schema change we overload that one
 * field to carry three kinds of identity, distinguished by their prefix:
 *
 *   1. `/avatars/<id>.<ext>` or `http(s)://…`  — uploaded image (existing).
 *   2. `data:image/svg+xml,…`                  — a generated gallery avatar.
 *   3. `color:<paletteId>`                     — a chosen colour for the
 *                                                lettered (initial) avatar.
 *
 * Forms 1 and 2 are valid image URLs and render through the existing `<img>`
 * path unchanged. Form 3 is a sentinel that `ParticipantAvatar` interprets to
 * paint a specific palette colour behind the username initial instead of the
 * deterministic userId-derived colour.
 *
 * Everything here is pure (no React) so it can be shared by the display
 * component and the profile picker, and is safe to mirror on the server for
 * validation.
 */

export const AVATAR_COLOR_PREFIX = 'color:';

/**
 * Curated palette for the colour picker and the gallery backgrounds. Each
 * entry pairs a Tailwind background class (for the lettered avatar) with the
 * matching hex (for SVG generation), chosen for >= 4.5:1 contrast against
 * white text.
 */
export const AVATAR_COLORS = [
  { id: 'rose', className: 'bg-rose-500', hex: '#f43f5e' },
  { id: 'orange', className: 'bg-orange-500', hex: '#f97316' },
  { id: 'amber', className: 'bg-amber-600', hex: '#d97706' },
  { id: 'emerald', className: 'bg-emerald-600', hex: '#059669' },
  { id: 'teal', className: 'bg-teal-600', hex: '#0d9488' },
  { id: 'cyan', className: 'bg-cyan-600', hex: '#0891b2' },
  { id: 'sky', className: 'bg-sky-600', hex: '#0284c7' },
  { id: 'blue', className: 'bg-blue-600', hex: '#2563eb' },
  { id: 'indigo', className: 'bg-indigo-600', hex: '#4f46e5' },
  { id: 'violet', className: 'bg-violet-600', hex: '#7c3aed' },
  { id: 'fuchsia', className: 'bg-fuchsia-600', hex: '#c026d3' },
  { id: 'pink', className: 'bg-pink-600', hex: '#db2777' },
] as const;

export type AvatarColorId = (typeof AVATAR_COLORS)[number]['id'];

const COLOR_BY_ID = new Map<string, (typeof AVATAR_COLORS)[number]>(
  AVATAR_COLORS.map((c) => [c.id, c]),
);

/** Builds the sentinel value stored in `avatar_url` for a colour choice. */
export function avatarColorValue(id: AvatarColorId): string {
  return `${AVATAR_COLOR_PREFIX}${id}`;
}

/**
 * If `avatarUrl` encodes a colour choice, returns its Tailwind background
 * class; otherwise null. Used by the display component to decide whether to
 * paint a chosen colour rather than the deterministic one.
 */
export function colorClassFromAvatarUrl(avatarUrl: string | null | undefined): string | null {
  if (!avatarUrl || !avatarUrl.startsWith(AVATAR_COLOR_PREFIX)) {
    return null;
  }
  const id = avatarUrl.slice(AVATAR_COLOR_PREFIX.length);
  return COLOR_BY_ID.get(id)?.className ?? null;
}

/** True when the stored value is one of our colour sentinels (not an image). */
export function isAvatarColorValue(avatarUrl: string | null | undefined): boolean {
  return typeof avatarUrl === 'string' && colorClassFromAvatarUrl(avatarUrl) !== null;
}

// ---------------------------------------------------------------------------
// Generated gallery avatars
// ---------------------------------------------------------------------------

/**
 * A small library of geometric SVG avatars rendered as self-contained
 * `data:` URIs. No network assets, no binary blobs — each avatar is a couple of
 * shapes over a coloured disc, so the gallery stays light and themable.
 */

type ShapeBuilder = (fg: string) => string;

// Each shape is drawn in a 64x64 viewBox, centred. `fg` is the foreground
// (always white at low opacity for legibility on any background colour).
const SHAPES: { id: string; build: ShapeBuilder }[] = [
  {
    id: 'circle',
    build: (fg) => `<circle cx="32" cy="32" r="14" fill="${fg}"/>`,
  },
  {
    id: 'ring',
    build: (fg) =>
      `<circle cx="32" cy="32" r="15" fill="none" stroke="${fg}" stroke-width="6"/>`,
  },
  {
    id: 'triangle',
    build: (fg) => `<path d="M32 16 L48 46 L16 46 Z" fill="${fg}"/>`,
  },
  {
    id: 'diamond',
    build: (fg) => `<path d="M32 14 L50 32 L32 50 L14 32 Z" fill="${fg}"/>`,
  },
  {
    id: 'square',
    build: (fg) => `<rect x="20" y="20" width="24" height="24" rx="4" fill="${fg}"/>`,
  },
  {
    id: 'star',
    build: (fg) =>
      `<path d="M32 14 L37 27 L51 27 L40 36 L44 49 L32 41 L20 49 L24 36 L13 27 L27 27 Z" fill="${fg}"/>`,
  },
  {
    id: 'hexagon',
    build: (fg) => `<path d="M32 14 L48 23 L48 41 L32 50 L16 41 L16 23 Z" fill="${fg}"/>`,
  },
  {
    id: 'drops',
    build: (fg) =>
      `<circle cx="24" cy="26" r="7" fill="${fg}"/><circle cx="40" cy="26" r="7" fill="${fg}"/><circle cx="32" cy="42" r="7" fill="${fg}"/>`,
  },
];

function buildSvg(hex: string, shape: ShapeBuilder): string {
  const fg = 'rgba(255,255,255,0.92)';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">` +
    `<rect width="64" height="64" rx="32" fill="${hex}"/>` +
    shape(fg) +
    `</svg>`
  );
}

/** Encodes an SVG string as a compact, URL-safe `data:` URI. */
function svgToDataUri(svg: string): string {
  // encodeURIComponent keeps the SVG readable and avoids base64 bloat. The
  // commas/parentheses are left as-is (valid in data URIs) for brevity.
  const encoded = encodeURIComponent(svg)
    .replace(/%20/g, ' ')
    .replace(/%3D/g, '=')
    .replace(/%3A/g, ':')
    .replace(/%2F/g, '/')
    .replace(/%22/g, "'");
  return `data:image/svg+xml,${encoded}`;
}

export type GalleryAvatar = {
  /** Stable id: `<shape>-<color>`; used only for React keys / selection state. */
  id: string;
  /** The `data:` URI to store in avatar_url and render as an <img>. */
  url: string;
};

/**
 * The full gallery: a curated cross-section of shape x colour combinations.
 * Capped to a pleasant, scannable grid rather than the full Cartesian product.
 */
export const GALLERY_AVATARS: GalleryAvatar[] = SHAPES.flatMap((shape, shapeIndex) => {
  // Pair each shape with three evenly-spaced palette colours so the grid shows
  // variety in both shape and hue without ballooning to 96 cells.
  const offsets = [0, 4, 8];
  return offsets.map((offset) => {
    const color = AVATAR_COLORS[(shapeIndex + offset) % AVATAR_COLORS.length];
    return {
      id: `${shape.id}-${color.id}`,
      url: svgToDataUri(buildSvg(color.hex, shape.build)),
    };
  });
});

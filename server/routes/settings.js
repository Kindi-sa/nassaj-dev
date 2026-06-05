import fs from 'fs';
import os from 'os';
import path from 'path';

import express from 'express';
import multer from 'multer';

import { apiKeysDb, credentialsDb, notificationPreferencesDb, pushSubscriptionsDb, appConfigDb } from '../modules/database/index.js';
import { requireRole } from '../middleware/auth.js';
import { getPublicKey } from '../services/vapid-keys.js';
import { createNotificationEvent, notifyUserIfEnabled } from '../services/notification-orchestrator.js';
import { sanitizeSvg, looksLikeSvgRoot } from '../services/svg-sanitizer.js';

const router = express.Router();

// ===============================
// App-wide Branding (custom logo + title)
// ===============================

// app_config keys used for branding. These live in the app-level key/value store
// (not per-user) so the customization applies application-wide and survives
// restarts and deployments.
const BRANDING_TITLE_KEY = 'branding.title';
const BRANDING_LOGO_PATH_KEY = 'branding.logo_path';

const BRANDING_TITLE_MAX_LENGTH = 60;

// Runtime directory for the uploaded logo. Mirrors the avatars layout: it lives
// under the user's home dir (NOT inside dist/, which the build overwrites), so the
// uploaded file persists across `npm run build` and pm2 deploys. The matching
// static route (/branding/logo.<ext>) is registered in server/index.js.
const BRANDING_ROOT = path.join(os.homedir(), '.nassaj-users', '.branding');
const BRANDING_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

// Allowed image MIME types → canonical extension used on disk and in the URL.
//
// SVG is supported but special-cased: it is an XML document (no fixed binary
// signature) that can carry inline scripts/event handlers — a stored-XSS vector
// when served same-origin. It is therefore (a) detected by inspecting the actual
// XML content for an <svg> root (see detectImageExt), (b) sanitized server-side
// with DOMPurify before any disk write (only the cleaned markup is persisted),
// and (c) served with a strict CSP + nosniff (see server/index.js).
//
// For raster formats the extension is ALWAYS derived from the magic bytes of the
// file content (see detectImageExt) — never from file.mimetype (client-
// controlled) nor the client-supplied filename — which removes both the spoofing
// and the path-traversal risk.
const BRANDING_MIME_TO_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

// Inspect the real leading bytes of the buffer and return the canonical
// extension for the detected format, or null if it matches no allowed
// signature. This is the single source of truth for "what kind of image is
// this" — the client-declared Content-Type is never trusted.
export function detectImageExt(buffer) {
  if (!buffer || buffer.length === 0) {
    return null;
  }
  // SVG is text/XML, not a binary signature. Detect it by content: the document
  // (after BOM/whitespace/<?xml?>/comments) must have an <svg> ROOT element —
  // not merely contain the substring "<svg" somewhere. This is checked before
  // the 12-byte minimum used for raster signatures because a valid SVG can be
  // shorter than 12 bytes.
  if (looksLikeSvgRoot(buffer.toString('utf8'))) {
    return 'svg';
  }
  if (buffer.length < 12) {
    return null;
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'png';
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpg';
  }
  // WEBP: "RIFF" (52 49 46 46) at 0..3 and "WEBP" (57 45 42 50) at 8..11.
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}

// In-memory storage so the buffer is validated before any disk write; the
// on-disk filename is derived from the detected magic bytes only. We deliberately
// keep the multer fileFilter lenient (the real check is detectImageExt after the
// full buffer is available) but still bound the candidate set by declared type to
// reject obvious non-images early without reading them.
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BRANDING_MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (BRANDING_MIME_TO_EXT[file.mimetype]) {
      return cb(null, true);
    }
    cb(null, false);
  },
}).single('logo');

// Canonical set of extensions that may appear on disk / in app_config. Derived
// from the MIME whitelist so the two can never drift apart.
const BRANDING_ALLOWED_EXTS = new Set(Object.values(BRANDING_MIME_TO_EXT));

// Resolve the public, server-relative URL for the stored logo, or null. We never
// return the absolute filesystem path to the client. The stored value is an
// EXTENSION (e.g. "png"), so it is validated against the allowed-extension set —
// not the MIME-keyed map.
function getBrandingLogoUrl() {
  const ext = appConfigDb.get(BRANDING_LOGO_PATH_KEY);
  if (!ext || !BRANDING_ALLOWED_EXTS.has(ext)) {
    return null;
  }
  return `/branding/logo.${ext}`;
}

// Public-ish read: any authenticated user needs this to render the header chrome.
// (The whole /api/settings router already requires a valid token.)
router.get('/branding', async (req, res) => {
  try {
    const title = appConfigDb.get(BRANDING_TITLE_KEY);
    res.json({
      title: title && title.length > 0 ? title : null,
      logoUrl: getBrandingLogoUrl(),
    });
  } catch (error) {
    console.error('Error fetching branding:', error);
    res.status(500).json({ error: 'Failed to fetch branding' });
  }
});

// Owner-only: update the custom application title. Empty/whitespace clears it
// (falls back to the default i18n title on the client).
router.put('/branding', requireRole('owner'), async (req, res) => {
  try {
    const raw = typeof req.body?.title === 'string' ? req.body.title : '';
    // Collapse whitespace and strip control characters before length-checking.
    const cleaned = raw.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();

    if (cleaned.length > BRANDING_TITLE_MAX_LENGTH) {
      return res
        .status(400)
        .json({ error: `Title must be at most ${BRANDING_TITLE_MAX_LENGTH} characters` });
    }

    appConfigDb.set(BRANDING_TITLE_KEY, cleaned);

    res.json({
      title: cleaned.length > 0 ? cleaned : null,
      logoUrl: getBrandingLogoUrl(),
    });
  } catch (error) {
    console.error('Error updating branding title:', error);
    res.status(500).json({ error: 'Failed to update branding title' });
  }
});

// Owner-only: upload/replace the custom logo (multipart/form-data, field `logo`).
router.post('/branding/logo', requireRole('owner'), (req, res) => {
  logoUpload(req, res, async (uploadError) => {
    try {
      if (uploadError) {
        if (uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'Image exceeds the 2MB size limit' });
        }
        console.error('Branding logo upload error:', uploadError?.message);
        return res.status(400).json({ error: 'Invalid upload' });
      }

      const file = req.file;
      if (!file) {
        // Missing field or rejected by fileFilter (unsupported declared type).
        return res
          .status(400)
          .json({ error: 'A valid image file (png, jpeg, webp) is required' });
      }

      // Authoritative type check: derive the extension from the actual file
      // content (magic bytes), NOT from file.mimetype. A request that claims
      // image/png but whose bytes are not a real PNG/JPEG/WEBP is rejected here,
      // closing the content-type-spoofing / SVG-XSS hole.
      const ext = detectImageExt(file.buffer);
      if (!ext) {
        return res.status(400).json({ error: 'Unsupported image type' });
      }

      // For SVG we never persist the uploaded bytes as-is: they are sanitized
      // server-side (DOMPurify, SVG profile) to strip <script>, event handlers,
      // javascript: URLs, external <use>, <foreignObject> and CSS payloads. Only
      // the cleaned markup is written to disk. Raster formats are written
      // verbatim (already validated by magic bytes above).
      let outputBuffer = file.buffer;
      if (ext === 'svg') {
        const sanitized = sanitizeSvg(file.buffer.toString('utf8'));
        if (!sanitized) {
          // Not a valid SVG document (or nothing survived sanitization).
          return res.status(400).json({ error: 'Unsupported image type' });
        }
        outputBuffer = Buffer.from(sanitized, 'utf8');
      }

      await fs.promises.mkdir(BRANDING_ROOT, { recursive: true });

      // Remove any logo stored under a different extension so a stale file is not
      // left shadowing the new one (and not served by the static handler).
      for (const otherExt of Object.values(BRANDING_MIME_TO_EXT)) {
        if (otherExt === ext) {
          continue;
        }
        await fs.promises.rm(path.join(BRANDING_ROOT, `logo.${otherExt}`), { force: true });
      }

      const targetPath = path.join(BRANDING_ROOT, `logo.${ext}`);
      await fs.promises.writeFile(targetPath, outputBuffer);

      // Persist only the extension; the public URL is rebuilt from it on read.
      appConfigDb.set(BRANDING_LOGO_PATH_KEY, ext);

      res.json({ logoUrl: `/branding/logo.${ext}` });
    } catch (error) {
      console.error('Branding logo update error:', error?.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
});

// Owner-only: remove the custom logo, reverting to the default inline SVG.
router.delete('/branding/logo', requireRole('owner'), async (req, res) => {
  try {
    // Remove every possible logo file regardless of which extension is recorded.
    await fs.promises
      .mkdir(BRANDING_ROOT, { recursive: true })
      .catch(() => {});
    for (const ext of Object.values(BRANDING_MIME_TO_EXT)) {
      await fs.promises.rm(path.join(BRANDING_ROOT, `logo.${ext}`), { force: true });
    }
    appConfigDb.set(BRANDING_LOGO_PATH_KEY, '');
    res.json({ logoUrl: null });
  } catch (error) {
    console.error('Branding logo delete error:', error?.message);
    res.status(500).json({ error: 'Failed to remove branding logo' });
  }
});

// ===============================
// API Keys Management
// ===============================

// Get all API keys for the authenticated user
router.get('/api-keys', async (req, res) => {
  try {
    const apiKeys = apiKeysDb.getApiKeys(req.user.id);
    // Don't send the full API key in the list for security
    const sanitizedKeys = apiKeys.map(key => ({
      ...key,
      api_key: key.api_key.substring(0, 10) + '...'
    }));
    res.json({ apiKeys: sanitizedKeys });
  } catch (error) {
    console.error('Error fetching API keys:', error);
    res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

// Create a new API key
router.post('/api-keys', async (req, res) => {
  try {
    const { keyName } = req.body;

    if (!keyName || !keyName.trim()) {
      return res.status(400).json({ error: 'Key name is required' });
    }

    const result = apiKeysDb.createApiKey(req.user.id, keyName.trim());
    res.json({
      success: true,
      apiKey: result
    });
  } catch (error) {
    console.error('Error creating API key:', error);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// Delete an API key
router.delete('/api-keys/:keyId', async (req, res) => {
  try {
    const { keyId } = req.params;
    const success = apiKeysDb.deleteApiKey(req.user.id, parseInt(keyId));

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'API key not found' });
    }
  } catch (error) {
    console.error('Error deleting API key:', error);
    res.status(500).json({ error: 'Failed to delete API key' });
  }
});

// Toggle API key active status
router.patch('/api-keys/:keyId/toggle', async (req, res) => {
  try {
    const { keyId } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be a boolean' });
    }

    const success = apiKeysDb.toggleApiKey(req.user.id, parseInt(keyId), isActive);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'API key not found' });
    }
  } catch (error) {
    console.error('Error toggling API key:', error);
    res.status(500).json({ error: 'Failed to toggle API key' });
  }
});

// ===============================
// Generic Credentials Management
// ===============================

// Get all credentials for the authenticated user (optionally filtered by type)
router.get('/credentials', async (req, res) => {
  try {
    const { type } = req.query;
    const credentials = credentialsDb.getCredentials(req.user.id, type || null);
    // Don't send the actual credential values for security
    res.json({ credentials });
  } catch (error) {
    console.error('Error fetching credentials:', error);
    res.status(500).json({ error: 'Failed to fetch credentials' });
  }
});

// Create a new credential
router.post('/credentials', async (req, res) => {
  try {
    const { credentialName, credentialType, credentialValue, description } = req.body;

    if (!credentialName || !credentialName.trim()) {
      return res.status(400).json({ error: 'Credential name is required' });
    }

    if (!credentialType || !credentialType.trim()) {
      return res.status(400).json({ error: 'Credential type is required' });
    }

    if (!credentialValue || !credentialValue.trim()) {
      return res.status(400).json({ error: 'Credential value is required' });
    }

    const result = credentialsDb.createCredential(
      req.user.id,
      credentialName.trim(),
      credentialType.trim(),
      credentialValue.trim(),
      description?.trim() || null
    );

    res.json({
      success: true,
      credential: result
    });
  } catch (error) {
    console.error('Error creating credential:', error);
    res.status(500).json({ error: 'Failed to create credential' });
  }
});

// Delete a credential
router.delete('/credentials/:credentialId', async (req, res) => {
  try {
    const { credentialId } = req.params;
    const success = credentialsDb.deleteCredential(req.user.id, parseInt(credentialId));

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Credential not found' });
    }
  } catch (error) {
    console.error('Error deleting credential:', error);
    res.status(500).json({ error: 'Failed to delete credential' });
  }
});

// Toggle credential active status
router.patch('/credentials/:credentialId/toggle', async (req, res) => {
  try {
    const { credentialId } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be a boolean' });
    }

    const success = credentialsDb.toggleCredential(req.user.id, parseInt(credentialId), isActive);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Credential not found' });
    }
  } catch (error) {
    console.error('Error toggling credential:', error);
    res.status(500).json({ error: 'Failed to toggle credential' });
  }
});

// ===============================
// Notification Preferences
// ===============================

router.get('/notification-preferences', async (req, res) => {
  try {
    const preferences = notificationPreferencesDb.getPreferences(req.user.id);
    res.json({ success: true, preferences });
  } catch (error) {
    console.error('Error fetching notification preferences:', error);
    res.status(500).json({ error: 'Failed to fetch notification preferences' });
  }
});

router.put('/notification-preferences', async (req, res) => {
  try {
    const preferences = notificationPreferencesDb.updatePreferences(req.user.id, req.body || {});
    res.json({ success: true, preferences });
  } catch (error) {
    console.error('Error saving notification preferences:', error);
    res.status(500).json({ error: 'Failed to save notification preferences' });
  }
});

// ===============================
// Push Subscription Management
// ===============================

router.get('/push/vapid-public-key', async (req, res) => {
  try {
    const publicKey = getPublicKey();
    res.json({ publicKey });
  } catch (error) {
    console.error('Error fetching VAPID public key:', error);
    res.status(500).json({ error: 'Failed to fetch VAPID public key' });
  }
});

router.post('/push/subscribe', async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Missing subscription fields' });
    }
    pushSubscriptionsDb.saveSubscription(req.user.id, endpoint, keys.p256dh, keys.auth);

    // Enable webPush in preferences so the confirmation goes through the full pipeline
    const currentPrefs = notificationPreferencesDb.getPreferences(req.user.id);
    if (!currentPrefs?.channels?.webPush) {
      notificationPreferencesDb.updatePreferences(req.user.id, {
        ...currentPrefs,
        channels: { ...currentPrefs?.channels, webPush: true },
      });
    }

    res.json({ success: true });

    // Send a confirmation push through the full notification pipeline
    const event = createNotificationEvent({
      provider: 'system',
      kind: 'info',
      code: 'push.enabled',
      meta: { message: 'Push notifications are now enabled!' },
      severity: 'info'
    });
    notifyUserIfEnabled({ userId: req.user.id, event });
  } catch (error) {
    console.error('Error saving push subscription:', error);
    res.status(500).json({ error: 'Failed to save push subscription' });
  }
});

router.post('/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      return res.status(400).json({ error: 'Missing endpoint' });
    }
    pushSubscriptionsDb.removeSubscription(endpoint);

    // Disable webPush in preferences to match subscription state
    const currentPrefs = notificationPreferencesDb.getPreferences(req.user.id);
    if (currentPrefs?.channels?.webPush) {
      notificationPreferencesDb.updatePreferences(req.user.id, {
        ...currentPrefs,
        channels: { ...currentPrefs.channels, webPush: false },
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing push subscription:', error);
    res.status(500).json({ error: 'Failed to remove push subscription' });
  }
});

export default router;

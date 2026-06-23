import jwt from 'jsonwebtoken';

import { userDb, appConfigDb, auditLogDb } from '../modules/database/index.js';
import { IS_PLATFORM } from '../constants/config.js';
import { clientIp } from '../utils/client-ip.js';

import { recordAuthRejection } from './auth-rejection-audit.js';

/**
 * Best-effort UNVERIFIED decode of a JWT for diagnostics only (T-182). Used on
 * the rejection path to recover the claimed userId for correlation when the
 * token cannot be verified (expired/forged). SECURITY: the result is untrusted —
 * we take ONLY the numeric userId, never username/role, never the token itself,
 * and the caller flags it metadata.unverified=true. Returns null on any failure.
 */
function decodeUnverifiedUserId(token) {
  try {
    const decoded = jwt.decode(token);
    if (decoded && typeof decoded === 'object' && typeof decoded.userId === 'number') {
      return decoded.userId;
    }
    return null;
  } catch {
    return null;
  }
}

// JWT secret: prefer an explicit env var (recommended, kept in .env with chmod 600).
// Fall back to a per-install secret persisted in app_config so OSS installs work
// out of the box. A short, weak JWT_SECRET is rejected to avoid trivial forgery.
function resolveJwtSecret() {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv) {
    if (fromEnv.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters');
    }
    return fromEnv;
  }
  return appConfigDb.getOrCreateJwtSecret();
}

const JWT_SECRET = resolveJwtSecret();
const TOKEN_TTL = '7d';

// Optional API key middleware
const validateApiKey = (req, res, next) => {
  // Skip API key validation if not configured
  if (!process.env.API_KEY) {
    return next();
  }

  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

// JWT authentication middleware
const authenticateToken = async (req, res, next) => {
  // Platform mode: use single database user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (!user) {
        return res.status(500).json({ error: 'Platform mode: No user found in database' });
      }
      req.user = user;
      return next();
    } catch (error) {
      console.error('Platform mode error:', error);
      return res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
    }
  }

  // Normal OSS JWT validation
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  // Also check query param for SSE endpoints (EventSource can't set headers)
  if (!token && req.query.token) {
    token = req.query.token;
  }

  const ip = clientIp(req);
  const ua = req.headers['user-agent'] ?? null;

  if (!token) {
    // Noisy reason → aggregated (qa-critic ح-2/ح-3). No token to decode.
    recordAuthRejection({ reason: 'no_token', transport: 'rest', ipAddress: ip, userAgent: ua });
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Verify user still exists, is active, and is not disabled (stateless: a
    // single id lookup, not a server-side session record).
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      recordAuthRejection({
        reason: 'user_missing',
        transport: 'rest',
        // The token's signature is valid, but no such user exists (deleted /
        // never existed), so the id cannot populate the audit FK column.
        userId: typeof decoded.userId === 'number' ? decoded.userId : null,
        ipAddress: ip,
        userAgent: ua,
        unverified: true,
      });
      return res.status(401).json({ error: 'Invalid token. User not found or disabled.' });
    }

    // Reject tokens minted before the user's last password change (logout-all on
    // password change / admin reset). pwd_iat and password_changed_at are ms epochs.
    if (user.password_changed_at && decoded.pwd_iat < user.password_changed_at) {
      recordAuthRejection({
        reason: 'pwd_iat_stale',
        transport: 'rest',
        userId: user.id,
        ipAddress: ip,
        userAgent: ua,
      });
      return res.status(401).json({ error: 'Token invalidated' });
    }

    // Auto-refresh: if token is past halfway through its lifetime, issue a new one.
    if (decoded.exp && decoded.iat) {
      const now = Math.floor(Date.now() / 1000);
      const halfLife = (decoded.exp - decoded.iat) / 2;
      if (now > decoded.iat + halfLife) {
        const newToken = generateToken(user);
        res.setHeader('X-Refreshed-Token', newToken);
        // Record the implicit (header-driven) refresh — distinct from the
        // explicit POST /api/auth/refresh, which logs its own row (T-182).
        auditLogDb.record('token_refresh', {
          userId: user.id,
          ipAddress: ip,
          userAgent: ua,
          metadata: { via: 'header' },
        });
      }
    }

    req.user = user;
    // Surface forced-rotation state to downstream handlers/clients (set after an
    // admin reset; cleared once the user changes their password).
    if (user.must_change_password === 1) {
      req.user.mustChangePassword = true;
    }
    next();
  } catch (err) {
    // Do not log token contents. Classify the failure from err.name and recover
    // the claimed userId via an UNVERIFIED decode for correlation only (T-182).
    let reason = 'verify_error';
    if (err && err.name === 'TokenExpiredError') {
      reason = 'expired';
    } else if (err && err.name === 'JsonWebTokenError') {
      reason = 'bad_signature';
    }
    recordAuthRejection({
      reason,
      transport: 'rest',
      userId: decodeUnverifiedUserId(token),
      ipAddress: ip,
      userAgent: ua,
      unverified: true,
    });
    // Generic message; 401 for expired/forged.
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

/**
 * Express middleware factory enforcing that req.user.role is in `allowedRoles`.
 * Must run after authenticateToken. Returns 403 on insufficient role.
 */
const requireRole = (...allowedRoles) => (req, res, next) => {
  const role = req.user?.role;
  if (!role || !allowedRoles.includes(role)) {
    auditLogDb.record('insufficient_role', {
      userId: req.user?.id ?? null,
      metadata: { required: allowedRoles, actual: role ?? null },
      ipAddress: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
};

// Generate JWT token (stateless — carries id, username, role, pwd_iat).
// pwd_iat pins the token to the password version at issue time (ms epoch); a
// later password change advances password_changed_at and invalidates this token.
const generateToken = (user) => {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username,
      role: user.role,
      pwd_iat: user.password_changed_at || Date.now(),
    },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
};

// WebSocket authentication function
const authenticateWebSocket = (token) => {
  // Platform mode: bypass token validation, return first user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (user) {
        return { id: user.id, userId: user.id, username: user.username, role: user.role };
      }
      return null;
    } catch (error) {
      console.error('Platform mode WebSocket error:', error);
      return null;
    }
  }

  // Normal OSS JWT validation
  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Verify user actually exists/active in DB (matches REST authenticateToken).
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return null;
    }
    return { id: user.id, userId: user.id, username: user.username, role: user.role };
  } catch {
    return null;
  }
};

export {
  validateApiKey,
  authenticateToken,
  requireRole,
  generateToken,
  authenticateWebSocket,
  JWT_SECRET,
};

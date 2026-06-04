import jwt from 'jsonwebtoken';

const COOKIE_NAME = 'flowmap_session';
const TOKEN_TTL = '30d';

function jwtSecret() {
  const secret = process.env.JWT_SECRET?.trim();
  if (secret && secret.length >= 16 && secret !== 'change_me_to_a_long_random_string') {
    return secret;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set to at least 16 characters in production');
  }
  return 'dev-only-insecure-jwt-secret';
}

export function signSession(user) {
  return jwt.sign(
    { sub: user.id, email: user.email },
    jwtSecret(),
    { expiresIn: TOKEN_TTL }
  );
}

export function verifySession(token) {
  try {
    const payload = jwt.verify(token, jwtSecret());
    return { id: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}

export function sessionCookieOptions() {
  const secure = process.env.NODE_ENV === 'production'
    || process.env.COOKIE_SECURE === 'true';
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  };
}

export function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, sessionCookieOptions());
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: sessionCookieOptions().secure,
    sameSite: 'lax',
    path: '/',
  });
}

export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  const user = token ? verifySession(token) : null;
  if (!user) {
    return res.status(401).json({ error: 'Sign in required' });
  }
  req.user = user;
  next();
}

export { COOKIE_NAME };

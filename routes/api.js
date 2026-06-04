import { Router } from 'express';
import bcrypt from 'bcryptjs';
import {
  createUser,
  deleteRun,
  findUserByEmail,
  listRunsForUser,
  syncRunsForUser,
  upsertRun,
} from '../lib/db.js';
import {
  COOKIE_NAME,
  clearSessionCookie,
  requireAuth,
  setSessionCookie,
  signSession,
  verifySession,
} from '../lib/auth.js';

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  return null;
}

function userFromRequest(req) {
  const token = req.cookies?.[COOKIE_NAME];
  return token ? verifySession(token) : null;
}

function publicUser(user) {
  return { email: user.email };
}

router.get('/me', (req, res) => {
  const user = userFromRequest(req);
  if (!user) return res.json({ user: null });
  res.json({ user: publicUser(user) });
});

router.post('/register', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    const passwordError = validatePassword(password);
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address' });
    }
    if (passwordError) return res.status(400).json({ error: passwordError });
    if (findUserByEmail(email)) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const id = createUser(email, passwordHash);
    const token = signSession({ id, email });
    setSessionCookie(res, token);
    res.status(201).json({ user: { email } });
  } catch (err) {
    console.error('Register failed:', err);
    res.status(500).json({ error: 'Could not create account' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const row = findUserByEmail(email);
    if (!row || !(await bcrypt.compare(password, row.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = signSession({ id: row.id, email: row.email });
    setSessionCookie(res, token);
    res.json({ user: { email: row.email } });
  } catch (err) {
    console.error('Login failed:', err);
    res.status(500).json({ error: 'Could not sign in' });
  }
});

router.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/runs', requireAuth, (req, res) => {
  res.json({ runs: listRunsForUser(req.user.id) });
});

router.post('/runs', requireAuth, (req, res) => {
  const run = req.body?.run;
  if (!run?.id) {
    return res.status(400).json({ error: 'Invalid run payload' });
  }
  upsertRun(req.user.id, run);
  res.status(201).json({ ok: true });
});

router.post('/runs/sync', requireAuth, (req, res) => {
  const runs = syncRunsForUser(req.user.id, req.body?.runs);
  res.json({ runs });
});

router.delete('/runs/:id', requireAuth, (req, res) => {
  const deleted = deleteRun(req.user.id, req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Run not found' });
  res.json({ ok: true });
});

export default router;

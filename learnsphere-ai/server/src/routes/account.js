/**
 * Account profile, data export and deletion.
 *
 * Everything here is scoped to the authenticated learner id. The export returns
 * only the caller's own rows and drops internal fields (password hash, session
 * digests). Deletion removes the learner's rows and files first, then the
 * account itself, and answers only after the session has been invalidated.
 */
import express from 'express';
import { z } from 'zod';
import AppError from '../errors.js';
import { parseBody } from './validate.js';
import {
  clearedCsrfCookie,
  clearedSessionCookie,
  csrfCookie,
  isSecureRequest,
  sessionCookie,
} from '../middleware/auth.js';
import { PASSWORD_MAX, PASSWORD_MIN } from '../auth/service.js';

const LEVELS = ['school', 'college', 'undergraduate', 'postgraduate', 'self-taught', 'other'];

const profileBody = z.object({
  language: z.enum(['auto', 'en', 'bn']).optional(),
  level: z.enum(LEVELS).nullable().optional(),
  subjects: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  examDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in YYYY-MM-DD form.')
    .nullable()
    .optional(),
  minutesPerDay: z.coerce.number().int().min(5).max(600).nullable().optional(),
  daysPerWeek: z.coerce.number().int().min(1).max(7).nullable().optional(),
  completeOnboarding: z.boolean().optional(),
});

const deleteBody = z.object({
  password: z.string().max(200).optional(),
  confirm: z.string().optional(),
});

const passwordBody = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX),
  newPassword: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
});

export function accountRouter({ store, authService, config }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json({
      user: req.auth?.user ?? null,
      mode: config.auth.mode,
      authenticated: Boolean(req.auth?.authenticated),
    });
  });

  router.patch('/profile', async (req, res) => {
    if (!req.auth?.authenticated) {
      throw new AppError('Preferences can only be saved to an account on this deployment.', {
        status: 400,
        code: 'accounts_disabled',
        expose: true,
      });
    }
    const patch = parseBody(profileBody, req.body);
    const { completeOnboarding, ...profile } = patch;
    const cleanProfile = { ...profile };
    if ('subjects' in cleanProfile) {
      // Trim, drop blanks, de-duplicate case-insensitively.
      const seen = new Set();
      cleanProfile.subjects = cleanProfile.subjects.filter((subject) => {
        const key = subject.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    const updated = await store.updateUserProfile(req.auth.user.id, cleanProfile, {
      onboardingCompleted: completeOnboarding === true ? true : undefined,
    });
    if (!updated) throw AppError.notFound('That account no longer exists.');
    req.log.info('profile updated', {
      fields: Object.keys(cleanProfile),
      onboardingCompleted: updated.onboardingCompleted,
    });
    res.json({ user: { ...req.auth.user, profile: updated.profile, onboardingCompleted: updated.onboardingCompleted } });
  });

  /**
   * Change the password of the signed-in account. The current password is
   * required, the normal minimum is enforced, and every other session is
   * revoked (the caller gets a fresh one) so a change also signs out anyone
   * else who was holding the old session.
   */
  router.post('/password', async (req, res) => {
    if (!req.auth?.authenticated) {
      throw new AppError('Sign in to change your password.', {
        status: 401,
        code: 'authentication_required',
        expose: true,
      });
    }
    const body = parseBody(passwordBody, req.body);
    const { user, session } = await authService.changePassword({
      userId: req.auth.user.id,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
    });
    const maxAgeMs = Math.max(0, Date.parse(session.expiresAt) - Date.now());
    const secure = isSecureRequest(req);
    res.append('Set-Cookie', sessionCookie(session.token, { maxAgeMs, secure }));
    res.append('Set-Cookie', csrfCookie(session.csrfToken, { maxAgeMs, secure }));
    req.log.info('password changed', { userId: user.id });
    res.json({
      user,
      expiresAt: session.expiresAt,
      csrfToken: session.csrfToken,
      message: 'Password updated. Other devices were signed out.',
    });
  });

  router.get('/export', async (req, res) => {
    const data = await store.collectLearnerData(req.learnerId);
    const payload = {
      ...data,
      account: req.auth?.authenticated
        ? {
            email: req.auth.user.email,
            displayName: req.auth.user.displayName,
            profile: req.auth.user.profile,
            createdAt: req.auth.user.createdAt,
          }
        : { mode: 'local', note: 'This export belongs to a local demo profile, not an account.' },
      note:
        'This file contains your own study material and practice records. Store it somewhere private; it is not encrypted.',
    };
    const name = `learnsphere-export-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(payload, null, 2));
  });

  router.delete('/', async (req, res) => {
    const body = parseBody(deleteBody, req.body ?? {});

    if (req.auth?.authenticated) {
      const ok = await authService.verifyAccountPassword(req.auth.user.id, body.password);
      if (!ok) {
        throw new AppError('The password is not correct, so nothing was deleted.', {
          status: 403,
          code: 'password_required',
          expose: true,
        });
      }
    } else if (body.confirm !== 'DELETE') {
      throw new AppError('Type DELETE to confirm removing this demo profile\'s data.', {
        status: 400,
        code: 'confirmation_required',
        expose: true,
      });
    }

    const removed = await store.deleteLearnerData(req.learnerId);
    const secure = isSecureRequest(req);
    if (req.auth?.authenticated) {
      await store.deleteUserRecord(req.auth.user.id);
      res.append('Set-Cookie', clearedSessionCookie({ secure }));
      res.append('Set-Cookie', clearedCsrfCookie({ secure }));
    }
    req.log.info('learner data deleted', { removed, account: Boolean(req.auth?.authenticated) });
    res.json({
      deleted: true,
      removed,
      accountDeleted: Boolean(req.auth?.authenticated),
      note: 'Materials, extracted passages, sessions, quizzes, attempts, flashcard decks and ratings, visuals, learning paths and study plans were removed.',
    });
  });

  return router;
}

export default accountRouter;

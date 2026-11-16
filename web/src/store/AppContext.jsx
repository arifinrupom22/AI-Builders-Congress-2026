/**
 * Shared application state.
 *
 * Holds the three things that more than one screen needs: the server config
 * (which is how the UI knows whether real AI answers are available), the
 * material library, and transient notifications. Everything else is fetched by
 * the page that owns it, so a failure on one screen cannot blank another.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, getLearnerId, setLearnerId as persistLearnerId, normaliseLearnerId } from '../lib/api.js';
import { createTranslator, detectLanguage, persistLanguage } from '../lib/i18n.js';
import { applyTheme, getStoredTheme, persistTheme, watchSystemTheme } from '../lib/theme.js';

const AppContext = createContext(null);

let toastSeq = 0;

/**
 * A hosted API on a free plan sleeps when idle and can take the better part of a
 * minute to answer its first request again. Treating that first timeout as a
 * dead end would make the whole app look broken on the first visit of the day,
 * so a retryable failure is retried a few times before the UI gives up.
 */
const BOOT_RETRY_DELAYS_MS = [1500, 3000, 6000, 9000];
export const BOOT_RETRY_LIMIT = BOOT_RETRY_DELAYS_MS.length;

function sleep(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/**
 * A misconfiguration will not fix itself, so only transport-level failures are
 * worth retrying: a dead network, a server that is still starting, or a rate
 * limit that expires by itself.
 */
function isRetryableBootError(err) {
  if (!err) return false;
  if (err.code === 'backend_not_configured' || err.code === 'invalid_backend_url') return false;
  if (err.code === 'network_error') return true;
  return [502, 503, 504, 429].includes(err.status);
}

export function AppProvider({ children }) {
  const [learnerId, setLearnerIdState] = useState(() => getLearnerId());

  const [config, setConfig] = useState(null);
  const [health, setHealth] = useState(null);
  const [materials, setMaterials] = useState([]);
  const [materialIndex, setMaterialIndex] = useState(null);

  // Account state. In local mode `user` stays null and the study profile is
  // used instead; the server says which mode this deployment is in.
  const [auth, setAuth] = useState({ state: 'loading', mode: null, user: null, limitations: [] });

  const [bootState, setBootState] = useState('loading'); // loading | ready | offline
  const [bootError, setBootError] = useState(null);
  const [bootAttempt, setBootAttempt] = useState(0);
  const bootController = useRef(null);
  const [materialsState, setMaterialsState] = useState('loading'); // loading | ready | error

  // Appearance and interface language are personal preferences: stored locally
  // and, when signed in, mirrored to the account profile.
  const [theme, setThemeState] = useState(() => getStoredTheme());
  const [language, setLanguageState] = useState(() => detectLanguage());

  useEffect(() => {
    applyTheme(theme);
    return watchSystemTheme(() => theme);
  }, [theme]);

  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismissToast = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const notify = useCallback(
    (message, tone = 'info', { timeoutMs } = {}) => {
      const id = `toast-${(toastSeq += 1)}`;
      setToasts((list) => [...list, { id, message, tone }]);
      const ttl = timeoutMs ?? (tone === 'error' ? 9000 : 5200);
      const timer = window.setTimeout(() => dismissToast(id), ttl);
      timers.current.set(id, timer);
      return id;
    },
    [dismissToast],
  );

  useEffect(() => {
    const store = timers.current;
    return () => {
      for (const timer of store.values()) window.clearTimeout(timer);
      store.clear();
    };
  }, []);

  const loadConfig = useCallback(async (signal) => {
    const [nextConfig, nextHealth] = await Promise.all([
      api.config(),
      api.health().catch(() => null),
    ]);
    if (signal?.aborted) return;
    setConfig(nextConfig);
    setHealth(nextHealth);
    return nextConfig;
  }, []);

  const loadAuth = useCallback(async (signal) => {
    const session = await api.session();
    if (signal?.aborted) return null;
    setAuth({
      state: 'ready',
      mode: session.mode ?? null,
      user: session.user ?? null,
      limitations: session.limitations ?? [],
    });
    return session;
  }, []);

  const loadMaterials = useCallback(async (signal) => {
    setMaterialsState('loading');
    try {
      const data = await api.listMaterials();
      if (signal?.aborted) return;
      setMaterials(data.materials ?? []);
      setMaterialIndex(data.index ?? null);
      setMaterialsState('ready');
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') return;
      setMaterialsState('error');
      throw err;
    }
  }, []);

  const refreshMaterials = useCallback(async () => {
    try {
      await loadMaterials();
    } catch (err) {
      notify(err?.message ?? 'Could not refresh your library.', 'error');
    }
  }, [loadMaterials, notify]);

  /**
   * Load the server configuration, retrying a retryable failure with backoff.
   * Returns the state it settled on so a manual retry can report the outcome.
   */
  const boot = useCallback(
    async (signal) => {
      setBootState('loading');
      setBootError(null);
      setBootAttempt(0);

      for (let attempt = 0; ; attempt += 1) {
        try {
          const nextConfig = await loadConfig(signal);
          const session = await loadAuth(signal);
          if (signal?.aborted) return 'aborted';
          // An account deployment must not fetch one learner's library before
          // it knows who is signed in.
          if (nextConfig?.auth?.mode === 'required' && !session?.user) {
            setMaterials([]);
            setMaterialIndex(null);
            setMaterialsState('ready');
          } else {
            await loadMaterials(signal).catch(() => {});
          }
          setBootState('ready');
          return 'ready';
        } catch (err) {
          if (signal?.aborted) return 'aborted';
          const retryable = isRetryableBootError(err);
          if (!retryable || attempt >= BOOT_RETRY_DELAYS_MS.length) {
            setBootError(err);
            setBootState('offline');
            return 'offline';
          }
          setBootAttempt(attempt + 1);
          await sleep(BOOT_RETRY_DELAYS_MS[attempt]);
          if (signal?.aborted) return 'aborted';
        }
      }
    },
    [loadConfig, loadAuth, loadMaterials],
  );

  // Boot (and re-boot when the identity changes: profile in local mode, account
  // in account mode). Materials are loaded inside boot so the order is right.
  const identityKey = auth.user?.id ?? learnerId;
  useEffect(() => {
    const controller = new AbortController();
    boot(controller.signal);
    return () => controller.abort();
  }, [identityKey, boot]);

  const applySession = useCallback(
    async (session) => {
      setAuth({
        state: 'ready',
        mode: session.mode ?? config?.auth?.mode ?? null,
        user: session.user ?? null,
        limitations: [],
      });
      setMaterialsState('loading');
      try {
        await loadMaterials();
      } catch {
        /* surfaced through materialsState */
      }
    },
    [config?.auth?.mode, loadMaterials],
  );

  const signIn = useCallback(
    async (email, password) => {
      const session = await api.login({ email, password });
      await applySession(session);
      notify(`Signed in as ${session.user.email}.`, 'success');
      return session.user;
    },
    [applySession, notify],
  );

  const registerAccount = useCallback(
    async (email, password, displayName) => {
      const session = await api.register({ email, password, displayName });
      await applySession(session);
      notify('Account created. Your library is private to this account.', 'success');
      return session.user;
    },
    [applySession, notify],
  );

  const signOut = useCallback(async () => {
    await api.logout();
    setAuth({ state: 'ready', mode: config?.auth?.mode ?? null, user: null, limitations: [] });
    setMaterials([]);
    setMaterialIndex(null);
    setMaterialsState('ready');
    notify('Signed out. Your data stays in your account.', 'info');
  }, [config?.auth?.mode, notify]);

  const setTheme = useCallback((next) => {
    setThemeState(persistTheme(next));
  }, []);

  const setLanguage = useCallback(
    (next) => {
      const applied = persistLanguage(next);
      setLanguageState(applied);
      // A signed-in learner's choice follows them to other devices. A failure
      // here must not undo the local choice, so it is reported and ignored.
      if (auth.user) {
        api.updateProfile({ language: applied }).catch(() => {
          notify('Language changed here, but could not be saved to your account.', 'warning');
        });
      }
      return applied;
    },
    [auth.user, notify],
  );

  const updateProfile = useCallback(
    async (patch) => {
      const result = await api.updateProfile(patch);
      setAuth((current) =>
        current.user
          ? { ...current, user: { ...current.user, ...result.user, profile: result.user.profile } }
          : current,
      );
      return result.user;
    },
    [],
  );

  const deleteAccount = useCallback(
    async (payload) => {
      const result = await api.deleteAccount(payload);
      setAuth({ state: 'ready', mode: config?.auth?.mode ?? null, user: null, limitations: [] });
      setMaterials([]);
      setMaterialIndex(null);
      setMaterialsState('ready');
      return result;
    },
    [config?.auth?.mode],
  );

  const setProfile = useCallback(
    (raw) => {
      const next = persistLearnerId(normaliseLearnerId(raw));
      setLearnerIdState(next);
      notify(`Now studying as “${next}”.`, 'success');
      return next;
    },
    [notify],
  );

  const t = useMemo(() => createTranslator(language), [language]);

  const value = useMemo(
    () => ({
      learnerId,
      setProfile,
      auth,
      signIn,
      registerAccount,
      signOut,
      theme,
      setTheme,
      language,
      setLanguage,
      t,
      updateProfile,
      deleteAccount,
      config,
      health,
      ai: config?.ai ?? null,
      publicLimits: config?.limits ?? null,
      materials,
      materialIndex,
      materialsState,
      refreshMaterials,
      bootState,
      bootError,
      bootAttempt,
      bootRetryLimit: BOOT_RETRY_LIMIT,
      /**
       * Try again without throwing away anything already in the browser: the
       * library, the study profile and any typed question all survive.
       */
      reload: () => {
        bootController.current?.abort();
        const controller = new AbortController();
        bootController.current = controller;
        return boot(controller.signal).finally(() => {
          if (bootController.current === controller) bootController.current = null;
        });
      },
      toasts,
      notify,
      dismissToast,
    }),
    [
      learnerId,
      setProfile,
      auth,
      signIn,
      registerAccount,
      signOut,
      theme,
      setTheme,
      language,
      setLanguage,
      t,
      updateProfile,
      deleteAccount,
      config,
      health,
      materials,
      materialIndex,
      materialsState,
      refreshMaterials,
      bootState,
      bootError,
      bootAttempt,
      boot,
      toasts,
      notify,
      dismissToast,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used inside <AppProvider>.');
  return context;
}

export default AppContext;

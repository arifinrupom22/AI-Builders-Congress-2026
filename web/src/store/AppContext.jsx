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

const AppContext = createContext(null);

let toastSeq = 0;

export function AppProvider({ children }) {
  const [learnerId, setLearnerIdState] = useState(() => getLearnerId());

  const [config, setConfig] = useState(null);
  const [health, setHealth] = useState(null);
  const [materials, setMaterials] = useState([]);
  const [materialIndex, setMaterialIndex] = useState(null);

  const [bootState, setBootState] = useState('loading'); // loading | ready | offline
  const [bootError, setBootError] = useState(null);
  const [materialsState, setMaterialsState] = useState('loading'); // loading | ready | error

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

  // Boot (and re-boot when the study profile changes).
  useEffect(() => {
    const controller = new AbortController();
    setBootState('loading');
    setBootError(null);

    loadConfig(controller.signal)
      .then(() => {
        if (controller.signal.aborted) return;
        setBootState('ready');
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setBootError(err);
        setBootState('offline');
      });

    loadMaterials(controller.signal).catch(() => {
      /* surfaced through materialsState instead */
    });

    return () => controller.abort();
  }, [learnerId, loadConfig, loadMaterials]);

  const setProfile = useCallback(
    (raw) => {
      const next = persistLearnerId(normaliseLearnerId(raw));
      setLearnerIdState(next);
      notify(`Now studying as “${next}”.`, 'success');
      return next;
    },
    [notify],
  );

  const value = useMemo(
    () => ({
      learnerId,
      setProfile,
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
      reload: () => {
        const controller = new AbortController();
        loadConfig(controller.signal).catch((err) => {
          setBootError(err);
          setBootState('offline');
        });
      },
      toasts,
      notify,
      dismissToast,
    }),
    [
      learnerId,
      setProfile,
      config,
      health,
      materials,
      materialIndex,
      materialsState,
      refreshMaterials,
      bootState,
      bootError,
      toasts,
      notify,
      dismissToast,
      loadConfig,
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

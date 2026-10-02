import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./http";

export interface Async<T> {
  data: T | null;
  error: string;
  loading: boolean;
  reload: () => Promise<void>;
}

/** Runs `load` on mount and whenever `deps` change; `reload` re-runs it (e.g. after a save). */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[] = []): Async<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);
  const loader = useRef(load);
  loader.current = load;

  const reload = useCallback(async () => {
    const run = ++latest.current;
    setLoading(true);
    try {
      const result = await loader.current();
      if (run === latest.current) {
        setData(result);
        setError("");
      }
    } catch (err) {
      if (run === latest.current) setError(errorMessage(err));
    } finally {
      if (run === latest.current) setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void reload(), deps);
  return { data, error, loading, reload };
}

/** Tiny hash router: "#/users" → "/users". No dependency, and deep links survive a reload. */
export function useHashRoute(defaultRoute: string): [string, (to: string) => void] {
  const read = () => window.location.hash.replace(/^#/, "") || defaultRoute;
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  });
  return [route, (to) => (window.location.hash = to)];
}

export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  return [
    copied,
    (text) => {
      void navigator.clipboard?.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    },
  ];
}

import { useCallback, useEffect, useRef, useState } from 'react';

export interface PollSample {
  ts: number;
  value: number;
  raw: number;
  ok: boolean;
  error?: string;
}

export interface TagPollResult {
  value: number;
  raw: number;
  success: boolean;
  message?: string;
}

export interface UseTagPollingState {
  samples: PollSample[];
  latest: PollSample | null;
  isPolling: boolean;
  start: () => void;
  stop: () => void;
  clear: () => void;
}

const MIN_INTERVAL_MS = 250;
const DEFAULT_MAX_SAMPLES = 60;

export function useTagPolling(
  fetcher: () => Promise<TagPollResult>,
  intervalMs: number,
  maxSamples: number = DEFAULT_MAX_SAMPLES,
): UseTagPollingState {
  const [samples, setSamples] = useState<PollSample[]>([]);
  const [isPolling, setIsPolling] = useState(false);
  const fetcherRef = useRef(fetcher);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => { fetcherRef.current = fetcher; }, [fetcher]);

  const tick = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const result = await fetcherRef.current();
      const sample: PollSample = {
        ts: Date.now(),
        value: result.value,
        raw: result.raw,
        ok: result.success,
        error: result.success ? undefined : result.message,
      };
      setSamples(prev => {
        const next = [...prev, sample];
        if (next.length > maxSamples) next.splice(0, next.length - maxSamples);
        return next;
      });
    } catch (e) {
      setSamples(prev => {
        const next = [...prev, {
          ts: Date.now(), value: NaN, raw: NaN, ok: false, error: (e as Error).message,
        }];
        if (next.length > maxSamples) next.splice(0, next.length - maxSamples);
        return next;
      });
    } finally {
      inFlightRef.current = false;
    }
  }, [maxSamples]);

  const start = useCallback(() => {
    if (timerRef.current) return;
    const clampedInterval = Math.max(MIN_INTERVAL_MS, intervalMs);
    setIsPolling(true);
    void tick();
    timerRef.current = setInterval(() => { void tick(); }, clampedInterval);
  }, [intervalMs, tick]);

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsPolling(false);
  }, []);

  const clear = useCallback(() => setSamples([]), []);

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  return {
    samples,
    latest: samples.length ? samples[samples.length - 1] : null,
    isPolling,
    start,
    stop,
    clear,
  };
}

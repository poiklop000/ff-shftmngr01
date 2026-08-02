import { useEffect, type RefObject } from 'react';

/**
 * Rejects a promise if it doesn't settle within `ms`. Used to stop loading
 * spinners from hanging forever when a backend request stalls.
 */
export function withTimeout<T>(
  promise: PromiseLike<T>,
  ms: number,
  message = 'Request timed out',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Auto-select all text when the input/textarea receives focus.
 * Lets the user immediately type to replace existing content
 * without first backspacing.
 */
export function useAutoSelect<T extends HTMLInputElement | HTMLTextAreaElement>(
  ref: RefObject<T>,
  deps: unknown[] = []
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = () => setTimeout(() => el.select(), 50);
    el.addEventListener('focus', handler);
    return () => el.removeEventListener('focus', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, ...deps]);
}

/**
 * On Enter key, move focus to the element identified by `nextId`.
 */
export function useEnterToNext<T extends HTMLInputElement | HTMLTextAreaElement>(
  ref: RefObject<T>,
  nextId: string | null,
  deps: unknown[] = []
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key === 'Enter') {
        ke.preventDefault();
        if (nextId) {
          const next = document.getElementById(nextId);
          if (next) (next as HTMLElement).focus();
        }
      }
    };
    el.addEventListener('keydown', handler as EventListener);
    return () => el.removeEventListener('keydown', handler as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, nextId, ...deps]);
}

/**
 * Auto-grow a textarea to fit its content (min height 28px).
 */
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement>,
  value: string,
  minHeight = 28,
  deps: unknown[] = []
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = `${minHeight}px`;
    el.style.height = `${Math.max(minHeight, el.scrollHeight)}px`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, value, minHeight, ...deps]);
}

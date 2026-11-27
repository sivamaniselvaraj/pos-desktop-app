import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * A callback whose identity never changes but that always runs the latest
 * `fn`. For handlers passed to memoized children (TableCardView), so a new
 * render of the parent does not re-render every child. Only call the result
 * from event handlers, never during render.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}

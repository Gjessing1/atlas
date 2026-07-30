import { defineConfig } from 'vitest/config';

/**
 * The one vitest config in the repo, and it exists to make a green suite mean a
 * green build.
 *
 * Every test in this package renders hooks, so `environment: 'jsdom'` belongs
 * here rather than in 29 per-file `@vitest-environment` docblocks. The load-
 * bearing setting is `globals: true`: `@testing-library/react` registers its
 * automatic `cleanup()` only if a global `afterEach` exists, so without it
 * *nothing ever unmounts* — every `renderHook` component stays mounted until
 * the file ends, and a hook that schedules a timer (`useSync`'s interval and
 * debounce, both of which do clear correctly on unmount) can fire after jsdom
 * has been torn down. That lands as
 * `Uncaught Exception: ReferenceError: window is not defined` from
 * `Timeout._onTimeout`, which vitest reports as `Errors 1 error` **after**
 * printing `Tests 287 passed` — exit code 1 from a suite that looks green.
 *
 * That is how v0.132.0 was built: the image gate failed, nothing was pushed,
 * and the release sat undeployed while the app showed UI for routes the live
 * server had never heard of. Latent in every hook test here, so it is fixed for
 * all of them at once instead of per file.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
  },
});

import posthog from 'posthog-js';

// React 19.2's dev-only Performance Tracks instrumentation ("Components ⚛" in
// the Chrome Performance panel) calls performance.measure() with React-internal
// timestamps. When a component's render aborts — e.g. a page whose body is a
// redirect() throw, like /settings — the timestamps can still hold React's
// negative "not recorded" sentinels, and Chrome rejects the call with
// "cannot have a negative time stamp", surfacing a spurious dev-overlay error.
// Clamp negative timestamps instead. Dev-only: production react-dom contains no
// track instrumentation, and this whole block is dead-code-eliminated there.
if (
  process.env.NODE_ENV === 'development' &&
  typeof performance !== 'undefined' &&
  typeof performance.measure === 'function'
) {
  const originalMeasure = performance.measure.bind(performance);
  performance.measure = ((
    measureName: string,
    startOrMeasureOptions?: string | PerformanceMeasureOptions,
    endMark?: string,
  ) => {
    if (
      typeof startOrMeasureOptions === 'object' &&
      startOrMeasureOptions !== null
    ) {
      const options = { ...startOrMeasureOptions };
      if (typeof options.start === 'number' && options.start < 0) {
        options.start = 0;
      }
      if (typeof options.end === 'number' && options.end < 0) {
        options.end = 0;
      }
      return originalMeasure(measureName, options);
    }
    return originalMeasure(measureName, startOrMeasureOptions, endMark);
  }) as typeof performance.measure;
}

const posthogToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
const shouldEnablePostHog =
  process.env.NODE_ENV !== "development" ||
  process.env.NEXT_PUBLIC_POSTHOG_ENABLE_DEV === "true";

if (posthogToken && shouldEnablePostHog) {
  posthog.init(posthogToken, {
    api_host: '/ingest',
    ui_host: 'https://us.posthog.com',
    capture_exceptions: true,
    debug: process.env.NODE_ENV === 'development',
  });
}

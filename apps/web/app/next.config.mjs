import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const shouldProxyPostHog =
  Boolean(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN) &&
  (process.env.NODE_ENV !== "development" ||
    process.env.NEXT_PUBLIC_POSTHOG_ENABLE_DEV === "true");

// Sub-folder portals run on a customer's origin, where root-relative `/_next`
// requests would otherwise hit the customer's existing site. The primary
// deployment therefore emits absolute framework asset URLs back to Bread.
// Preview builds deliberately stay self-contained because their chunk hashes
// do not match production. Non-Netlify/Vercel production can set the explicit
// override.
//
// Losing this prefix on a production build does NOT degrade gracefully: the
// Cloudflare portal proxy falls back to string-rewriting `"/_next/` in the HTML
// it serves, which also rewrites the chunk URLs inside the inlined RSC payload.
// Turbopack's runtime registers each chunk under `src.slice("/_next/".length)`,
// so absolute srcs register under keys the runtime never awaits, the app entry
// module is never instantiated, and every proxied portal renders as dead HTML
// (no hydration: no TOC highlighting, no theme toggle, no search). The context
// detection below is therefore fail-safe — a deployed build with no recognised
// context is treated as primary rather than silently dropping the prefix.
const deployContext = (process.env.CONTEXT || process.env.VERCEL_ENV || "").trim();
const isPreviewDeployment = deployContext !== "" && deployContext !== "production";
// `CONTEXT` only reaches this config because turbo.json declares it: Turborepo
// runs tasks in strict env mode, so undeclared vars are stripped from the build.
const isDeployedBuild =
  process.env.NETLIFY === "true" || process.env.VERCEL === "1" || process.env.CI === "true";
const isPrimaryDeployment =
  deployContext === "production" || (isDeployedBuild && !isPreviewDeployment);
const portalAssetOrigin = (
  process.env.BREAD_PORTAL_ASSET_ORIGIN ||
  (isPrimaryDeployment ? process.env.NEXT_PUBLIC_APP_URL || process.env.URL : "") ||
  ""
).replace(/\/+$/, "");

if (isPrimaryDeployment && !portalAssetOrigin) {
  console.warn(
    "[bread] No portal asset origin resolved for this production build. Set NEXT_PUBLIC_APP_URL or BREAD_PORTAL_ASSET_ORIGIN — sub-folder portals (example.com/blog, customer.com/help) will not hydrate without it.",
  );
}

// Shiki loads its language/theme grammars via dynamic import from @shikijs/langs
// and @shikijs/themes, which the file-tracer can't follow statically — so the
// JSON assets get dropped from the serverless bundle and the highlighter init in
// public-kb-render.ts throws in prod (works locally, where the assets are on
// disk). Force-trace the grammar/theme packages into every route that
// server-renders public KB document bodies. Paths are relative to this project
// dir (apps/web/app); @shikijs/* is hoisted to the repo-root node_modules.
const SHIKI_TRACE_INCLUDES = [
  "../../../node_modules/@shikijs/langs/**",
  "../../../node_modules/@shikijs/themes/**",
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  experimental: {
    // Every authenticated page is dynamic, and Next's default client-cache
    // lifetime for dynamic segments is 0s, so revisiting a section always
    // waits on a fresh server round-trip. The (app) pages are thin client
    // shells whose data comes from SWR (which revalidates on mount), so
    // reusing the cached RSC payload briefly is safe and makes back-and-forth
    // navigation instant. router.refresh() and server actions still bypass it.
    staleTimes: { dynamic: 30 },
  },
  // `npm run typecheck` still validates the complete app workspace (including
  // tests and scripts) in CI. The production build only needs the deployable
  // source graph, so avoid making `next build` re-check 50k+ lines of tests.
  typescript: {
    tsconfigPath:
      process.env.NODE_ENV === "production"
        ? "tsconfig.build.json"
        : "tsconfig.json",
  },
  ...(portalAssetOrigin ? { assetPrefix: portalAssetOrigin } : {}),
  skipTrailingSlashRedirect: true,
  outputFileTracingRoot: path.join(__dirname, "../../../"),
  // Keep packages with dynamic requires / dynamically-loaded assets out of the
  // bundler so they run as real Node modules in the route handler (and get
  // file-traced into the serverless function) instead of being webpack-bundled:
  //   - mammoth: dynamic requires; unpdf: ships a prebuilt pdf.js.
  //   - jsdom: dynamic requires of its own internals — does not survive bundling.
  //   - shiki: loads theme/language grammar JSON dynamically; bundling drops
  //     those assets so the top-level `createHighlighter` in public-kb-render.ts
  //     throws at module init inside the Lambda, 500-ing every portal route.
  //   - markdown-it: same render graph, externalized for parity.
  // Symptom when missing: the public portal (/p/[...path]) and /portal-preview
  // 500 in the deployed (serverless) build while local `next start` works.
  serverExternalPackages: ["mammoth", "unpdf", "jsdom", "shiki", "markdown-it"],
  outputFileTracingIncludes: {
    // The portal home/doc/folder views all render through the single catch-all
    // route, so one glob covers every public-portal page.
    "/p/[...path]": SHIKI_TRACE_INCLUDES,
    "/portal-preview": SHIKI_TRACE_INCLUDES,
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'cdn.jsdelivr.net' },
      { protocol: 'https', hostname: 'cdn.simpleicons.org' },
      { protocol: 'https', hostname: 'i.pravatar.cc' },
    ],
  },
  async headers() {
    return [
      {
        // Sub-folder/custom-domain portals load framework assets cross-origin
        // from this deployment (see assetPrefix above). Fonts are CORS-gated by
        // the browser, so without this header every proxied portal silently
        // falls back to system fonts. /_next/static is public and immutable —
        // a wildcard origin is safe.
        source: "/_next/static/:path*",
        headers: [{ key: "Access-Control-Allow-Origin", value: "*" }],
      },
    ];
  },
  async redirects() {
    // The portal editor merged into Knowledge; keep old links and bookmarks working.
    return [
      { source: "/kb", destination: "/knowledge", permanent: false },
      { source: "/kb/doc/:id", destination: "/knowledge/:id", permanent: false },
      { source: "/kb/folder/:id", destination: "/knowledge/folder/:id", permanent: false },
    ];
  },
  async rewrites() {
    if (!shouldProxyPostHog) return [];

    return [
      {
        source: '/ingest/static/:path*',
        destination: 'https://us-assets.i.posthog.com/static/:path*',
      },
      {
        source: '/ingest/:path*',
        destination: 'https://us.i.posthog.com/:path*',
      },
    ];
  },
};

export default nextConfig;

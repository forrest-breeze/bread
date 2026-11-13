import { type NextRequest, NextResponse } from "next/server";

// Origins that are permitted to call the v1 API directly from a browser-like
// context (Tauri webview, dev server, the production web app). Production
// Tauri builds load via the `tauri://` scheme; dev builds load via Vite.
const ALLOWED_ORIGIN_PATTERNS: RegExp[] = [
  /^tauri:\/\/localhost$/,
  /^http:\/\/tauri\.localhost$/,
  /^https:\/\/tauri\.localhost$/,
  /^http:\/\/localhost:\d+$/,
  /^http:\/\/127\.0\.0\.1:\d+$/,
];

// The deployed web app's own origin, from NEXT_PUBLIC_APP_URL. No fallback:
// when unset, only the local/Tauri origins above are allowed.
function appOrigin(): string | null {
  try {
    return process.env.NEXT_PUBLIC_APP_URL
      ? new URL(process.env.NEXT_PUBLIC_APP_URL).origin
      : null;
  } catch {
    return null;
  }
}

const ALLOW_HEADERS = "Authorization, Content-Type, x-breezify-workspace, x-idempotency-key";
const ALLOW_METHODS = "GET, POST, OPTIONS";

export function corsHeaders(request: NextRequest): Record<string, string> {
  const origin = request.headers.get("origin") ?? "";
  const allowed =
    origin === appOrigin() || ALLOWED_ORIGIN_PATTERNS.some((r) => r.test(origin));
  if (!origin || !allowed) return {};

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": ALLOW_METHODS,
    "Access-Control-Allow-Headers": ALLOW_HEADERS,
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export function withCors(request: NextRequest, response: NextResponse): NextResponse {
  const headers = corsHeaders(request);
  for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
  return response;
}

export function handleCorsPreflight(request: NextRequest): NextResponse {
  const headers = corsHeaders(request);
  return new NextResponse(null, { status: 204, headers });
}

'use client';

import { useState, useRef, useEffect, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { LockKeyhole, TriangleAlert } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { DOMAIN_NOT_ALLOWED_MESSAGE, isAllowedEmail } from '@/lib/auth/allowed-email';

// Breeze internal tool: Google (Breeze Workspace) and Breeze email only.
type OAuthLoginMethod = 'google';
type LastLoginMethod = OAuthLoginMethod | 'email';

// Google sign-in is temporarily off (button shown greyed out). Flip back to
// true once the Breeze Google OAuth client is configured in Supabase.
export const GOOGLE_SIGN_IN_ENABLED = false;

const LAST_LOGIN_METHOD_STORAGE_KEY = 'bread:last-login-method';
const lastLoginMethodListeners = new Set<() => void>();

function readLastLoginMethodSnapshot(): LastLoginMethod | null {
  try {
    const stored = localStorage.getItem(LAST_LOGIN_METHOD_STORAGE_KEY);
    return stored === 'google' || stored === 'email'
      ? stored
      : null;
  } catch {
    return null;
  }
}

function getServerLastLoginMethodSnapshot(): LastLoginMethod | null {
  return null;
}

function emitLastLoginMethodChange(): void {
  for (const listener of lastLoginMethodListeners) {
    listener();
  }
}

function subscribeToLastLoginMethod(listener: () => void): () => void {
  lastLoginMethodListeners.add(listener);

  const handleStorage = (event: StorageEvent): void => {
    if (event.key === LAST_LOGIN_METHOD_STORAGE_KEY) listener();
  };
  window.addEventListener('storage', handleStorage);

  return () => {
    lastLoginMethodListeners.delete(listener);
    window.removeEventListener('storage', handleStorage);
  };
}

function rememberLastLoginMethod(method: LastLoginMethod): void {
  try {
    localStorage.setItem(LAST_LOGIN_METHOD_STORAGE_KEY, method);
  } catch {
    // Best-effort preference only; auth should continue if storage is blocked.
  }
  emitLastLoginMethodChange();
}

interface LoginFormProps {
  /** Server-sanitized post-login destination (relative path or validated portal URL). */
  next: string;
  /** Render the private-portal locked copy instead of the Bread default. */
  privatePortalLogin: boolean;
  /** Hide authentication methods until the server verifies the access code. */
  accessRequired?: boolean;
  /**
   * Friendly copy for a failed round-trip through /auth/callback (expired magic
   * link, cancelled consent). Optional — omit when arriving at /login cleanly.
   */
  authError?: string | null;
}

export function LoginForm({
  next,
  privatePortalLogin,
  authError = null,
  accessRequired = false,
}: LoginFormProps) {
  const router = useRouter();
  const [accessGranted, setAccessGranted] = useState(!accessRequired);
  const [accessCode, setAccessCode] = useState('');
  const [accessError, setAccessError] = useState('');
  const [accessLoading, setAccessLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  // The callback notice describes the *previous* attempt — retiring it the
  // moment a new one starts keeps a stale "link expired" from sitting next to
  // a fresh link the visitor just requested.
  const [callbackNoticeDismissed, setCallbackNoticeDismissed] = useState(false);
  const callbackNotice = callbackNoticeDismissed ? null : authError;
  const lastMethod = useSyncExternalStore(
    subscribeToLastLoginMethod,
    readLastLoginMethodSnapshot,
    getServerLastLoginMethodSnapshot
  );
  const submittingRef = useRef(false);

  // Redirect once the visitor is authenticated. The server component already
  // bounces visitors with a live session, so this covers the async cases only:
  // a `?code=`/token in the URL that the browser client exchanges via
  // `detectSessionInUrl` *after mount*, and a sign-in completed in this tab.
  // `next` may be a validated absolute portal URL (custom-domain portals), which
  // the app router can't navigate to — hand those to the browser.
  useEffect(() => {
    const supabase = createClient();
    let redirected = false;
    const go = (): void => {
      if (redirected) return;
      redirected = true;
      if (next.startsWith('https://')) {
        window.location.replace(next);
      } else {
        router.replace(next);
      }
    };

    supabase.auth.getClaims().then(({ data }) => {
      if (data?.claims?.sub) go();
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (session && (event === "SIGNED_IN" || event === "INITIAL_SESSION")) {
        go();
      }
    });

    return () => subscription.unsubscribe();
  }, [next, router]);

  const handleAccessSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!accessCode || accessLoading) return;

    setAccessError('');
    setAccessLoading(true);
    try {
      const response = await fetch('/api/auth/login-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: accessCode }),
      });
      const result = (await response.json().catch(() => null)) as { error?: string } | null;

      if (!response.ok) {
        setAccessError(result?.error ?? 'Invalid access code.');
        return;
      }

      setAccessCode('');
      setAccessGranted(true);
    } catch {
      setAccessError('Unable to verify the access code. Please try again.');
    } finally {
      setAccessLoading(false);
    }
  };

  const handleEmailSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!email) return;
    // UX only: the database rejects non-Breeze accounts regardless.
    if (!isAllowedEmail(email)) {
      setError(DOMAIN_NOT_ALLOWED_MESSAGE);
      return;
    }
    if (submittingRef.current) return;
    submittingRef.current = true;
    setError('');
    setCallbackNoticeDismissed(true);
    setLoading(true);
    const supabase = createClient();

    const pendingInvite = sessionStorage.getItem('bread:pending-invite');
    const postLoginNext = pendingInvite ? `/join?code=${pendingInvite}` : next;
    const origin = window.location.origin;

    // TEMPORARY local-only bypass until Resend can deliver auth emails.
    // See lib/auth/dev-login-bypass.ts. The server route enforces the real gate.
    if (process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS === 'true') {
      try {
        const res = await fetch('/api/auth/dev-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, next: postLoginNext }),
        });
        const body = (await res.json().catch(() => ({}))) as { redirectTo?: string; error?: string };
        if (res.ok && body.redirectTo) {
          rememberLastLoginMethod('email');
          window.location.assign(body.redirectTo);
          return;
        }
        setError(body.error ?? 'Dev login failed.');
      } catch {
        setError('Dev login failed.');
      }
      setLoading(false);
      submittingRef.current = false;
      return;
    }

    const { error: otpError } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(postLoginNext)}`,
      },
    });

    if (otpError) {
      setError(otpError.message);
    } else {
      rememberLastLoginMethod('email');
      setMagicLinkSent(true);
    }
    setLoading(false);
    submittingRef.current = false;
  };

  const handleOAuth = async (provider: OAuthLoginMethod): Promise<void> => {
    if (provider === 'google' && !GOOGLE_SIGN_IN_ENABLED) return;
    if (submittingRef.current) return;
    submittingRef.current = true;
    setError('');
    setCallbackNoticeDismissed(true);
    setLoading(true);

    const supabase = createClient();
    const pendingInvite = sessionStorage.getItem('bread:pending-invite');
    const postLoginNext = pendingInvite ? `/join?code=${pendingInvite}` : next;
    const origin = window.location.origin;
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(postLoginNext)}`,
        ...(provider === 'google'
          ? {
              // Force Google's account chooser. Without it, a live Google SSO
              // session re-authenticates silently, making logout look broken.
              queryParams: { prompt: 'select_account' },
            }
          : {}),
      },
    });

    if (oauthError) {
      setError(oauthError.message);
      setLoading(false);
      submittingRef.current = false;
      return;
    }

    sessionStorage.removeItem('bread:pending-invite');
    rememberLastLoginMethod(provider);
  };

  const inputClass =
    'w-full h-11 bg-white border border-[#ddddd8] rounded-lg px-4 text-sm text-[#111] outline-none font-[var(--font-sans)]';

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ backgroundColor: 'var(--bg-color)', fontFamily: 'var(--font-sans)' }}
    >
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="w-full max-w-115">

          {/* Logo icon */}
          <Link href="/" className="inline-block" style={{ marginBottom: '0.5rem' }}>
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center"
              style={{ backgroundColor: '#fff', border: '1px solid #ddddd8' }}
            >
              {privatePortalLogin ? (
                <LockKeyhole className="size-5" aria-hidden="true" />
              ) : (
                <Image src="/breeze-mark.png" alt="Breeze" width={22} height={22} className="object-contain" />
              )}
            </div>
          </Link>

          {/* Title */}
          <h1
            className="text-3xl font-semibold tracking-tight logo-font"
            style={{ color: '#111', marginBottom: '0.25rem' }}
          >
            {privatePortalLogin ? 'This portal is locked' : 'Bread'}
          </h1>

          {/* Subtitle */}
          <p className="text-sm" style={{ color: 'var(--text-gray)', marginBottom: '1.5rem' }}>
            {!accessGranted
              ? 'Enter the access code to continue.'
              : privatePortalLogin
              ? 'Sign in with your work account to access this private portal.'
              : 'Sign up or log in to continue'}
          </p>

          {accessGranted && callbackNotice && (
            <div
              role="alert"
              className="flex items-start gap-2.5 text-xs leading-relaxed"
              style={{
                backgroundColor: '#fdf4f3',
                border: '1px solid #f0d6d2',
                borderRadius: '8px',
                color: '#8f2c22',
                padding: '0.75rem',
                marginBottom: '1.25rem',
              }}
            >
              <TriangleAlert className="size-3.5 shrink-0" style={{ marginTop: '1px' }} aria-hidden="true" />
              <span>{callbackNotice}</span>
            </div>
          )}

          {!accessGranted ? (
            <form onSubmit={handleAccessSubmit}>
              <div className="relative">
                <input
                  type="password"
                  placeholder="Enter access code"
                  aria-label="Access code"
                  value={accessCode}
                  onChange={e => {
                    setAccessCode(e.target.value);
                    setAccessError('');
                  }}
                  required
                  autoFocus
                  autoComplete="off"
                  disabled={accessLoading}
                  className={inputClass}
                  onFocus={e => (e.currentTarget.style.borderColor = 'var(--primary-green)')}
                  onBlur={e => (e.currentTarget.style.borderColor = '#ddddd8')}
                />
                <button
                  type="submit"
                  aria-label="Unlock login"
                  disabled={accessLoading}
                  className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center justify-center rounded-md transition-colors"
                  style={{
                    width: '28px',
                    height: '28px',
                    backgroundColor: 'var(--primary-green)',
                    color: '#fff',
                    border: 'none',
                    cursor: accessLoading ? 'not-allowed' : 'pointer',
                    opacity: accessLoading ? 0.6 : 1,
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
              {accessError && (
                <p role="alert" className="text-xs mt-2" style={{ color: '#ef4444' }}>{accessError}</p>
              )}
              {accessLoading && !accessError && (
                <p className="text-xs mt-2" style={{ color: 'var(--text-gray)' }}>Checking access code…</p>
              )}
            </form>
          ) : magicLinkSent ? (
            <div className="py-2">
              <p className="text-sm font-medium mb-1" style={{ color: 'var(--primary-green)' }}>Check your email</p>
              <p className="text-sm" style={{ color: 'var(--text-gray)' }}>
                We sent a magic link to <span style={{ color: '#111' }}>{email}</span>. Click it to sign in.
              </p>
            </div>
          ) : (
            <>
              {/* OAuth providers */}
              <div className="space-y-3" style={{ marginBottom: '1rem' }}>
                <div className="relative">
                  {GOOGLE_SIGN_IN_ENABLED && lastMethod === 'google' && <LastUsedBadge />}
                  <button
                    type="button"
                    onClick={() => void handleOAuth('google')}
                    disabled={loading || !GOOGLE_SIGN_IN_ENABLED}
                    aria-describedby={GOOGLE_SIGN_IN_ENABLED ? undefined : 'google-signin-unavailable'}
                    title={GOOGLE_SIGN_IN_ENABLED ? undefined : 'Google sign-in is temporarily unavailable'}
                    className="w-full flex items-center justify-center gap-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                    style={{
                      height: '44px',
                      backgroundColor: '#fff',
                      border: '1px solid #ddddd8',
                      borderRadius: '8px',
                      color: '#111',
                      cursor: loading || !GOOGLE_SIGN_IN_ENABLED ? 'not-allowed' : 'pointer',
                      filter: GOOGLE_SIGN_IN_ENABLED ? undefined : 'grayscale(1)',
                    }}
                    onMouseEnter={e => {
                      if (GOOGLE_SIGN_IN_ENABLED) e.currentTarget.style.backgroundColor = '#f7f7f5';
                    }}
                    onMouseLeave={e => (e.currentTarget.style.backgroundColor = '#fff')}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                    </svg>
                    Continue with Google
                  </button>
                  {!GOOGLE_SIGN_IN_ENABLED && (
                    <p id="google-signin-unavailable" className="text-xs mt-1.5 text-center" style={{ color: 'var(--text-gray)' }}>
                      Temporarily unavailable. Sign in with your Breeze email below.
                    </p>
                  )}
                </div>
              </div>

              {/* Divider */}
              <div className="flex items-center gap-3" style={{ marginBottom: '1rem' }}>
                <div className="flex-1 h-px" style={{ backgroundColor: '#ddddd8' }} />
                <span className="text-xs" style={{ color: '#aaa' }}>or</span>
                <div className="flex-1 h-px" style={{ backgroundColor: '#ddddd8' }} />
              </div>

              {/* Email step — submit sends magic link directly */}
              <form onSubmit={handleEmailSubmit}>
                <div className="relative">
                  {lastMethod === 'email' && <LastUsedBadge />}
                  <input
                    type="email"
                    placeholder="you@breeze.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                    autoFocus
                    disabled={loading}
                    className={inputClass}
                    onFocus={e => (e.currentTarget.style.borderColor = 'var(--primary-green)')}
                    onBlur={e => (e.currentTarget.style.borderColor = '#ddddd8')}
                  />
                  <button
                    type="submit"
                    disabled={loading}
                    className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center justify-center rounded-md transition-colors"
                    style={{
                      width: '28px',
                      height: '28px',
                      backgroundColor: 'var(--primary-green)',
                      color: '#fff',
                      border: 'none',
                      cursor: loading ? 'not-allowed' : 'pointer',
                      opacity: loading ? 0.6 : 1,
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h14M12 5l7 7-7 7" />
                    </svg>
                  </button>
                </div>
                {error && (
                  <p role="alert" className="text-xs mt-2" style={{ color: '#ef4444' }}>{error}</p>
                )}
                {loading && !error && (
                  <p className="text-xs mt-2" style={{ color: 'var(--text-gray)' }}>Sending magic link…</p>
                )}
              </form>
            </>
          )}
        </div>
      </div>

    </div>
  );
}

function LastUsedBadge(): React.ReactElement {
  return (
    <span
      className="absolute z-10 px-1.5 py-0.5 text-[10px] font-medium rounded uppercase tracking-wide"
      style={{
        top: '-7px',
        right: '12px',
        backgroundColor: '#fff',
        border: '1px solid #ddddd8',
        color: '#888',
        lineHeight: 1,
      }}
    >
      Last used
    </span>
  );
}

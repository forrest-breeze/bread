// @vitest-environment happy-dom

import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  getClaims: vi.fn(),
  onAuthStateChange: vi.fn(),
  signInWithOAuth: vi.fn(),
  signInWithOtp: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock('next/image', () => ({
  default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} />,
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth }),
}));

import { GOOGLE_SIGN_IN_ENABLED, LoginForm } from './login-form';

describe('LoginForm OAuth', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    auth.getClaims.mockResolvedValue({ data: { claims: null }, error: null });
    auth.onAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } },
    });
    auth.signInWithOAuth.mockResolvedValue({
      data: { provider: 'google', url: 'https://accounts.google.com/o/oauth2/auth' },
      error: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it.skipIf(GOOGLE_SIGN_IN_ENABLED)('shows Google greyed out and does nothing while it is disabled', () => {
    render(<LoginForm next="/dashboard" privatePortalLogin={false} />);

    const google = screen.getByRole('button', { name: 'Continue with Google' });
    expect(google).toBeDisabled();
    expect(screen.getByText(/Temporarily unavailable/)).toBeInTheDocument();
    fireEvent.click(google);
    expect(auth.signInWithOAuth).not.toHaveBeenCalled();
  });

  it('offers Google only, with no GitHub sign-in', () => {
    render(<LoginForm next="/dashboard" privatePortalLogin={false} />);

    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue with GitHub' })).toBeNull();
  });

  it.skipIf(!GOOGLE_SIGN_IN_ENABLED)('starts Google OAuth with the shared auth callback and preserves an invite return', async () => {
    window.sessionStorage.setItem('bread:pending-invite', 'invite-code');
    render(<LoginForm next="/dashboard" privatePortalLogin={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));

    await waitFor(() => {
      expect(auth.signInWithOAuth).toHaveBeenCalledWith({
        provider: 'google',
        options: {
          redirectTo:
            'http://localhost:3000/auth/callback?next=%2Fjoin%3Fcode%3Dinvite-code',
          queryParams: { prompt: 'select_account' },
        },
      });
    });
    expect(window.localStorage.getItem('bread:last-login-method')).toBe('google');
    expect(window.sessionStorage.getItem('bread:pending-invite')).toBeNull();
  });

  it.skipIf(!GOOGLE_SIGN_IN_ENABLED)('keeps the Google account chooser behavior', async () => {
    render(<LoginForm next="/knowledge" privatePortalLogin={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));

    await waitFor(() => {
      expect(auth.signInWithOAuth).toHaveBeenCalledWith({
        provider: 'google',
        options: {
          redirectTo: 'http://localhost:3000/auth/callback?next=%2Fknowledge',
          queryParams: { prompt: 'select_account' },
        },
      });
    });
  });

  it.skipIf(!GOOGLE_SIGN_IN_ENABLED)('shows provider errors and does not remember a failed Google attempt', async () => {
    auth.signInWithOAuth.mockResolvedValueOnce({
      data: { provider: 'google', url: null },
      error: { message: 'Google sign-in is not enabled' },
    });
    render(<LoginForm next="/dashboard" privatePortalLogin={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));

    expect(await screen.findByText('Google sign-in is not enabled')).toBeInTheDocument();
    expect(window.localStorage.getItem('bread:last-login-method')).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  });
});

describe('LoginForm callback notice', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    auth.getClaims.mockResolvedValue({ data: { claims: null }, error: null });
    auth.onAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } },
    });
    auth.signInWithOtp.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('surfaces a failed callback reason and clears it once a new link is requested', async () => {
    render(
      <LoginForm
        next="/dashboard"
        privatePortalLogin={false}
        authError="That sign-in link has expired."
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent('That sign-in link has expired.');

    fireEvent.change(screen.getByPlaceholderText('you@breeze.com'), {
      target: { value: 'member@breeze.com' },
    });
    fireEvent.submit(screen.getByPlaceholderText('you@breeze.com').closest('form')!);

    await waitFor(() => expect(auth.signInWithOtp).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('refuses a non-Breeze email without contacting Supabase', async () => {
    render(<LoginForm next="/dashboard" privatePortalLogin={false} />);

    fireEvent.change(screen.getByPlaceholderText('you@breeze.com'), {
      target: { value: 'someone@gmail.com' },
    });
    fireEvent.submit(screen.getByPlaceholderText('you@breeze.com').closest('form')!);

    expect(await screen.findByRole('alert')).toHaveTextContent('Only Breeze accounts');
    expect(auth.signInWithOtp).not.toHaveBeenCalled();
  });

  it('renders no notice on a clean login', () => {
    render(<LoginForm next="/dashboard" privatePortalLogin={false} />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('LoginForm access gate', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    auth.getClaims.mockResolvedValue({ data: { claims: null }, error: null });
    auth.onAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('hides every login method until the access code is accepted', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<LoginForm next="/dashboard" privatePortalLogin={false} accessRequired />);

    expect(screen.queryByRole('button', { name: 'Continue with Google' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('you@breeze.com')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Access code'), {
      target: { value: 'preview-passphrase' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock login' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/auth/login-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'preview-passphrase' }),
      });
    });
    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('you@breeze.com')).toBeInTheDocument();
  });

  it('keeps login methods hidden after an invalid access code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: vi.fn().mockResolvedValue({ error: 'Invalid access code.' }),
    }));
    render(<LoginForm next="/dashboard" privatePortalLogin={false} accessRequired />);

    fireEvent.change(screen.getByLabelText('Access code'), {
      target: { value: 'wrong-code' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock login' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid access code.');
    expect(screen.queryByRole('button', { name: 'Continue with Google' })).not.toBeInTheDocument();
  });
});

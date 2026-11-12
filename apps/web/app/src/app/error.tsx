"use client";

import { useRouter } from "next/navigation";

export default function ErrorBoundary({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  // `reset()` alone only re-renders the errored segment against the *same*
  // cached server output, so a deterministic error (failed data fetch, stale
  // RSC payload) recurs and the UI appears frozen. Refresh server data first,
  // then reset the boundary against the fresh render.
  const handleTryAgain = (): void => {
    router.refresh();
    reset();
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="text-muted-foreground max-w-md">
        An unexpected error occurred. Please try again — if the problem
        persists, reload the page.
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleTryAgain}
          className="rounded-md border px-4 py-2 hover:bg-accent"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="text-muted-foreground hover:text-foreground rounded-md px-4 py-2 text-sm underline-offset-4 hover:underline"
        >
          Reload page
        </button>
      </div>
    </div>
  );
}

"use client";

/**
 * Last-resort boundary for errors thrown in the ROOT layout / template or an
 * early streaming phase — the ~1% that `app/error.tsx` cannot catch. It
 * replaces the entire document (including `<html>`/`<body>`), so the app's
 * stylesheet and providers are absent; styling is inlined to stay self-
 * contained. Without this, such errors render the host platform's raw,
 * unbranded crash page.
 */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          padding: "1.5rem",
          textAlign: "center",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          color: "#0a0a0a",
          background: "#fafafa",
        }}
      >
        <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: 0 }}>
          Something went wrong
        </h1>
        <p style={{ maxWidth: "28rem", color: "#525252", margin: 0 }}>
          An unexpected error occurred. Please try again — if the problem
          persists, reload the page.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              borderRadius: "0.375rem",
              border: "1px solid #d4d4d4",
              padding: "0.5rem 1rem",
              background: "transparent",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              borderRadius: "0.375rem",
              border: "none",
              padding: "0.5rem 1rem",
              background: "transparent",
              color: "#525252",
              fontSize: "0.875rem",
              cursor: "pointer",
            }}
          >
            Reload page
          </button>
        </div>
      </body>
    </html>
  );
}

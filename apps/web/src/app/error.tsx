'use client';

export default function ErrorBoundary({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <>
      <h1>Something went wrong</h1>
      <p role="alert">An unexpected error occurred.</p>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </>
  );
}

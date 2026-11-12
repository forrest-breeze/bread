"use client"

import { useCallback, useState } from "react"
import { useSWRConfig, type Arguments } from "swr"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseOptimisticMutationOptions<
  TKey extends Arguments,
  TData,
  TArgs,
  TResult,
> {
  /**
   * The SWR cache key to update optimistically.  Accepts any value that SWR
   * accepts as a key (string, tuple, object, null, undefined, false).
   */
  key: TKey

  /**
   * Pure function that returns the optimistic cache value.  Receives the
   * current cached value (possibly `undefined` on a cold cache) and the
   * mutation arguments.  Must not mutate `current` in-place.
   */
  updater: (current: TData | undefined, args: TArgs) => TData

  /**
   * The async request to perform.  On rejection the SWR cache is
   * automatically rolled back to the snapshot taken before the optimistic
   * write.
   */
  request: (args: TArgs) => Promise<TResult>

  /**
   * Whether SWR should revalidate (re-fetch) after the mutation settles.
   * Defaults to `true`.
   */
  revalidate?: boolean

  /**
   * Whether SWR should write the new value into the cache after the async
   * updater resolves.  Defaults to `true`.
   */
  populateCache?: boolean

  /** Called with the server response when `request` resolves. */
  onSuccess?: (result: TResult, args: TArgs) => void

  /** Called with the thrown value when `request` rejects. */
  onError?: (error: unknown, args: TArgs) => void
}

export interface UseOptimisticMutationResult<TArgs, TResult> {
  /**
   * Trigger the optimistic mutation.  Returns a Promise that resolves with
   * the value returned by `request`, or rejects after the cache has been
   * rolled back.
   */
  mutate: (args: TArgs) => Promise<TResult>

  /** `true` while `request` is in-flight. */
  isMutating: boolean

  /** The error thrown by the most recent failed `request`, or `null`. */
  error: unknown | null
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * `useOptimisticMutation` wraps the SWR global `mutate` to provide ergonomic
 * optimistic updates with automatic rollback.
 *
 * It abstracts the ad-hoc pattern used in `sidebar.tsx`:
 *
 * ```ts
 * await swrMutate(
 *   (prev) => [...(prev ?? []), ws],
 *   { revalidate: true, populateCache: true, rollbackOnError: true },
 * )
 * ```
 *
 * Usage:
 *
 * ```ts
 * const { mutate, isMutating } = useOptimisticMutation({
 *   key: "/api/folders",
 *   updater: (current, newFolder) => [...(current ?? []), newFolder],
 *   request: (newFolder) =>
 *     fetch("/api/folders", { method: "POST", body: JSON.stringify(newFolder) })
 *       .then(r => r.json()),
 * })
 * ```
 *
 * Flow:
 *  1. Apply `updater(currentCache, args)` as the optimistic value immediately.
 *  2. Fire `request(args)` inside the SWR async updater.
 *  3. On success — call `onSuccess`, trigger revalidation if `revalidate: true`.
 *  4. On error — SWR rolls back the cache; call `onError`, rethrow.
 *
 * The resolved `TResult` is captured in a closure variable inside the SWR
 * updater and returned directly to the caller so the returned Promise carries
 * the correct type rather than SWR's internal `TData | undefined`.
 *
 * Note: the returned `mutate` identity is keyed off every option (including
 * `request`, `onSuccess`, `onError`). Pass `useCallback`-wrapped callbacks if
 * you depend on `mutate`'s stable identity (e.g. as a `useEffect` dep).
 */
export function useOptimisticMutation<
  TKey extends Arguments,
  TData,
  TArgs,
  TResult,
>(
  options: UseOptimisticMutationOptions<TKey, TData, TArgs, TResult>,
): UseOptimisticMutationResult<TArgs, TResult> {
  const {
    key,
    updater,
    request,
    onSuccess,
    onError,
    revalidate = true,
    populateCache = true,
  } = options

  const { mutate: globalMutate } = useSWRConfig()

  const [isMutating, setIsMutating] = useState<boolean>(false)
  const [error, setError] = useState<unknown | null>(null)

  const mutate = useCallback(
    async (args: TArgs): Promise<TResult> => {
      // Clear previous error on every new attempt.
      setError(null)
      setIsMutating(true)

      // SWR's async updater must return TData, but the caller expects TResult.
      // Capture the real server result in a closure variable inside the
      // updater and return it directly after globalMutate resolves.
      let capturedResult: TResult | undefined

      try {
        // SWR overload: (key: Arguments, data: MutatorCallback, opts)
        //   - `optimisticData` is applied immediately (before the async fn).
        //   - The async fn is awaited; on rejection SWR restores the snapshot.
        //   - `rollbackOnError: true` guarantees rollback on throw.
        await globalMutate<TData, TData>(
          key,
          async (current: TData | undefined): Promise<TData> => {
            const serverResult = await request(args)
            capturedResult = serverResult
            return updater(current, args)
          },
          {
            optimisticData: (current: TData | undefined): TData =>
              updater(current, args),
            revalidate,
            populateCache,
            rollbackOnError: true,
          },
        )

        // `request` resolved — fire success callback and surface TResult.
        onSuccess?.(capturedResult as TResult, args)
        return capturedResult as TResult
      } catch (err: unknown) {
        // SWR has already restored the pre-mutation cache snapshot.
        setError(err)
        onError?.(err, args)
        throw err
      } finally {
        setIsMutating(false)
      }
    },
    [globalMutate, key, updater, request, onSuccess, onError, revalidate, populateCache],
  )

  return { mutate, isMutating, error }
}

"use client";
import {
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  type SetStateAction,
} from "react";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import {
  getIntakeMemory,
  notifyIntakeMemory,
  type IntakeViewMemory,
} from "@/app/lib/intakeMemory";
/** Retrieve tab-only draft memory isolated by account, organization and view identity. */
export function useIntakeMemory(orgId: string, identity: string) {
  const { accountId } = useWorkspace();
  return useMemo(
    () => getIntakeMemory(accountId!, orgId, identity),
    [accountId, orgId, identity],
  );
}
/** Subscribe React to immutable snapshots of the retained view state. */
export function useIntakeMemorySnapshot(view: IntakeViewMemory) {
  const subscribe = useCallback(
    (listener: () => void) => {
      view.listeners.add(listener);
      return () => {
        view.listeners.delete(listener);
      };
    },
    [view],
  );
  return useSyncExternalStore(
    subscribe,
    () => view.snapshot,
    () => view.snapshot,
  );
}
/** Capture the final keystroke synchronously, before a route can unmount. */
export function useIntakeDraft<T>(
  view: IntakeViewMemory,
  key: string,
  initial: T | (() => T),
) {
  const snapshot = useIntakeMemorySnapshot(view);
  const [fallback] = useState(initial);
  const value = snapshot.values.has(key)
    ? (snapshot.values.get(key) as T)
    : fallback;
  const setValue = useCallback(
    (next: SetStateAction<T>) => {
      if (!view.valid) return;
      const previous = view.values.has(key)
        ? (view.values.get(key) as T)
        : fallback;
      view.values.set(
        key,
        typeof next === "function"
          ? (next as (previous: T) => T)(previous)
          : next,
      );
      notifyIntakeMemory(view);
    },
    [view, key, fallback],
  );
  return [value, setValue] as const;
}

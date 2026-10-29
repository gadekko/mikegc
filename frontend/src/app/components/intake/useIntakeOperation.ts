"use client";
import { useEffect, useState } from "react";
import {
  createIntakeMemory,
  notifyIntakeMemory,
  type IntakeViewMemory,
} from "@/app/lib/intakeMemory";
import { useIntakeMemorySnapshot } from "./useIntakeMemory";
import type { IntakeReceipt } from "@mike/contracts";
import { describeError, notifyError } from "@/app/lib/userFacingError";

/** A receipt belongs to its retained view, never the route currently on screen. */
export function useIntakeOperation(
  onSaved: (receipt: IntakeReceipt) => void,
  onRejected?: (error: unknown) => void,
  retained?: IntakeViewMemory,
) {
  const [local] = useState(createIntakeMemory);
  const view = retained ?? local;
  const snapshot = useIntakeMemorySnapshot(view);
  useEffect(() => {
    if (!view.valid || !snapshot.outcome || view.outcome !== snapshot.outcome)
      return;
    const outcome = snapshot.outcome;
    view.outcome = null;
    notifyIntakeMemory(view);
    if ("receipt" in outcome) onSaved(outcome.receipt);
    else {
      onRejected?.(outcome.error);
      notifyError(outcome.error, {
        action: view.uncertain
          ? "confirm whether the request was saved"
          : "save the request",
      });
    }
  }, [view, snapshot.outcome, onSaved, onRejected]);
  /** Run or reconcile the retained command without replacing an unresolved operation. */
  async function execute(operation?: () => Promise<IntakeReceipt>) {
    if (!view.valid || view.busy || view.outcome || (view.pending && operation))
      return;
    if (operation) view.pending = operation;
    const command = view.pending;
    if (!command) return;
    view.busy = true;
    notifyIntakeMemory(view);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const receipt = await command();
          if (
            !receipt ||
            !Number.isInteger(receipt.applied_version) ||
            typeof receipt.replayed !== "boolean"
          )
            throw new Error("Invalid intake acknowledgement");
          if (!view.valid) return;
          view.pending = null;
          view.uncertain = false;
          view.outcome = { receipt };
          return;
        } catch (error) {
          if (!view.valid) return;
          const status =
            error && typeof error === "object" && "status" in error
              ? Number(error.status)
              : 0;
          const code =
            error && typeof error === "object" && "code" in error
              ? error.code
              : null;
          if (status >= 400 && status < 500) {
            // Only these SQL rejections follow the immutable receipt lookup.
            // A gateway 429/400/409 says nothing about an earlier lost response.
            const definitive =
              !view.uncertain ||
              (status === 409 &&
                ["intake_conflict", "intake_paused", "intake_purged"].includes(
                  String(code),
                ));
            if (definitive) {
              view.pending = null;
              view.uncertain = false;
            }
            view.outcome = { error };
            return;
          }
          view.uncertain = true;
          if (attempt === 1 || view.listeners.size === 0) {
            view.outcome = { error };
            return;
          }
        }
      }
    } finally {
      view.busy = false;
      if (view.valid) notifyIntakeMemory(view);
    }
  }
  return {
    busy: snapshot.busy,
    uncertain: snapshot.uncertain,
    execute,
    locked: snapshot.busy || snapshot.uncertain || !!snapshot.outcome,
  };
}

/** Warn before leaving a draft; in-tab navigation retains it, explicit discard does not. */
export function useIntakeDraftWarning(dirty: boolean) {
  const confirmDiscard = () =>
    !dirty || window.confirm("Leave this draft? Unsaved text will be lost.");
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const navigation = (event: Event) => {
      if (
        !window.confirm("Leave this page? Your draft will remain in this tab.")
      )
        event.preventDefault();
    };
    const click = (event: MouseEvent) => {
      const link =
        event.target instanceof Element
          ? event.target.closest("a[href]")
          : null;
      if (
        !(link instanceof HTMLAnchorElement) ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        link.target === "_blank" ||
        link.download
      )
        return;
      if (
        link.href === window.location.href ||
        link.getAttribute("href")?.startsWith("#")
      )
        return;
      if (
        !window.confirm("Leave this page? Your draft will remain in this tab.")
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", warn);
    window.addEventListener("mike:before-workspace-change", navigation);
    window.addEventListener("mike:before-navigation", navigation);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener("mike:before-workspace-change", navigation);
      window.removeEventListener("mike:before-navigation", navigation);
      document.removeEventListener("click", click, true);
    };
  }, [dirty]);
  return confirmDiscard;
}
/** Describe an intake load failure without exposing raw service errors. */
export function intakeError(error: unknown) {
  return describeError(error, { action: "load intake requests" }).message;
}

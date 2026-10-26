"use client";
import { useEffect, useRef, useState } from "react";
import type { IntakeReceipt } from "@mike/contracts";
import { describeError, notifyError } from "@/app/lib/userFacingError";

/** Retain one immutable command until its receipt or a definitive rejection. */
export function useIntakeOperation(
  onSaved: (receipt: IntakeReceipt) => void,
  onRejected?: (error: unknown) => void,
) {
  const alive = useRef(true);
  const running = useRef(false);
  const pending = useRef<(() => Promise<IntakeReceipt>) | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function execute(operation?: () => Promise<IntakeReceipt>) {
    if (running.current || (pending.current && operation)) return;
    if (operation) pending.current = operation;
    const command = pending.current;
    if (!command) return;
    running.current = true;
    setBusy(true);
    let saved: IntakeReceipt | undefined;
    let unknown = uncertain;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const receipt = await command();
          if (
            !receipt ||
            !Number.isInteger(receipt.applied_version) ||
            typeof receipt.replayed !== "boolean"
          ) {
            throw new Error("Invalid intake acknowledgement");
          }
          if (!alive.current) return;
          pending.current = null;
          setUncertain(false);
          saved = receipt;
          break;
        } catch (error) {
          if (!alive.current) return;
          const status =
            error && typeof error === "object" && "status" in error
              ? Number(error.status)
              : 0;
          // Refresh access after any denial. A lost receipt followed by lost
          // access remains uncertain: retain that command without exposing data.
          if (status >= 400 && status < 500) {
            if (
              !(unknown && (status === 401 || status === 403 || status === 404))
            ) {
              pending.current = null;
              setUncertain(false);
            }
            onRejected?.(error);
            notifyError(error, { action: "save the legal request" });
            return;
          }
          unknown = true;
          setUncertain(true);
          if (attempt === 1)
            notifyError(error, {
              action: "confirm whether the legal request was saved",
            });
        }
      }
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
    // A rendering/navigation failure cannot make an acknowledged write uncertain.
    if (saved) onSaved(saved);
  }
  return { busy, uncertain, execute, locked: busy || uncertain };
}

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
      if (!window.confirm("Leave this draft? Unsaved text will be lost."))
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
      if (!window.confirm("Leave this draft? Unsaved text will be lost.")) {
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
export function intakeError(error: unknown) {
  return describeError(error, { action: "load legal requests" }).message;
}

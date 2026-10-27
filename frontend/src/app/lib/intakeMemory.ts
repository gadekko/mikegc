import type { IntakeReceipt } from "@mike/contracts";

export type IntakeMemorySnapshot = {
  version: number;
  values: ReadonlyMap<string, unknown>;
  busy: boolean;
  uncertain: boolean;
  outcome: { receipt: IntakeReceipt } | { error: unknown } | null;
};
/** Tab-memory only. Never persist legal text or command closures in browser storage. */
export type IntakeViewMemory = {
  valid: boolean;
  version: number;
  snapshot: IntakeMemorySnapshot;
  values: Map<string, unknown>;
  listeners: Set<() => void>;
  pending: (() => Promise<IntakeReceipt>) | null;
  busy: boolean;
  uncertain: boolean;
  outcome: { receipt: IntakeReceipt } | { error: unknown } | null;
};
let account: string | null = null;
const views = new Map<string, IntakeViewMemory>();
/** Create an empty tab-only draft and command state with a stable initial snapshot. */
export function createIntakeMemory(): IntakeViewMemory {
  return {
    valid: true,
    version: 0,
    snapshot: {
      version: 0,
      values: new Map(),
      busy: false,
      uncertain: false,
      outcome: null,
    },
    values: new Map(),
    listeners: new Set(),
    pending: null,
    busy: false,
    uncertain: false,
    outcome: null,
  };
}
/** Publish a new immutable snapshot after mutating the retained view state. */
export function notifyIntakeMemory(view: IntakeViewMemory) {
  view.version++;
  // React (including the compiler) must observe a new immutable snapshot.
  view.snapshot = {
    version: view.version,
    values: new Map(view.values),
    busy: view.busy,
    uncertain: view.uncertain,
    outcome: view.outcome,
  };
  view.listeners.forEach((listener) => listener());
}
/** Auth changes revoke closures as well as hiding drafts from the next account. */
export function setIntakeMemoryAccount(next: string | null) {
  if (next !== null && next === account) return;
  for (const view of views.values()) {
    view.valid = false;
    view.pending = null;
    view.outcome = null;
    view.values.clear();
    notifyIntakeMemory(view);
  }
  views.clear();
  account = next;
}
/** Reuse a view within its account and organization, revoking views on account changes. */
export function getIntakeMemory(
  accountId: string,
  orgId: string,
  identity: string,
) {
  if (account !== accountId) setIntakeMemoryAccount(accountId);
  const key = JSON.stringify([accountId, orgId, identity]);
  let view = views.get(key);
  if (!view) {
    view = createIntakeMemory();
    views.set(key, view);
  }
  return view;
}
/** Clear draft fields only when no command or undelivered outcome needs recovery. */
export function discardIntakeDraft(view: IntakeViewMemory) {
  if (view.busy || view.pending || view.outcome) return false;
  view.values.clear();
  notifyIntakeMemory(view);
  return true;
}

"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useIntakeMemory, useIntakeDraft } from "./useIntakeMemory";
import type {
  IntakeAction,
  IntakeEvent,
  IntakeMessage,
  IntakeRequest,
  IntakeReviewer,
} from "@mike/contracts";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import { useItemWorkspace } from "@/app/hooks/useItemWorkspace";
import {
  commandIntakeRequest,
  getIntakeEvents,
  getIntakeMessages,
  getIntakeRequest,
  getIntakeReviewers,
} from "@/app/lib/mikeApi";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { PAGE_HEADER_TITLE_CLASS } from "@/app/components/shared/pageHeaderStyles";
import {
  FieldLabel,
  FORM_CONTROL_GLASS_CLASS,
} from "@/app/components/ui/form-field";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import {
  intakeError,
  useIntakeDraftWarning,
  useIntakeOperation,
} from "./useIntakeOperation";
/** Scope a deep-linked request to its organization before mounting retained drafts. */
export function IntakeDetail({
  orgId,
  requestId,
}: {
  orgId: string;
  requestId: string;
}) {
  const { accountId, workspaceId } = useWorkspace();
  useItemWorkspace(requestId, orgId);
  if (!accountId || workspaceId !== orgId)
    return <p className="p-6">Open this request in its team workspace.</p>;
  return (
    <Detail
      key={`${accountId}:${orgId}:${requestId}`}
      orgId={orgId}
      requestId={requestId}
    />
  );
}
/** Read the complete message or event history using the API's 100-row pages. */
async function allPages<T>(read: (offset: number) => Promise<T[]>) {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await read(offset);
    rows.push(...page);
    if (page.length < 100) return rows;
  }
}
/** Show the current request and gate commands on its server-provided capabilities. */
export function Detail({
  orgId,
  requestId,
}: {
  orgId: string;
  requestId: string;
}) {
  const memory = useIntakeMemory(orgId, requestId);
  const [request, setRequest] = useState<IntakeRequest | null>(null);
  const [messages, setMessages] = useState<IntakeMessage[]>([]);
  const [events, setEvents] = useState<IntakeEvent[]>([]);
  const [reviewers, setReviewers] = useState<IntakeReviewer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useIntakeDraft(memory, "body", "");
  const [preview, setPreview] = useState<{
    body: string;
    version: number;
  } | null>(null);
  const [cancel, setCancel] = useState(false);
  const [assignee, setAssignee] = useState("");
  const epoch = useRef(0);
  const [pendingMessage, setPendingMessage] = useIntakeDraft(
    memory,
    "pendingMessage",
    false,
  );
  const refresh = useCallback(async () => {
    const generation = ++epoch.current;
    try {
      const r = await getIntakeRequest(orgId, requestId);
      const [m, e, roster] = await Promise.all([
        allPages((offset) => getIntakeMessages(orgId, requestId, offset)),
        allPages((offset) => getIntakeEvents(orgId, requestId, offset)),
        r.capabilities.assign ? getIntakeReviewers(orgId) : Promise.resolve([]),
      ]);
      if (generation !== epoch.current) return;
      setRequest(r);
      setMessages(m);
      setEvents(e);
      setReviewers(roster.filter((x) => x.is_reviewer));
      setAssignee(r.assignee_id ?? "");
      setError(null);
      setPreview((old) => (old?.version === r.version ? old : null));
    } catch (e) {
      if (generation === epoch.current) {
        setRequest(null);
        setMessages([]);
        setEvents([]);
        setReviewers([]);
        setPreview(null);
        setError(intakeError(e));
      }
    }
  }, [orgId, requestId]);
  const invalidate = useCallback(() => {
    epoch.current++;
  }, []);
  useEffect(() => {
    void refresh();
    return invalidate;
  }, [refresh, invalidate]);
  useEffect(() => {
    const focus = () => {
      setRequest(null);
      setPreview(null);
      void refresh();
    };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [refresh]);
  const operation = useIntakeOperation(
    () => {
      if (pendingMessage) setDraft("");
      setPreview(null);
      setCancel(false);
      void refresh();
    },
    () => {
      setRequest(null);
      setMessages([]);
      setEvents([]);
      setReviewers([]);
      setPreview(null);
      setCancel(false);
      void refresh();
    },
    memory,
  );
  useIntakeDraftWarning(!!draft || operation.locked);
  /** Capture the displayed request version and reuse one command when recovering a save. */
  function command(
    action: IntakeAction,
    body?: string,
    version = request?.version,
  ) {
    if (!version) return;
    const input = {
      command_id: crypto.randomUUID(),
      expected_version: version,
      ...(body !== undefined ? { body } : {}),
      ...(action === "assignment" ? { assignee_id: assignee || null } : {}),
    };
    setPendingMessage(body !== undefined);
    void operation.execute(async () => {
      const receipt = await commandIntakeRequest(
        orgId,
        requestId,
        action,
        input,
      );
      if (receipt.request_id !== requestId)
        throw new Error("Mismatched intake receipt");
      return receipt;
    });
  }
  return (
    <div className="h-full overflow-auto">
      <PageHeader>
        <h1 className={PAGE_HEADER_TITLE_CLASS}>Legal request</h1>
      </PageHeader>
      <div className="mx-auto max-w-4xl space-y-4 p-6 [overflow-wrap:anywhere]">
        <Link className="text-sm underline" href="/intake">
          Back to requests
        </Link>
        {error && (
          <div role="alert">
            {error}{" "}
            <PillButtonUI tone="black" onClick={() => void refresh()}>
              Try again
            </PillButtonUI>
          </div>
        )}
        {!request && !error && <p role="status">Loading request…</p>}
        {request && (
          <>
            <h2 className="font-serif text-2xl">{request.subject}</h2>
            <p>
              {request.state.replaceAll("_", " ")} ·{" "}
              {request.category === "nda" ? "NDA request" : "Legal question"}
            </p>
            <p>Requested by {request.requester_name}</p>
            <p>Assigned lawyer: {request.assignee_name ?? "Unassigned"}</p>
            {request.requested_by_date && (
              <p>
                Business target: {request.requested_by_date} ({request.timezone}
                ). This is not a legal deadline.
              </p>
            )}
            <p className="whitespace-pre-wrap">{request.description}</p>
            {request.capabilities.assign && (
              <div className="space-y-2">
                <FieldLabel htmlFor="intake-assignee">
                  Assigned lawyer
                </FieldLabel>
                <select
                  id="intake-assignee"
                  className={FORM_CONTROL_GLASS_CLASS + " h-10"}
                  value={assignee}
                  disabled={operation.locked}
                  onChange={(e) => setAssignee(e.target.value)}
                >
                  <option value="">Unassigned</option>
                  {reviewers.map((r) => (
                    <option key={r.user_id} value={r.user_id}>
                      {r.display_name ?? r.email ?? "Member"}
                    </option>
                  ))}
                </select>
                <PillButtonUI
                  tone="black"
                  disabled={operation.locked}
                  onClick={() => command("assignment")}
                >
                  Save assignment
                </PillButtonUI>
              </div>
            )}
            <h3 className="font-serif text-xl">Conversation</h3>
            {messages.length === 0 && <p>No messages yet.</p>}
            {messages.map((m) => (
              <article
                key={m.id}
                className="space-y-2 rounded-xl bg-app-surface p-4"
              >
                <p className="text-sm">
                  {m.author_name} · {m.kind} ·{" "}
                  {new Date(m.created_at).toLocaleString()}
                </p>
                <p className="whitespace-pre-wrap">{m.body}</p>
              </article>
            ))}
            {(request.capabilities.ask ||
              request.capabilities.reply ||
              request.capabilities.publish) && (
              <div className="space-y-2">
                <FieldLabel htmlFor="intake-message">
                  Message to{" "}
                  {request.capabilities.reply ? "Legal" : "the requester"}
                </FieldLabel>
                <textarea
                  id="intake-message"
                  className={FORM_CONTROL_GLASS_CLASS + " min-h-40 py-2"}
                  maxLength={20000}
                  value={draft}
                  disabled={operation.locked}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setPreview(null);
                  }}
                />
                <p className="text-sm text-muted-foreground">
                  Messages are shared with the requester and Legal. Unsaved text
                  stays in this tab when you navigate, but is lost if you
                  reload, close the tab or sign out.
                </p>
                <div className="flex flex-wrap gap-2">
                  {request.capabilities.ask && (
                    <PillButtonUI
                      tone="black"
                      disabled={!draft.trim() || operation.locked}
                      onClick={() => command("questions", draft)}
                    >
                      Ask for information
                    </PillButtonUI>
                  )}
                  {request.capabilities.reply && (
                    <PillButtonUI
                      tone="black"
                      disabled={!draft.trim() || operation.locked}
                      onClick={() => command("replies", draft)}
                    >
                      Send reply
                    </PillButtonUI>
                  )}
                  {request.capabilities.publish && (
                    <PillButtonUI
                      tone="black"
                      disabled={!draft.trim() || operation.locked}
                      onClick={() =>
                        setPreview({ body: draft, version: request.version })
                      }
                    >
                      Preview answer
                    </PillButtonUI>
                  )}
                </div>
              </div>
            )}
            {preview && request.capabilities.publish && (
              <section
                className="space-y-3 rounded-xl bg-app-surface p-4"
                aria-label="Answer preview"
              >
                <h3>Visible to the requester in MikeGC</h3>
                <p className="whitespace-pre-wrap">{preview.body}</p>
                <PillButtonUI
                  tone="black"
                  disabled={operation.locked}
                  onClick={() =>
                    command("answer", preview.body, preview.version)
                  }
                >
                  Share answer and resolve
                </PillButtonUI>
              </section>
            )}
            {request.capabilities.cancel && (
              <PillButtonUI
                tone="danger"
                disabled={operation.locked}
                onClick={() => setCancel(true)}
              >
                Cancel request
              </PillButtonUI>
            )}
            <details>
              <summary>Request history</summary>
              <ol className="space-y-2 py-3">
                {events.map((e) => (
                  <li key={e.id}>
                    {e.kind.replaceAll("_", " ")} · {e.actor_name} ·{" "}
                    {new Date(e.created_at).toLocaleString()}
                  </li>
                ))}
              </ol>
            </details>
          </>
        )}
        {operation.uncertain && (
          <p role="status">
            Checking whether it was saved. Your text is kept here.{" "}
            <PillButtonUI
              tone="black"
              disabled={operation.busy}
              onClick={() => void operation.execute()}
            >
              Check again
            </PillButtonUI>
          </p>
        )}
        <ConfirmPopup
          open={cancel}
          title="Cancel this request?"
          message="The conversation will stay available, but the request will become read-only."
          confirmLabel="Cancel request"
          onCancel={() => setCancel(false)}
          onConfirm={() => command("cancel")}
          confirmDisabled={operation.locked}
        />
      </div>
    </div>
  );
}

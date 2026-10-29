"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
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
import {
  SkeletonLine,
  TableEmptyState,
} from "@/app/components/shared/TablePrimitive";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { ModalTextarea } from "@/app/components/modals/ModalTextarea";
import { EmptyState } from "@/app/components/ui/empty-state";
import { FieldLabel } from "@/app/components/ui/form-field";
import { UserAvatar } from "@/app/components/ui/user-avatar";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { IntakeSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TextSlabUI } from "@/shared/ui/TextSlabUI";
import { INTAKE_STATE_LABELS } from "./IntakeInbox";
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
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <TableEmptyState>
          <EmptyState
            icon={<IntakeSkeuoIcon />}
            title="Intake"
            description="Open this request in its organization's workspace."
          />
        </TableEmptyState>
      </div>
    );
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
  const router = useRouter();
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
  const canWrite =
    !!request &&
    (request.capabilities.ask ||
      request.capabilities.reply ||
      request.capabilities.publish);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        shrink
        breadcrumbs={[
          {
            label: "Intake",
            onClick: () => router.push("/intake"),
            title: "Back to Intake",
          },
          {
            label: request?.subject,
            loading: !request && !error,
            cursor: "text",
          },
        ]}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-3 pb-6 md:mx-6.5 [overflow-wrap:anywhere]">
          {error ? (
            <TableEmptyState>
              <EmptyState
                tone="error"
                title="Unable to load request"
                description={<span role="alert">{error}</span>}
                action={
                  <PillButtonUI
                    tone="black"
                    size="sm"
                    onClick={() => void refresh()}
                  >
                    Try again
                  </PillButtonUI>
                }
              />
            </TableEmptyState>
          ) : !request ? (
            <DetailSkeleton />
          ) : (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
              <div className="min-w-0 space-y-4">
                <GlassCardUI>
                  <div className="space-y-3 p-5">
                    <h1 className="font-serif text-2xl text-gray-900">
                      {request.subject}
                    </h1>
                    <p className="text-xs text-gray-500">
                      {request.requester_name} ·{" "}
                      {formatDateTime(request.created_at)}
                    </p>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                      {request.description}
                    </p>
                  </div>
                </GlassCardUI>

                <section
                  aria-labelledby="intake-conversation"
                  className="space-y-2"
                >
                  <h2
                    id="intake-conversation"
                    className="text-sm font-medium text-gray-900"
                  >
                    Conversation
                  </h2>
                  {messages.length === 0 ? (
                    <p className="text-sm text-gray-500">No messages yet.</p>
                  ) : (
                    messages.map((m) => (
                      <GlassCardUI key={m.id}>
                        <div className="space-y-2 p-4">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
                            <UserAvatar size="sm" name={m.author_name} />
                            <span className="font-medium text-gray-700">
                              {m.author_name}
                            </span>
                            <span>{MESSAGE_KIND_LABELS[m.kind]}</span>
                            <time dateTime={m.created_at}>
                              {formatDateTime(m.created_at)}
                            </time>
                          </div>
                          <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                            {m.body}
                          </p>
                        </div>
                      </GlassCardUI>
                    ))
                  )}
                </section>

                {canWrite && (
                  <GlassCardUI>
                    <div className="space-y-3 p-4">
                      <FieldLabel htmlFor="intake-message">
                        Message to{" "}
                        {request.capabilities.reply ? "Legal" : "the requester"}
                      </FieldLabel>
                      <ModalTextarea
                        id="intake-message"
                        className="min-h-32"
                        maxLength={20000}
                        value={draft}
                        disabled={operation.locked}
                        onChange={(e) => {
                          setDraft(e.target.value);
                          setPreview(null);
                        }}
                      />
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs text-gray-500">
                          Shared with the requester and the Legal team.
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {request.capabilities.ask && (
                            <PillButtonUI
                              tone={
                                request.capabilities.publish ? "white" : "black"
                              }
                              size="sm"
                              disabled={!draft.trim() || operation.locked}
                              onClick={() => command("questions", draft)}
                            >
                              Ask for information
                            </PillButtonUI>
                          )}
                          {request.capabilities.reply && (
                            <PillButtonUI
                              tone="black"
                              size="sm"
                              disabled={!draft.trim() || operation.locked}
                              onClick={() => command("replies", draft)}
                            >
                              Send reply
                            </PillButtonUI>
                          )}
                          {request.capabilities.publish && (
                            <PillButtonUI
                              tone="black"
                              size="sm"
                              disabled={!draft.trim() || operation.locked}
                              onClick={() =>
                                setPreview({
                                  body: draft,
                                  version: request.version,
                                })
                              }
                            >
                              Preview answer
                            </PillButtonUI>
                          )}
                        </div>
                      </div>
                    </div>
                  </GlassCardUI>
                )}

                {preview && request.capabilities.publish && (
                  <GlassCardUI>
                    <div className="p-4">
                      <section
                        aria-label="Answer preview"
                        className="space-y-3"
                      >
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-gray-900">
                            Answer preview
                          </p>
                          <p className="text-xs text-gray-500">
                            The requester will see exactly this text, and the
                            request will be resolved.
                          </p>
                        </div>
                        <TextSlabUI className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                          {preview.body}
                        </TextSlabUI>
                        <div className="flex justify-end">
                          <PillButtonUI
                            tone="black"
                            size="sm"
                            disabled={operation.locked}
                            onClick={() =>
                              command("answer", preview.body, preview.version)
                            }
                          >
                            Share answer and resolve
                          </PillButtonUI>
                        </div>
                      </section>
                    </div>
                  </GlassCardUI>
                )}
              </div>

              <aside className="min-w-0 space-y-4" aria-label="Request details">
                <GlassCardUI>
                  <dl>
                    <DetailRow label="Status">
                      {INTAKE_STATE_LABELS[request.state]}
                    </DetailRow>
                    <DetailRow label="Type">
                      {request.category === "nda"
                        ? "NDA request"
                        : "Legal question"}
                    </DetailRow>
                    <DetailRow label="Requested by">
                      {request.requester_name}
                    </DetailRow>
                    <DetailRow
                      label={
                        request.capabilities.assign ? (
                          <label htmlFor="intake-assignee">
                            Assigned lawyer
                          </label>
                        ) : (
                          "Assigned lawyer"
                        )
                      }
                    >
                      {request.capabilities.assign ? (
                        <div className="space-y-2">
                          <ModalSelect
                            id="intake-assignee"
                            variant="flat"
                            value={assignee}
                            placeholder="Unassigned"
                            disabled={operation.locked}
                            options={[
                              { value: "", label: "Unassigned" },
                              ...reviewers.map((r) => ({
                                value: r.user_id,
                                label: r.display_name ?? r.email ?? "Member",
                              })),
                            ]}
                            onChange={setAssignee}
                          />
                          {assignee !== (request.assignee_id ?? "") && (
                            <PillButtonUI
                              tone="black"
                              size="sm"
                              disabled={operation.locked}
                              onClick={() => command("assignment")}
                            >
                              Save assignment
                            </PillButtonUI>
                          )}
                        </div>
                      ) : (
                        (request.assignee_name ?? (
                          <span className="text-gray-400">Unassigned</span>
                        ))
                      )}
                    </DetailRow>
                    {request.requested_by_date && (
                      <DetailRow label="Target date">
                        {request.requested_by_date}
                        {request.timezone && (
                          <span className="block text-xs text-gray-500">
                            {request.timezone} · not a legal deadline
                          </span>
                        )}
                      </DetailRow>
                    )}
                    <DetailRow label="Updated">
                      {formatDateTime(request.updated_at)}
                    </DetailRow>
                  </dl>
                  {request.capabilities.cancel && (
                    <div className="border-t border-gray-100 p-4">
                      <PillButtonUI
                        tone="danger"
                        size="sm"
                        disabled={operation.locked}
                        onClick={() => setCancel(true)}
                      >
                        Cancel request
                      </PillButtonUI>
                    </div>
                  )}
                </GlassCardUI>

                {events.length > 0 && (
                  <section
                    aria-labelledby="intake-history"
                    className="space-y-2"
                  >
                    <h2
                      id="intake-history"
                      className="text-sm font-medium text-gray-900"
                    >
                      History
                    </h2>
                    <GlassCardUI>
                      <ol>
                        {events.map((e) => (
                          <li
                            key={e.id}
                            className="border-t border-gray-100 px-4 py-2.5 first:border-t-0"
                          >
                            <p className="text-sm text-gray-700">
                              {EVENT_LABELS[e.kind] ??
                                e.kind.replaceAll("_", " ")}
                            </p>
                            <p className="text-xs text-gray-500">
                              {e.actor_name} ·{" "}
                              <time dateTime={e.created_at}>
                                {formatDateTime(e.created_at)}
                              </time>
                            </p>
                          </li>
                        ))}
                      </ol>
                    </GlassCardUI>
                  </section>
                )}
              </aside>
            </div>
          )}
          {operation.uncertain && (
            <div
              className="mt-4 flex flex-wrap items-center gap-3"
              role="status"
            >
              <span className="text-sm text-gray-500">
                Checking whether it was saved. Your text is kept here.
              </span>
              <PillButtonUI
                tone="white"
                size="sm"
                disabled={operation.busy}
                onClick={() => void operation.execute()}
              >
                Check again
              </PillButtonUI>
            </div>
          )}
        </div>
      </div>
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
  );
}

const MESSAGE_KIND_LABELS: Record<IntakeMessage["kind"], string> = {
  question: "Asked for information",
  reply: "Replied",
  answer: "Answered",
};

const EVENT_LABELS: Record<string, string> = {
  submitted: "Submitted",
  assign: "Assignment changed",
  ask: "Asked for information",
  reply: "Replied",
  publish: "Answered and resolved",
  cancel: "Cancelled",
  reviewer_removed: "Unassigned when the lawyer left the Legal team",
};

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function DetailRow({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1 border-t border-gray-100 px-4 py-3 first:border-t-0">
      <dt className="text-xs font-medium text-gray-500">{label}</dt>
      <dd className="text-sm text-gray-900">{children}</dd>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <>
      <span role="status" className="sr-only">
        Loading request…
      </span>
      <div
        className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]"
        aria-hidden="true"
      >
        <GlassCardUI>
          <div className="space-y-3 p-5">
            <SkeletonLine className="h-5 w-64" />
            <SkeletonLine className="w-32" />
            <SkeletonLine className="w-full" />
            <SkeletonLine className="w-5/6" />
          </div>
        </GlassCardUI>
        <GlassCardUI>
          {["w-20", "w-24", "w-28", "w-24"].map((width, row) => (
            <div
              key={row}
              className="space-y-2 border-t border-gray-100 px-4 py-3 first:border-t-0"
            >
              <SkeletonLine className="w-16" />
              <SkeletonLine className={width} />
            </div>
          ))}
        </GlassCardUI>
      </div>
    </>
  );
}

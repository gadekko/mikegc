"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  IntakeConfiguration,
  IntakeRequest,
  IntakeSubmission,
  IntakeReviewer,
} from "@mike/contracts";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import {
  getIntakeConfiguration,
  getIntakeReviewers,
  listIntakeRequests,
  submitIntakeRequest,
} from "@/app/lib/mikeApi";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { PAGE_HEADER_TITLE_CLASS } from "@/app/components/shared/pageHeaderStyles";
import {
  TableBody,
  TableCell,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
  TableScrollArea,
} from "@/app/components/shared/TablePrimitive";
import {
  FormTextInput,
  FieldLabel,
  FORM_CONTROL_GLASS_CLASS,
} from "@/app/components/ui/form-field";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import {
  intakeError,
  useIntakeDraftWarning,
  useIntakeOperation,
} from "./useIntakeOperation";

export function IntakeInbox() {
  const { accountId, activeOrganization } = useWorkspace();
  if (!accountId || !activeOrganization)
    return (
      <p className="p-6">Choose a team workspace to use Legal requests.</p>
    );
  return (
    <Inbox
      key={`${accountId}:${activeOrganization.id}`}
      orgId={activeOrganization.id}
    />
  );
}
export function Inbox({ orgId }: { orgId: string }) {
  const router = useRouter();
  const [config, setConfig] = useState<IntakeConfiguration | null>(null);
  const [reviewers, setReviewers] = useState<IntakeReviewer[]>([]);
  const [assignee, setAssignee] = useState("");
  const [rows, setRows] = useState<IntakeRequest[] | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"mine" | "queue">("mine");
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [state, setState] = useState("");
  const [reload, setReload] = useState(0);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    let active = true;
    getIntakeConfiguration(orgId)
      .then(async (c) => {
        const roster = c.is_reviewer ? await getIntakeReviewers(orgId) : [];
        if (active) {
          setReviewers(roster);
          setConfig(c);
          setConfigError(null);
        }
      })
      .catch((e) => {
        if (active) {
          setReviewers([]);
          setConfig(null);
          setConfigError(intakeError(e));
        }
      });
    return () => {
      active = false;
    };
  }, [orgId, reload]);
  useEffect(() => {
    let active = true;
    listIntakeRequests(orgId, {
      view,
      offset,
      search,
      ...(state ? { state } : {}),
      ...(assignee && view === "queue" ? { assignee } : {}),
    })
      .then((r) => {
        if (active) {
          setRows(r);
          setError(null);
        }
      })
      .catch((e) => {
        if (active) {
          setRows(null);
          setError(intakeError(e));
        }
      });
    return () => {
      active = false;
    };
  }, [orgId, view, offset, search, state, assignee, reload]);
  useEffect(() => {
    const refresh = () => {
      setRows(null);
      setConfig(null);
      setReload((x) => x + 1);
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  const filter = (fn: () => void) => {
    setRows(null);
    setOffset(0);
    fn();
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader>
        <h1 className={PAGE_HEADER_TITLE_CLASS}>Legal requests</h1>
      </PageHeader>
      <div className="flex flex-wrap items-center gap-2 px-6 py-3">
        <TabPillButtonUI
          active={view === "mine"}
          onClick={() => filter(() => setView("mine"))}
        >
          My requests
        </TabPillButtonUI>
        {config?.is_reviewer && (
          <TabPillButtonUI
            active={view === "queue"}
            onClick={() => filter(() => setView("queue"))}
          >
            Legal queue
          </TabPillButtonUI>
        )}
        {view === "queue" && config?.is_reviewer && (
          <select
            aria-label="Filter by assigned lawyer"
            className={FORM_CONTROL_GLASS_CLASS + " h-10 max-w-xs"}
            value={assignee}
            onChange={(e) => filter(() => setAssignee(e.target.value))}
          >
            <option value="">All assigned lawyers</option>
            {reviewers.map((r) => (
              <option key={r.user_id} value={r.user_id}>
                {r.display_name ?? r.email ?? "Member"}
              </option>
            ))}
          </select>
        )}
        <PillButtonUI
          tone="black"
          type="button"
          disabled={!config?.enabled}
          onClick={() => setCreating(true)}
        >
          New request
        </PillButtonUI>
        {config?.can_configure && (
          <Link
            className="text-sm underline"
            href={`/organizations/${orgId}/settings/intake`}
          >
            Intake settings
          </Link>
        )}
        <FormTextInput
          aria-label="Search requests"
          placeholder="Search requests"
          value={search}
          onChange={(e) => filter(() => setSearch(e.target.value))}
          className="max-w-xs"
        />
        <select
          aria-label="Request status"
          className={FORM_CONTROL_GLASS_CLASS + " h-10 max-w-xs"}
          value={state}
          onChange={(e) => filter(() => setState(e.target.value))}
        >
          <option value="">All statuses</option>
          {[
            "submitted",
            "in_review",
            "needs_information",
            "resolved",
            "cancelled",
          ].map((s) => (
            <option key={s} value={s}>
              {s.replaceAll("_", " ")}
            </option>
          ))}
        </select>
      </div>
      {config && !config.enabled && (
        <p className="px-6 text-sm">
          {config.configured
            ? "Intake is paused. Existing requests are read-only."
            : "Your organization has not enabled intake yet."}
        </p>
      )}
      {creating && (
        <RequestForm
          orgId={orgId}
          enabled={!!config?.enabled}
          onClose={() => setCreating(false)}
          onSaved={(id) => router.push(`/intake/${id}?org=${orgId}`)}
        />
      )}
      {error || configError ? (
        <div className="p-6" role="alert">
          {error || configError}{" "}
          <PillButtonUI
            tone="black"
            onClick={() => {
              setRows(null);
              setError(null);
              setReload((x) => x + 1);
            }}
          >
            Try again
          </PillButtonUI>
        </div>
      ) : rows === null ? (
        <p className="p-6" role="status">
          Loading requests…
        </p>
      ) : (
        <TableScrollArea>
          <TableHeaderRow>
            <TableHeaderCell className="w-64 px-3">Request</TableHeaderCell>
            <TableHeaderCell className="w-40 px-3">Status</TableHeaderCell>
            <TableHeaderCell className="w-48 px-3">
              Assigned lawyer
            </TableHeaderCell>
          </TableHeaderRow>
          <TableBody>
            {rows.length === 0 ? (
              <p className="p-6">No requests found.</p>
            ) : (
              rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="w-64 px-3">
                    <Link
                      className="underline [overflow-wrap:anywhere]"
                      href={`/intake/${r.id}?org=${orgId}`}
                    >
                      {r.subject}
                    </Link>
                  </TableCell>
                  <TableCell className="w-40 px-3">
                    {r.state.replaceAll("_", " ")}
                  </TableCell>
                  <TableCell className="w-48 px-3">
                    {r.assignee_name ?? "Unassigned"}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </TableScrollArea>
      )}
      <div className="flex gap-2 p-6">
        <PillButtonUI
          tone="black"
          disabled={offset === 0}
          onClick={() => {
            setRows(null);
            setOffset((x) => Math.max(0, x - 50));
          }}
        >
          Previous
        </PillButtonUI>
        <PillButtonUI
          tone="black"
          disabled={!rows || rows.length < 50}
          onClick={() => {
            setRows(null);
            setOffset((x) => x + 50);
          }}
        >
          Next
        </PillButtonUI>
      </div>
    </div>
  );
}
function RequestForm({
  orgId,
  enabled,
  onSaved,
  onClose,
}: {
  orgId: string;
  enabled: boolean;
  onSaved: (id: string) => void;
  onClose: () => void;
}) {
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<"nda" | "general">("general");
  const [date, setDate] = useState("");
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const operation = useIntakeOperation((receipt) => {
    if (receipt.request_id) onSaved(receipt.request_id);
  });
  const confirmDiscard = useIntakeDraftWarning(
    !!subject || !!description || !!date || operation.uncertain,
  );
  return (
    <form
      className="mx-6 mb-4 space-y-3 rounded-xl bg-app-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const body: IntakeSubmission = {
          id: crypto.randomUUID(),
          command_id: crypto.randomUUID(),
          subject,
          description,
          category,
          requested_by_date: date || null,
          timezone: date ? timezone : null,
        };
        void operation.execute(async () => {
          const receipt = await submitIntakeRequest(orgId, body);
          if (receipt.request_id !== body.id)
            throw new Error("Mismatched intake receipt");
          return receipt;
        });
      }}
    >
      <FieldLabel htmlFor="intake-category">Request type</FieldLabel>
      <select
        id="intake-category"
        className={FORM_CONTROL_GLASS_CLASS + " h-10"}
        disabled={operation.locked}
        value={category}
        onChange={(e) => setCategory(e.target.value as "nda" | "general")}
      >
        <option value="general">Legal question</option>
        <option value="nda">NDA request</option>
      </select>
      <FieldLabel htmlFor="intake-subject">Subject</FieldLabel>
      <FormTextInput
        id="intake-subject"
        required
        maxLength={200}
        value={subject}
        disabled={operation.locked}
        onChange={(e) => setSubject(e.target.value)}
      />
      <FieldLabel htmlFor="intake-description">
        What do you need help with?
      </FieldLabel>
      <textarea
        id="intake-description"
        className={FORM_CONTROL_GLASS_CLASS + " min-h-32 py-2"}
        required
        maxLength={20000}
        value={description}
        disabled={operation.locked}
        onChange={(e) => setDescription(e.target.value)}
      />
      <FieldLabel htmlFor="intake-date">
        Business target date (optional, not a legal deadline)
      </FieldLabel>
      <FormTextInput
        id="intake-date"
        type="date"
        value={date}
        disabled={operation.locked}
        onChange={(e) => setDate(e.target.value)}
      />
      {date && (
        <>
          <FieldLabel htmlFor="intake-timezone">Confirm timezone</FieldLabel>
          <FormTextInput
            id="intake-timezone"
            required
            value={timezone}
            disabled={operation.locked}
            onChange={(e) => setTimezone(e.target.value)}
          />
        </>
      )}
      <p className="text-sm text-muted-foreground">
        The Legal team can read your request. Unsaved text is lost if you leave
        this page or switch workspace.
      </p>
      {operation.uncertain && (
        <p role="status">
          Checking whether it was saved.{" "}
          <PillButtonUI
            tone="black"
            type="button"
            disabled={operation.busy}
            onClick={() => void operation.execute()}
          >
            Check again
          </PillButtonUI>
        </p>
      )}
      <div className="flex gap-2">
        <PillButtonUI
          tone="black"
          type="submit"
          disabled={!enabled || operation.locked}
        >
          Submit request
        </PillButtonUI>
        <PillButtonUI
          tone="black"
          type="button"
          disabled={operation.locked}
          onClick={() => {
            if (confirmDiscard()) onClose();
          }}
        >
          Close
        </PillButtonUI>
      </div>
    </form>
  );
}

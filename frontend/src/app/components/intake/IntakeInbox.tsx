"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Settings2 } from "lucide-react";
import type {
  IntakeConfiguration,
  IntakeRequest,
  IntakeReviewer,
  IntakeState,
} from "@mike/contracts";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import { notifyPartialFailure, notifyError } from "@/app/lib/userFacingError";
import { notifySuccess } from "@/shared/lib/errorNotifier";
import { useDebouncedValue } from "@/app/hooks/useDebouncedValue";
import {
  getIntakeConfiguration,
  commandIntakeRequest,
  getIntakeReviewers,
  listIntakeRequests,
} from "@/app/lib/mikeApi";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { PAGE_HEADER_TITLE_CLASS } from "@/app/components/shared/pageHeaderStyles";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { TableLoadMoreRow } from "@/app/components/shared/TableLoadMoreRow";
import { RowActions } from "@/app/components/shared/RowActions";
import { SelectionActionsMenu } from "@/app/components/shared/SelectionActionsMenu";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import {
  rowActionSelectionIds,
  SkeletonCheckbox,
  SkeletonLine,
  TABLE_CHECKBOX_CLASS,
  TableBody,
  TableCell,
  TableEmptyState,
  TableFilters,
  TableHeaderCell,
  TableHeaderRow,
  TablePrimaryCell,
  TableRow,
  TableScrollArea,
  TableStickyCell,
} from "@/app/components/shared/TablePrimitive";
import { IntakeSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { formatDate } from "@/app/components/projects/ProjectPageParts";
import { EmptyState } from "@/app/components/ui/empty-state";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { DropdownItem, DropdownSeparator } from "@/shared/ui/dropdown";
import { NewIntakeRequestModal } from "./NewIntakeRequestModal";
import { IntakeTeamModal } from "./IntakeSettings";
import { useIntakeDraft, useIntakeMemory } from "./useIntakeMemory";
import { intakeError } from "./useIntakeOperation";

const PAGE_SIZE = 50;

type IntakeView = "mine" | "queue";

const VIEWS: { id: IntakeView; label: string }[] = [
  { id: "mine", label: "My requests" },
  { id: "queue", label: "Legal queue" },
];

export const INTAKE_STATE_LABELS: Record<IntakeState, string> = {
  submitted: "Submitted",
  in_review: "In review",
  needs_information: "Needs information",
  resolved: "Resolved",
  cancelled: "Cancelled",
};

const STATE_OPTIONS = (Object.keys(INTAKE_STATE_LABELS) as IntakeState[]).map(
  (value) => ({ value, label: INTAKE_STATE_LABELS[value] }),
);

const CATEGORY_LABELS: Record<IntakeRequest["category"], string> = {
  general: "Legal question",
  nda: "NDA request",
};

/** Mount the inbox only for the signed-in account and its active organization. */
export function IntakeInbox() {
  const { accountId, activeOrganization } = useWorkspace();
  if (!accountId || !activeOrganization)
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <TableEmptyState>
          <EmptyState
            icon={<IntakeSkeuoIcon />}
            title="Intake"
            description="Switch to an organization workspace to send or handle requests."
          />
        </TableEmptyState>
      </div>
    );
  return (
    <Inbox
      key={`${accountId}:${activeOrganization.id}`}
      orgId={activeOrganization.id}
    />
  );
}

/** Load personal requests or the Legal queue with organization-scoped filters. */
export function Inbox({ orgId }: { orgId: string }) {
  const router = useRouter();
  const memory = useIntakeMemory(orgId, "new-request");
  const [config, setConfig] = useState<IntakeConfiguration | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [reviewers, setReviewers] = useState<IntakeReviewer[]>([]);
  const [view, setView] = useState<IntakeView>("mine");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 250);
  const [state, setState] = useState<IntakeState | null>(null);
  const [assignee, setAssignee] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [creating, setCreating] = useIntakeDraft(memory, "creating", false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [cancelTargets, setCancelTargets] = useState<IntakeRequest[] | null>(
    null,
  );
  const [cancelling, setCancelling] = useState(false);
  const queue = view === "queue" && !!config?.is_reviewer;
  // Everything that selects a list. Rows, errors and the next page offset are
  // stored against it, so a change shows the loading state at once and a late
  // response for an earlier query is never drawn.
  const queryKey = [
    queue ? "queue" : "mine",
    debouncedSearch,
    state ?? "",
    queue ? (assignee ?? "") : "",
  ].join("\n");
  const [page, setPage] = useState<{
    key: string;
    rows: IntakeRequest[];
    hasMore: boolean;
  } | null>(null);
  const [listError, setListError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [next, setNext] = useState({ key: queryKey, offset: 0, attempt: 0 });
  const [loadMoreError, setLoadMoreError] = useState(false);
  const offset = next.key === queryKey ? next.offset : 0;
  const attempt = next.key === queryKey ? next.attempt : 0;
  const rows = page?.key === queryKey ? page.rows : null;
  const error = listError?.key === queryKey ? listError.message : null;
  const loadingMore =
    rows !== null && offset > 0 && rows.length <= offset && !loadMoreError;
  // Selection belongs to the list it was made in.
  const [selection, setSelection] = useState({
    key: queryKey,
    ids: [] as string[],
  });
  const selectedIds = selection.key === queryKey ? selection.ids : [];
  const setSelectedIds = (update: (ids: string[]) => string[]) =>
    setSelection((current) => ({
      key: queryKey,
      ids: update(current.key === queryKey ? current.ids : []),
    }));
  const allSelected =
    !!rows && rows.length > 0 && rows.every((r) => selectedIds.includes(r.id));

  useEffect(() => {
    let active = true;
    getIntakeConfiguration(orgId)
      .then(async (c) => {
        const roster = c.is_reviewer
          ? (await getIntakeReviewers(orgId)).filter(
              (reviewer) => reviewer.is_reviewer,
            )
          : [];
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
    const [listView, listSearch, listState, listAssignee] =
      queryKey.split("\n");
    listIntakeRequests(orgId, {
      view: listView as IntakeView,
      offset,
      search: listSearch,
      ...(listState ? { state: listState } : {}),
      ...(listAssignee ? { assignee: listAssignee } : {}),
    })
      .then((r) => {
        if (!active) return;
        setPage((current) => ({
          key: queryKey,
          rows:
            offset > 0 && current?.key === queryKey
              ? [...current.rows, ...r]
              : r,
          hasMore: r.length === PAGE_SIZE,
        }));
        setListError(null);
        setLoadMoreError(false);
      })
      .catch((e) => {
        if (!active) return;
        if (offset > 0) setLoadMoreError(true);
        else setListError({ key: queryKey, message: intakeError(e) });
      });
    return () => {
      active = false;
    };
    // `reload` refetches the first page in place: the rows on screen stay
    // until the fresh ones arrive.
  }, [orgId, queryKey, offset, attempt, reload]);

  // Refetch the configuration and the first page of the current list.
  const refresh = useCallback(() => {
    setNext((current) => ({ ...current, offset: 0 }));
    setReload((x) => x + 1);
  }, []);
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const loadMore = () => {
    if (!rows || !page?.hasMore || loadingMore) return;
    setLoadMoreError(false);
    setNext({ key: queryKey, offset: rows.length, attempt: attempt + 1 });
  };
  const retry = () => {
    setListError(null);
    refresh();
  };
  const filtered = !!debouncedSearch || !!state || (queue && !!assignee);
  const failure = error || configError;
  const canSubmit = !!config?.enabled && !!config.has_team;
  const notice = !config
    ? null
    : !config.enabled
      ? "Intake is switched off. Existing requests are read-only."
      : !config.has_team
        ? config.can_configure
          ? "Choose a Legal team in Intake settings before requests can be sent."
          : "Intake has no Legal team yet. An organization owner can choose one."
        : null;

  const hrefFor = (request: IntakeRequest) =>
    `/intake/${request.id}?org=${orgId}`;

  function renderActions(
    request: IntakeRequest | undefined,
    close: () => void,
  ) {
    const ids = request
      ? rowActionSelectionIds(request.id, selectedIds)
      : selectedIds;
    const targets = (rows ?? []).filter((r) => ids.includes(r.id));
    const cancellable = targets.filter((r) => r.capabilities.cancel);
    const single = targets.length === 1 ? targets[0] : null;
    return (
      <>
        {single && (
          <DropdownItem
            onSelect={() => {
              close();
              router.push(hrefFor(single));
            }}
          >
            Open
          </DropdownItem>
        )}
        <DropdownItem
          onSelect={() => {
            close();
            const links = targets
              .map((r) => new URL(hrefFor(r), window.location.origin).href)
              .join("\n");
            navigator.clipboard.writeText(links).then(
              () =>
                notifySuccess(
                  targets.length === 1 ? "Link copied" : "Links copied",
                ),
              (e) => notifyError(e, { action: "copy the link" }),
            );
          }}
        >
          {targets.length > 1 ? `Copy ${targets.length} links` : "Copy link"}
        </DropdownItem>
        {cancellable.length > 0 && (
          <>
            <DropdownSeparator />
            <DropdownItem
              variant="destructive"
              onSelect={() => {
                close();
                setCancelTargets(cancellable);
              }}
            >
              {cancellable.length > 1
                ? `Cancel ${cancellable.length} requests`
                : "Cancel request"}
            </DropdownItem>
          </>
        )}
      </>
    );
  }

  async function cancelRequests(targets: IntakeRequest[]) {
    setCancelling(true);
    const failed: IntakeRequest[] = [];
    let lastError: unknown = null;
    for (const request of targets) {
      try {
        await commandIntakeRequest(orgId, request.id, "cancel", {
          command_id: crypto.randomUUID(),
          expected_version: request.version,
        });
      } catch (e) {
        failed.push(request);
        lastError = e;
      }
    }
    setCancelling(false);
    setCancelTargets(null);
    setSelectedIds(() => []);
    refresh();
    if (failed.length === targets.length && lastError)
      notifyError(lastError, {
        action:
          targets.length === 1 ? "cancel the request" : "cancel the requests",
      });
    else if (failed.length > 0)
      notifyPartialFailure(
        `${failed.length} of ${targets.length} requests couldn't be cancelled. They may have changed; reload and try again.`,
        { action: "cancel the requests" },
      );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <PageHeader
        actions={[
          {
            type: "search",
            value: search,
            onChange: setSearch,
            placeholder: "Search requests…",
          },
          config?.can_configure && {
            icon: <Settings2 className="h-4 w-4" />,
            label: "Intake settings",
            onClick: () => setTeamOpen(true),
          },
          {
            type: "new",
            onClick: () => setCreating(true),
            disabled: !canSubmit,
            title: "New request",
          },
        ]}
      >
        <h1 className={`${PAGE_HEADER_TITLE_CLASS} text-gray-900`}>Intake</h1>
      </PageHeader>

      {config && (config.is_reviewer || notice || selectedIds.length > 0) && (
        <TableToolbar
          items={config.is_reviewer ? VIEWS : []}
          active={queue ? "queue" : "mine"}
          onChange={(id) => {
            setView(id);
            setAssignee(null);
          }}
          actions={
            selectedIds.length > 0 ? (
              <SelectionActionsMenu
                renderItems={(close) => renderActions(undefined, close)}
              />
            ) : notice ? (
              <p className="text-xs text-gray-500">{notice}</p>
            ) : undefined
          }
        />
      )}

      <TableScrollArea
        onScroll={(event) => {
          const element = event.currentTarget;
          if (
            element.scrollHeight - element.scrollTop - element.clientHeight <
            200
          )
            loadMore();
        }}
        header={
          <TableHeaderRow>
            <TableStickyCell header>
              {rows === null ? (
                <SkeletonCheckbox />
              ) : (
                <input
                  type="checkbox"
                  className={TABLE_CHECKBOX_CLASS}
                  aria-label="Select all requests"
                  checked={allSelected}
                  disabled={!rows.length}
                  ref={(input) => {
                    if (input)
                      input.indeterminate =
                        selectedIds.length > 0 && !allSelected;
                  }}
                  onChange={() =>
                    setSelectedIds(() =>
                      allSelected ? [] : rows.map((r) => r.id),
                    )
                  }
                />
              )}
              <span>Request</span>
            </TableStickyCell>
            <TableHeaderCell className="ml-auto w-32">Type</TableHeaderCell>
            <TableHeaderCell className="w-40">
              <div className="flex items-center gap-1">
                <span>Status</span>
                <TableFilters
                  label="Filter by status"
                  value={state}
                  allLabel="All statuses"
                  options={STATE_OPTIONS}
                  onChange={setState}
                />
              </div>
            </TableHeaderCell>
            {queue && (
              <TableHeaderCell className="w-40">Requester</TableHeaderCell>
            )}
            <TableHeaderCell className="w-44">
              <div className="flex items-center gap-1">
                <span>Assigned lawyer</span>
                {queue && (
                  <TableFilters
                    label="Filter by assigned lawyer"
                    value={assignee}
                    allLabel="All assigned lawyers"
                    options={reviewers.map((reviewer) => ({
                      value: reviewer.user_id,
                      label:
                        reviewer.display_name ?? reviewer.email ?? "Member",
                    }))}
                    onChange={setAssignee}
                  />
                )}
              </div>
            </TableHeaderCell>
            <TableHeaderCell className="w-32">Updated</TableHeaderCell>
            <TableHeaderCell className="w-8" />
          </TableHeaderRow>
        }
      >
        {failure ? (
          <TableEmptyState>
            <p className="font-serif text-lg font-medium text-gray-900">
              Unable to load requests
            </p>
            <p className="mt-1 text-xs text-gray-400" role="alert">
              {failure}
            </p>
            <PillButtonUI
              tone="black"
              size="sm"
              className="mt-4"
              onClick={retry}
            >
              Try again
            </PillButtonUI>
          </TableEmptyState>
        ) : rows === null ? (
          <IntakeLoadingRows queue={queue} />
        ) : rows.length === 0 ? (
          <TableEmptyState>
            {filtered ? (
              <p className="text-sm text-gray-400">No requests found</p>
            ) : (
              <EmptyState
                icon={<IntakeSkeuoIcon />}
                title={queue ? "The queue is empty" : "Intake"}
                description={
                  queue
                    ? "New requests from your organization appear here."
                    : "Ask the Legal team for help with an NDA or a legal question."
                }
                action={
                  !queue && canSubmit ? (
                    <PillButtonUI
                      tone="black"
                      size="sm"
                      onClick={() => setCreating(true)}
                    >
                      Create
                    </PillButtonUI>
                  ) : undefined
                }
              />
            )}
          </TableEmptyState>
        ) : (
          <TableBody>
            {rows.map((request) => {
              const href = hrefFor(request);
              const selected = selectedIds.includes(request.id);
              return (
                <TableRow
                  key={request.id}
                  selected={selected}
                  rightClickDropdown={(close) => renderActions(request, close)}
                  onClick={() => router.push(href)}
                >
                  <TablePrimaryCell
                    selected={selected}
                    checkboxTitle={`Select ${request.subject}`}
                    onSelectionChange={() =>
                      setSelectedIds((ids) =>
                        ids.includes(request.id)
                          ? ids.filter((id) => id !== request.id)
                          : [...ids, request.id],
                      )
                    }
                    label={
                      <Link
                        href={href}
                        className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                        title={request.subject}
                        onClick={(event) => event.stopPropagation()}
                      >
                        {request.subject}
                      </Link>
                    }
                  />
                  <TableCell className="ml-auto w-32">
                    {CATEGORY_LABELS[request.category]}
                  </TableCell>
                  <TableCell className="w-40">
                    {INTAKE_STATE_LABELS[request.state]}
                  </TableCell>
                  {queue && (
                    <TableCell className="w-40 [overflow-wrap:anywhere]">
                      {request.requester_name}
                    </TableCell>
                  )}
                  <TableCell className="w-44 [overflow-wrap:anywhere]">
                    {request.assignee_name ?? (
                      <span className="text-gray-400">Unassigned</span>
                    )}
                  </TableCell>
                  <TableCell className="w-32">
                    {formatDate(request.updated_at)}
                  </TableCell>
                  <div
                    className="flex w-8 shrink-0 justify-end"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <RowActions
                      ariaLabel={`Actions for ${request.subject}`}
                      renderItems={(close) => renderActions(request, close)}
                    />
                  </div>
                </TableRow>
              );
            })}
          </TableBody>
        )}
        <TableLoadMoreRow
          loading={rows === null}
          hasMore={!failure && !!page?.hasMore && rows !== null}
          itemCount={rows?.length ?? 0}
          loadingMore={loadingMore}
          hasError={loadMoreError}
          onLoadMore={loadMore}
        />
      </TableScrollArea>

      {teamOpen && (
        <IntakeTeamModal
          orgId={orgId}
          onClose={() => {
            setTeamOpen(false);
            refresh();
          }}
        />
      )}
      <ConfirmPopup
        open={!!cancelTargets}
        title={
          cancelTargets && cancelTargets.length > 1
            ? `Cancel ${cancelTargets.length} requests?`
            : "Cancel this request?"
        }
        message="Conversations stay available, but cancelled requests become read-only."
        confirmLabel={
          cancelTargets && cancelTargets.length > 1
            ? "Cancel requests"
            : "Cancel request"
        }
        confirmVariant="danger"
        confirmDisabled={cancelling}
        onCancel={() => setCancelTargets(null)}
        onConfirm={() => cancelTargets && void cancelRequests(cancelTargets)}
      />
      {creating && (
        <NewIntakeRequestModal
          orgId={orgId}
          enabled={!!config?.enabled}
          onClose={() => setCreating(false)}
          onSaved={(id) => router.push(`/intake/${id}?org=${orgId}`)}
        />
      )}
    </div>
  );
}

function IntakeLoadingRows({ queue }: { queue: boolean }) {
  const widths = ["w-44", "w-36", "w-52", "w-40", "w-48"];
  return (
    <TableBody>
      <span role="status" className="sr-only">
        Loading requests…
      </span>
      {widths.map((width) => (
        <TableRow key={width} interactive={false}>
          <TableStickyCell hover={false}>
            <div className="flex min-w-0 items-center">
              <SkeletonCheckbox />
              <SkeletonLine className={`h-3.5 ${width}`} />
            </div>
          </TableStickyCell>
          <TableCell className="ml-auto w-32">
            <SkeletonLine className="w-20" />
          </TableCell>
          <TableCell className="w-40">
            <SkeletonLine className="w-16" />
          </TableCell>
          {queue && (
            <TableCell className="w-40">
              <SkeletonLine className="w-20" />
            </TableCell>
          )}
          <TableCell className="w-44">
            <SkeletonLine className="w-24" />
          </TableCell>
          <TableCell className="w-32">
            <SkeletonLine className="w-20" />
          </TableCell>
          <TableCell className="w-8" />
        </TableRow>
      ))}
    </TableBody>
  );
}

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import type { IntakeConfiguration, IntakeRequest } from "@mike/contracts";
import { IntakeInbox, Inbox } from "./IntakeInbox";
import { IntakeDetail, Detail } from "./IntakeDetail";
import { IntakeFeatureSetting, IntakeTeamModal } from "./IntakeSettings";
import { setIntakeMemoryAccount } from "@/app/lib/intakeMemory";

const mocks = vi.hoisted(() => ({
  configuration: vi.fn(),
  reviewers: vi.fn(),
  configure: vi.fn(),
  list: vi.fn(),
  submit: vi.fn(),
  request: vi.fn(),
  messages: vi.fn(),
  events: vi.fn(),
  command: vi.fn(),
  push: vi.fn(),
  notify: vi.fn(),
  workspace: {
    accountId: "account-a",
    workspaceId: "org-a",
    activeOrganization: { id: "org-a" },
  },
}));
vi.mock("@/app/lib/mikeApi", () => ({
  getIntakeConfiguration: mocks.configuration,
  getIntakeReviewers: mocks.reviewers,
  configureIntake: mocks.configure,
  listIntakeRequests: mocks.list,
  submitIntakeRequest: mocks.submit,
  getIntakeRequest: mocks.request,
  getIntakeMessages: mocks.messages,
  getIntakeEvents: mocks.events,
  commandIntakeRequest: mocks.command,
  isMfaRequiredError: (error: { code?: string }) =>
    error?.code === "mfa_verification_required",
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("next/link", () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
  useWorkspace: () => mocks.workspace,
}));
vi.mock("@/app/hooks/useItemWorkspace", () => ({ useItemWorkspace: vi.fn() }));
vi.mock("@/app/components/organizations/OrganizationSettingsShell", () => ({
  useOrganizationSettings: () => ({ orgId: "org-a", org: { role: "owner" } }),
}));
vi.mock("@/app/components/shared/PageHeader", () => ({
  PageHeader: ({
    children,
    actions = [],
  }: {
    children?: ReactNode;
    actions?: (
      | false
      | null
      | undefined
      | {
          type?: string;
          title?: string;
          label?: ReactNode;
          disabled?: boolean;
          onClick?: () => void;
        }
    )[];
  }) => (
    <header>
      {children}
      {actions.map((action, index) =>
        !action || action.type === "search" ? null : (
          <button
            key={index}
            type="button"
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {action.type === "new" ? action.title : action.label}
          </button>
        ),
      )}
    </header>
  ),
}));
vi.mock("@/app/lib/userFacingError", () => ({
  describeError: () => ({ message: "Could not load requests." }),
  notifyError: mocks.notify,
}));
vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
  MfaVerificationPopup: ({
    open,
    onVerified,
  }: {
    open: boolean;
    onVerified: () => void;
  }) =>
    open ? (
      <button type="button" onClick={onVerified}>
        Verify MFA
      </button>
    ) : null,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const configuration = (revision = 1): IntakeConfiguration => ({
  configured: true,
  enabled: true,
  can_configure: true,
  is_reviewer: true,
  has_team: true,
  revision,
  reviewer_ids: ["lawyer-a"],
});
const request = (overrides: Partial<IntakeRequest> = {}): IntakeRequest => ({
  incarnation_id: "incarnation-a",
  export_revision: 1,
  id: "request-a",
  org_id: "org-a",
  requester_id: "requester",
  assignee_id: "lawyer-a",
  category: "general",
  subject: "Confidential request A",
  description: "Request description",
  requested_by_date: null,
  timezone: null,
  state: "in_review",
  version: 1,
  created_at: "2026-10-26T10:00:00Z",
  updated_at: "2026-10-26T10:00:00Z",
  requester_name: "Requester",
  assignee_name: "Lawyer A",
  capabilities: {
    assign: true,
    ask: true,
    reply: false,
    publish: true,
    cancel: false,
  },
  ...overrides,
});
const EMPTY_INBOX =
  "Ask the Legal team for help with an NDA or a legal question.";
const receipt = {
  request_id: "request-a",
  applied_version: 2,
  message_id: null,
  replayed: false,
};

beforeEach(() => {
  setIntakeMemoryAccount(null);
  vi.resetAllMocks();
  mocks.workspace = {
    accountId: "account-a",
    workspaceId: "org-a",
    activeOrganization: { id: "org-a" },
  };
  mocks.configuration.mockResolvedValue(configuration());
  mocks.reviewers.mockResolvedValue([
    {
      user_id: "lawyer-a",
      display_name: "Lawyer A",
      email: "a@example.test",
      is_reviewer: true,
    },
    {
      user_id: "lawyer-b",
      display_name: "Lawyer B",
      email: "b@example.test",
      is_reviewer: true,
    },
  ]);
  mocks.list.mockResolvedValue([]);
  mocks.request.mockResolvedValue(request());
  mocks.messages.mockResolvedValue([]);
  mocks.events.mockResolvedValue([]);
  mocks.command.mockResolvedValue(receipt);
  mocks.configure.mockResolvedValue({ ...receipt, request_id: null });
  vi.spyOn(window, "confirm").mockReturnValue(false);
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("configuration revisions and MFA", () => {
  it("keeps the loaded revision with a draft until an explicit conflict reload", async () => {
    mocks.configuration
      .mockResolvedValueOnce(configuration(1))
      .mockResolvedValue(configuration(9));
    mocks.configure.mockRejectedValue({ status: 409, code: "intake_conflict" });
    render(<IntakeTeamModal orgId="org-a" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Lawyer B/ }));
    await act(async () => {});
    expect(mocks.configuration).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Save" }),
    );
    await screen.findByRole("button", { name: "Reload settings" });
    expect(mocks.configure.mock.calls[0][1]).toMatchObject({
      expected_revision: 1,
      reviewer_ids: ["lawyer-a", "lawyer-b"],
    });
    expect(screen.getByRole("checkbox", { name: /Lawyer B/ })).toBeChecked();
    expect(
      screen.getByRole("button", { name: "Save" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));
    expect(mocks.configuration).toHaveBeenCalledTimes(1);
    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));
    await waitFor(() => expect(mocks.configuration).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: /Lawyer B/ }),
      ).not.toBeChecked(),
    );
  });

  it("treats only a stale revision as a conflict that needs a reload", async () => {
    mocks.configure.mockRejectedValueOnce({
      status: 429,
      code: "rate_limited",
    });
    render(<IntakeTeamModal orgId="org-a" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Lawyer B/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.configure).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(
      screen.queryByRole("button", { name: "Reload settings" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("reconciles the original uncertain command after an MFA challenge", async () => {
    mocks.configure
      .mockRejectedValueOnce(new TypeError("Lost response"))
      .mockRejectedValueOnce({
        status: 403,
        code: "mfa_verification_required",
      });
    render(<IntakeTeamModal orgId="org-a" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Lawyer B/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Save" }),
    );
    const verify = await screen.findByRole("button", { name: "Verify MFA" });
    const original = structuredClone(mocks.configure.mock.calls[0][1]);
    fireEvent.click(verify);
    await waitFor(() => expect(mocks.configure).toHaveBeenCalledTimes(3));
    expect(mocks.configure.mock.calls.map((call) => call[1])).toEqual([
      original,
      original,
      original,
    ]);
    await waitFor(() => expect(mocks.configuration).toHaveBeenCalledTimes(2));
  });

  it("retries the exact configuration command after successful MFA", async () => {
    mocks.configure.mockRejectedValueOnce({
      status: 403,
      code: "mfa_verification_required",
    });
    render(<IntakeTeamModal orgId="org-a" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Lawyer B/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Save" }),
    );
    const verify = await screen.findByRole("button", { name: "Verify MFA" });
    const original = structuredClone(mocks.configure.mock.calls[0][1]);
    expect(
      screen.getByRole("button", { name: "Save" }),
    ).toBeDisabled();
    fireEvent.click(verify);
    await waitFor(() => expect(mocks.configure).toHaveBeenCalledTimes(2));
    expect(mocks.configure.mock.calls[1]).toEqual(["org-a", original]);
    await waitFor(() => expect(mocks.configuration).toHaveBeenCalledTimes(2));
  });

  it("hides the owner roster after uncertain access denial while allowing command reconciliation", async () => {
    mocks.configure
      .mockRejectedValueOnce(new TypeError("lost response"))
      .mockRejectedValueOnce({ status: 403 });
    mocks.configuration
      .mockResolvedValueOnce(configuration())
      .mockReturnValue(new Promise(() => {}));
    render(<IntakeTeamModal orgId="org-a" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Lawyer B/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Save" }),
    );
    await waitFor(() => expect(mocks.configure).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("a@example.test")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
    const original = structuredClone(mocks.configure.mock.calls[0]);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(mocks.configure).toHaveBeenCalledTimes(3));
    expect(mocks.configure.mock.calls[2]).toEqual(original);
    expect(screen.queryByText("a@example.test")).not.toBeInTheDocument();
  });
});

describe("intake defaults and table actions", () => {
  it("pre-selects the whole organization until a Legal team is saved", async () => {
    mocks.configuration.mockResolvedValue({
      ...configuration(),
      has_team: false,
      reviewer_ids: [],
    });
    render(<IntakeTeamModal orgId="org-a" onClose={() => {}} />);
    expect(
      await screen.findByRole("checkbox", { name: /Lawyer A/ }),
    ).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Lawyer B/ })).toBeChecked();
  });

  it("switches intake off without changing the saved Legal team", async () => {
    render(<IntakeFeatureSetting orgId="org-a" />);
    fireEvent.click(await screen.findByRole("switch", { name: "Enable intake" }));
    await waitFor(() => expect(mocks.configure).toHaveBeenCalledTimes(1));
    expect(mocks.configure.mock.calls[0][1]).toMatchObject({
      expected_revision: 1,
      enabled: false,
      reviewer_ids: ["lawyer-a"],
    });
  });

  it("explains that requests wait for a Legal team", async () => {
    mocks.configuration.mockResolvedValue({
      ...configuration(),
      has_team: false,
      reviewer_ids: [],
    });
    render(<Inbox orgId="org-a" />);
    expect(
      await screen.findByText(
        "Choose a Legal team in Intake settings before requests can be sent.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New request" })).toBeDisabled();
  });

  it("cancels a request from its row menu after confirmation", async () => {
    const user = userEvent.setup();
    mocks.list.mockResolvedValue([
      request({
        version: 4,
        capabilities: { ...request().capabilities, cancel: true },
      }),
    ]);
    render(<Inbox orgId="org-a" />);
    await user.click(
      await screen.findByRole("button", {
        name: "Actions for Confidential request A",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Cancel request" }));
    expect(mocks.command).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel request" }));
    await waitFor(() =>
      expect(mocks.command).toHaveBeenCalledWith(
        "org-a",
        "request-a",
        "cancel",
        expect.objectContaining({ expected_version: 4 }),
      ),
    );
  });
});

describe("request forms and list loading", () => {
  it("limits the owner-reviewer's queue filter to current intake reviewers", async () => {
    mocks.configuration.mockResolvedValue({
      ...configuration(),
      can_configure: true,
      is_reviewer: true,
    });
    mocks.reviewers.mockResolvedValue([
      {
        user_id: "owner-reviewer",
        display_name: "Owner Reviewer",
        email: "owner@example.test",
        is_reviewer: true,
      },
      {
        user_id: "member",
        display_name: "Ordinary Member",
        email: "member@example.test",
        is_reviewer: false,
      },
      {
        user_id: "lawyer-a",
        display_name: "Lawyer A",
        email: "a@example.test",
        is_reviewer: true,
      },
    ]);
    const user = userEvent.setup();
    render(<Inbox orgId="org-a" />);
    await user.click(await screen.findByRole("button", { name: "Legal queue" }));
    await user.click(
      screen.getByRole("button", { name: "Filter by assigned lawyer" }),
    );
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["All assigned lawyers", "Owner Reviewer", "Lawyer A"]);
    await user.click(screen.getByRole("menuitem", { name: "Lawyer A" }));
    await waitFor(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(
        "org-a",
        expect.objectContaining({ view: "queue", assignee: "lawyer-a" }),
      ),
    );
  });

  it("does not hide a failed configuration behind a successful list", async () => {
    const list = deferred<IntakeRequest[]>();
    mocks.configuration.mockRejectedValue(
      new Error("configuration unavailable"),
    );
    mocks.list.mockReturnValue(list.promise);
    render(<Inbox orgId="org-a" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load requests.",
    );
    await act(async () => list.resolve([]));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not load requests.",
    );
    expect(screen.queryByText(EMPTY_INBOX)).not.toBeInTheDocument();
  });

  it("asks before closing a draft and retains its text when declined", async () => {
    render(<Inbox orgId="org-a" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "New request" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "New request" }));
    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "Unsent question" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Subject")).toHaveValue("Unsent question");
    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Subject")).not.toBeInTheDocument();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("reconciles a lost submission with the same request ID, command ID and text", async () => {
    mocks.submit
      .mockRejectedValueOnce(new TypeError("lost response"))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockImplementation(async (_org: string, body: { id: string }) => ({
        ...receipt,
        request_id: body.id,
      }));
    render(<Inbox orgId="org-a" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "New request" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "New request" }));
    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "Business question" },
    });
    fireEvent.change(screen.getByLabelText("What do you need help with?"), {
      target: { value: "  Exact request text\nwith newlines  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled(),
    );
    const original = structuredClone(mocks.submit.mock.calls[0]);
    expect(original[1]).toMatchObject({
      id: expect.any(String),
      command_id: expect.any(String),
      description: "  Exact request text\nwith newlines  ",
    });
    expect(mocks.submit.mock.calls[1]).toEqual(original);
    expect(
      screen.getByRole("button", { name: "Submit request" }),
    ).toBeDisabled();
    expect(mocks.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith(
        `/intake/${original[1].id}?org=org-a`,
      ),
    );
    expect(mocks.submit.mock.calls[2]).toEqual(original);
  });

  it("clears loaded rows immediately while a new workspace list is pending", async () => {
    const next = deferred<IntakeRequest[]>();
    mocks.list
      .mockResolvedValueOnce([request()])
      .mockReturnValueOnce(next.promise);
    const view = render(<IntakeInbox />);
    await screen.findByRole("link", { name: "Confidential request A" });
    mocks.workspace = {
      ...mocks.workspace,
      workspaceId: "org-b",
      activeOrganization: { id: "org-b" },
    };
    view.rerender(<IntakeInbox />);
    expect(
      screen.queryByRole("link", { name: "Confidential request A" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading requests");
    await act(async () => next.resolve([]));
    expect(screen.getByText(EMPTY_INBOX)).toBeInTheDocument();
  });

  it("rejects stale A responses across A to B to A workspace navigation", async () => {
    const oldA = deferred<IntakeRequest[]>();
    const oldB = deferred<IntakeRequest[]>();
    mocks.list
      .mockReturnValueOnce(oldA.promise)
      .mockReturnValueOnce(oldB.promise)
      .mockResolvedValueOnce([request({ subject: "Fresh A" })]);
    const view = render(<IntakeInbox />);
    mocks.workspace = {
      ...mocks.workspace,
      workspaceId: "org-b",
      activeOrganization: { id: "org-b" },
    };
    view.rerender(<IntakeInbox />);
    mocks.workspace = {
      ...mocks.workspace,
      workspaceId: "org-a",
      activeOrganization: { id: "org-a" },
    };
    view.rerender(<IntakeInbox />);
    await screen.findByRole("link", { name: "Fresh A" });
    await act(async () => {
      oldB.resolve([request({ subject: "Old B" })]);
      oldA.resolve([request({ subject: "Old A" })]);
    });
    expect(screen.getByRole("link", { name: "Fresh A" })).toBeInTheDocument();
    expect(screen.queryByText("Old A")).not.toBeInTheDocument();
    expect(screen.queryByText("Old B")).not.toBeInTheDocument();
  });
});

describe("reviewer draft, preview and recovery", () => {
  it("preserves an unsent answer when saving assignment", async () => {
    render(<Detail orgId="org-a" requestId="request-a" />);
    const editor = await screen.findByLabelText("Message to the requester");
    fireEvent.change(editor, { target: { value: "Unsent answer" } });
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Assigned lawyer"));
    await user.click(screen.getByRole("menuitem", { name: "Lawyer B" }));
    fireEvent.click(screen.getByRole("button", { name: "Save assignment" }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Message to the requester")).toHaveValue(
      "Unsent answer",
    );
    expect(mocks.command.mock.calls[0]).toEqual([
      "org-a",
      "request-a",
      "assignment",
      expect.objectContaining({ expected_version: 1, assignee_id: "lawyer-b" }),
    ]);
    expect(mocks.command.mock.calls[0][3]).not.toHaveProperty("body");
  });

  it("invalidates an edited preview and retries the exact approved body and version", async () => {
    mocks.command
      .mockRejectedValueOnce(new TypeError("lost response"))
      .mockRejectedValueOnce(new TypeError("offline"));
    render(<Detail orgId="org-a" requestId="request-a" />);
    const editor = await screen.findByLabelText("Message to the requester");
    fireEvent.change(editor, { target: { value: "First answer" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview answer" }));
    expect(
      screen.getByRole("region", { name: "Answer preview" }),
    ).toHaveTextContent("First answer");
    fireEvent.change(editor, {
      target: { value: "  Exact revised answer\nSecond line  " },
    });
    expect(
      screen.queryByRole("button", { name: "Share answer and resolve" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview answer" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Share answer and resolve" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled(),
    );
    expect(mocks.command).toHaveBeenCalledTimes(2);
    const original = structuredClone(mocks.command.mock.calls[0]);
    expect(original[3]).toMatchObject({
      body: "  Exact revised answer\nSecond line  ",
      expected_version: 1,
    });
    expect(mocks.command.mock.calls[1]).toEqual(original);
    expect(editor).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(mocks.command).toHaveBeenCalledTimes(3));
    expect(mocks.command.mock.calls[2]).toEqual(original);
  });

  it("retains draft on 409 and requires a fresh preview at the refreshed version", async () => {
    mocks.command.mockRejectedValueOnce({
      status: 409,
      code: "intake_conflict",
    });
    mocks.request
      .mockResolvedValueOnce(request())
      .mockResolvedValue(request({ version: 2 }));
    render(<Detail orgId="org-a" requestId="request-a" />);
    fireEvent.change(await screen.findByLabelText("Message to the requester"), {
      target: { value: "Needs confirmation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview answer" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Share answer and resolve" }),
    );
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Share answer and resolve" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Message to the requester")).toHaveValue(
      "Needs confirmation",
    );
    expect(mocks.command).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Preview answer" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Share answer and resolve" }),
    );
    await waitFor(() => expect(mocks.command).toHaveBeenCalledTimes(2));
    expect(mocks.command.mock.calls[1][3]).toMatchObject({
      expected_version: 2,
      body: "Needs confirmation",
    });
    expect(mocks.command.mock.calls[1][3].command_id).not.toBe(
      mocks.command.mock.calls[0][3].command_id,
    );
  });

  it("hides revoked content immediately after an uncertain 403 while retaining the command", async () => {
    const recheck = deferred<IntakeRequest>();
    mocks.request
      .mockResolvedValueOnce(request())
      .mockReturnValue(recheck.promise);
    mocks.command
      .mockRejectedValueOnce(new TypeError("lost response"))
      .mockRejectedValueOnce({ status: 403 });
    render(<Detail orgId="org-a" requestId="request-a" />);
    fireEvent.change(await screen.findByLabelText("Message to the requester"), {
      target: { value: "Sensitive draft" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Ask for information" }),
    );
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
    expect(
      screen.queryByText("Confidential request A"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Message to the requester"),
    ).not.toBeInTheDocument();
    const original = structuredClone(mocks.command.mock.calls[0]);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(mocks.command).toHaveBeenCalledTimes(3));
    expect(mocks.command.mock.calls[2]).toEqual(original);
    await act(async () => recheck.reject({ status: 403 }));
  });

  it("does not display a late request response after the account changes", async () => {
    const oldAccount = deferred<IntakeRequest>();
    mocks.request
      .mockReturnValueOnce(oldAccount.promise)
      .mockResolvedValueOnce(request({ subject: "Current account request" }));
    const view = render(<IntakeDetail orgId="org-a" requestId="request-a" />);
    mocks.workspace = { ...mocks.workspace, accountId: "account-b" };
    view.rerender(<IntakeDetail orgId="org-a" requestId="request-a" />);
    await screen.findByText("Current account request");
    await act(async () =>
      oldAccount.resolve(request({ subject: "Previous account secret" })),
    );
    expect(
      screen.queryByText("Previous account secret"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Current account request")).toBeInTheDocument();
  });
});

it("filters the Legal queue by current reviewer", async () => {
  const user = userEvent.setup();
  render(<Inbox orgId="org-a" />);
  await user.click(await screen.findByRole("button", { name: "Legal queue" }));
  await user.click(
    await screen.findByRole("button", { name: "Filter by assigned lawyer" }),
  );
  await user.click(screen.getByRole("menuitem", { name: "Lawyer B" }));
  await waitFor(() =>
    expect(mocks.list).toHaveBeenLastCalledWith(
      "org-a",
      expect.objectContaining({
        view: "queue",
        assignee: "lawyer-b",
        offset: 0,
      }),
    ),
  );
});

describe("history navigation recovery", () => {
  it("restores every new-request field and clears only an explicitly discarded draft", async () => {
    const first = render(<Inbox orgId="org-a" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "New request" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "New request" }));
    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "Final keystroke!" },
    });
    fireEvent.change(screen.getByLabelText("What do you need help with?"), {
      target: { value: "Private request" },
    });
    fireEvent.click(screen.getByRole("button", { name: "NDA request" }));
    fireEvent.change(screen.getByLabelText("Target date (optional)"), {
      target: { value: "2026-11-10" },
    });
    fireEvent.change(screen.getByLabelText("Timezone"), {
      target: { value: "Europe/Stockholm" },
    });
    first.unmount();
    render(<Inbox orgId="org-a" />);
    expect(screen.getByLabelText("Subject")).toHaveValue("Final keystroke!");
    expect(screen.getByLabelText("What do you need help with?")).toHaveValue(
      "Private request",
    );
    expect(screen.getByRole("button", { name: "NDA request" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Target date (optional)")).toHaveValue(
      "2026-11-10",
    );
    expect(screen.getByLabelText("Timezone")).toHaveValue("Europe/Stockholm");
    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "New request" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "New request" }));
    expect(screen.getByLabelText("Subject")).toHaveValue("");
  });

  it("keeps configuration selections at their original revision after remount", async () => {
    mocks.configuration.mockResolvedValue(configuration(1));
    const first = render(<IntakeTeamModal orgId="org-a" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Lawyer B/ }));
    first.unmount();
    mocks.configuration.mockResolvedValue(configuration(2));
    render(<IntakeTeamModal orgId="org-a" onClose={() => {}} />);
    expect(
      await screen.findByRole("checkbox", { name: /Lawyer B/ }),
    ).toBeChecked();
    fireEvent.click(
      screen.getByRole("button", { name: "Save" }),
    );
    await waitFor(() => expect(mocks.configure).toHaveBeenCalledTimes(1));
    expect(mocks.configure.mock.calls[0][1]).toMatchObject({
      expected_revision: 1,
      reviewer_ids: ["lawyer-a", "lawyer-b"],
    });
  });

  it("restores a conversation draft after rechecking access but requires a fresh preview", async () => {
    const first = render(<Detail orgId="org-a" requestId="request-a" />);
    fireEvent.change(await screen.findByLabelText("Message to the requester"), {
      target: { value: "Retained answer!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview answer" }));
    first.unmount();
    mocks.request.mockResolvedValue(request({ version: 7 }));
    render(<Detail orgId="org-a" requestId="request-a" />);
    expect(
      screen.queryByLabelText("Message to the requester"),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByLabelText("Message to the requester"),
    ).toHaveValue("Retained answer!");
    expect(
      screen.queryByRole("button", { name: "Share answer and resolve" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview answer" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Share answer and resolve" }),
    );
    await waitFor(() => expect(mocks.command).toHaveBeenCalledTimes(1));
    expect(mocks.command.mock.calls[0][3]).toMatchObject({
      body: "Retained answer!",
      expected_version: 7,
    });
  });

  it("hides a retained answer after access is revoked while away", async () => {
    const first = render(<Detail orgId="org-a" requestId="request-a" />);
    fireEvent.change(await screen.findByLabelText("Message to the requester"), {
      target: { value: "Private retained answer" },
    });
    first.unmount();
    mocks.request.mockRejectedValue({ status: 403 });
    render(<Detail orgId="org-a" requestId="request-a" />);
    await screen.findByRole("alert");
    expect(
      screen.queryByDisplayValue("Private retained answer"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Request description")).not.toBeInTheDocument();
  });

  it("keeps drafts separate between organizations and clears them on account change", async () => {
    const first = render(<Detail orgId="org-a" requestId="request-a" />);
    fireEvent.change(await screen.findByLabelText("Message to the requester"), {
      target: { value: "Account A org A" },
    });
    first.unmount();
    const second = render(<Detail orgId="org-b" requestId="request-a" />);
    expect(
      await screen.findByLabelText("Message to the requester"),
    ).toHaveValue("");
    second.unmount();
    const third = render(<Detail orgId="org-a" requestId="request-a" />);
    expect(
      await screen.findByLabelText("Message to the requester"),
    ).toHaveValue("Account A org A");
    third.unmount();
    setIntakeMemoryAccount("account-b");
    mocks.workspace.accountId = "account-b";
    render(<Detail orgId="org-a" requestId="request-a" />);
    expect(
      await screen.findByLabelText("Message to the requester"),
    ).toHaveValue("");
  });
});

it("keeps the acknowledged settings revision if editing resumes during refresh", async () => {
  const refresh = deferred<IntakeConfiguration>();
  mocks.configuration
    .mockResolvedValueOnce(configuration(1))
    .mockReturnValueOnce(refresh.promise)
    .mockResolvedValue(configuration(2));
  mocks.configure.mockResolvedValue({
    ...receipt,
    request_id: null,
    applied_version: 2,
  });
  render(<IntakeTeamModal orgId="org-a" onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /Lawyer B/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(mocks.configuration).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("checkbox", { name: /Lawyer A/ }));
  await act(async () => refresh.resolve(configuration(2)));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(mocks.configure).toHaveBeenCalledTimes(2));
  expect(mocks.configure.mock.calls[1][1]).toMatchObject({
    expected_revision: 2,
    reviewer_ids: ["lawyer-b"],
  });
});

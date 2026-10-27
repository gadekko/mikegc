# Legal requests

Legal requests gives a team one shared queue for text-only NDA requests and
legal questions. An owner enables it in **Organization settings → Legal
requests** and chooses the Legal team. Every existing organization starts with
intake disabled. Personal workspaces do not have an intake queue.

## Working with a request

1. A team member opens **Legal requests → New request**, selects the type, and
   enters the subject and question. A business target date is optional and must
   include a confirmed timezone. It is not a verified legal deadline.
2. Legal opens the **Legal queue** and assigns the request to a current Legal
   team member. Search, status and assigned-lawyer filters narrow the queue.
3. The assigned lawyer can ask for information. The requester replies in the
   same conversation, returning the request to review.
4. The assigned lawyer writes an answer and previews its exact text. Editing it
   invalidates that preview. **Share answer and resolve** publishes that text to
   the requester in MikeGC and resolves the request in one database transaction.

Requests move through `submitted`, `in_review`, `needs_information`, `resolved`
and `cancelled`. A requester or Legal team member can cancel an unresolved
request. Resolved and cancelled requests remain readable but cannot be changed.
A different reviewer must explicitly reassign a request before asking a question
or publishing an answer.

This slice does not include Slack ingestion, attachments, AI triage, private
notes, email delivery, scheduled processing or automatic legal decisions.

## Access and retention

- Requesters can see their own requests and shared correspondence while they
  remain team members. Legal members can see the entire organization's queue.
  Assignment does not restrict read access within Legal.
- Owners configure the roster and can deliberately add themselves. They do not
  automatically receive content access. Admins outside Legal have only their
  own requester rights. Roster changes are recorded.
- This shared queue is unsuitable for matters that need separate access
  restrictions between Legal team members.
- Removing a reviewer ends their queue access and clears unresolved assignments.
  Removing the last reviewer pauses intake. Rejoining the organization does not
  restore Legal membership automatically.
- Pausing intake stops new submissions and changes. Existing authorized records
  remain readable. An owner can select replacement reviewers and resume it.
- Requests belong to the organization and remain when a member leaves. Account
  deletion clears identity references and command receipts involving the account
  in the same transaction that deletes the Auth identity. A storage cleanup
  failure leaves that attribution intact so the deletion worker can retry;
  names or other information typed into request text are not rewritten.
- Organization deletion uses the existing 30-day recovery period. Requests are
  unavailable while the organization is deleted, return on restoration, and
  cascade on permanent purge. An owner can also delete all request data in
  **Privacy & Data**. This preserves intake settings and the Legal roster.
  Only organization, actor and retired command IDs remain to stop an old retry
  from recreating deleted content. These identifiers contain no request text
  and are removed when the account identity or organization is deleted.

An account export includes only the caller's currently readable own requests,
with complete shared messages and history. Queue membership alone does not
export other people's requests. Each stored export carries the exact request
IDs, immutable creation identities and identity-erasure revisions represented in
its bytes. Download checks these and current access before and after reading
storage. Membership loss, request purge, organization deletion or deletion of a
contributor's account invalidates the affected artifact. A new export preserves
request text while showing erased contributors as former members. Intake
artifacts without an erasure revision must also be rebuilt. Pre-intake export
artifacts remain compatible.

## Reliability

The API derives the actor from authentication. Service-only SQL functions check
current membership, role, organization state and request version under database
locks. Browser database roles cannot query intake tables or execute its RPCs.
An owner with enrolled MFA must complete verification to change configuration.

Each write carries a command UUID. Retrying the same command and payload returns
its saved receipt without creating another request, message or event. Reusing a
command with changed input conflicts. State, history and receipt commit together.
Conflicts refresh the current request while retaining unsent text. An uncertain
network result locks editing and offers **Check again** for the same command.
A later access denial hides privileged content immediately.

Drafts and unconfirmed commands stay in tab memory, scoped to the signed-in
account, organization and request. Back/Forward, internal navigation and
workspace changes preserve them. Returning rechecks access and current server
state; a publication preview must be rebuilt. An in-flight result is handled by
its original view when you return, rather than navigating an unrelated page.
Signing out or changing accounts clears drafts and pending operations. Closing
the form explicitly discards its draft; reloading or closing the tab loses it.
No legal text or commands are written to browser storage or history state.
Do not treat unsent text as a saved request or answer. Configuration drafts keep
the revision originally loaded; a conflict requires explicit reload rather than
silently overwriting another owner's roster changes.

## Deployment and rollback

Apply migrations before starting the new application build:

- `20261026_00_org_departure_auth_role.sql` fixes the existing membership-departure
  trigger's Auth-table read under the trusted trigger owner. It leaves actor
  authorization unchanged and does not grant general access to `auth.users`.
- `20261026_01_intake_requests.sql` adds the intake schema, commands and lifecycle.

Use the existing migration runner documented in [deployment.md](deployment.md).
Do not replay historical migrations over a fresh schema. Fresh installations use
`backend/schema.sql`, including both migrations in its ledger.

Test with a synthetic organization first. Enabling a real pilot is an explicit
owner action. There is no new worker kind or scheduler. Account exports and
account deletion use the existing durable workers.

To pause, disable intake. To roll back application code, keep the additive schema
and stored records. An older binary cannot expose intake export/purge controls;
retain a compatible administrative build for those operations. Database triggers
continue to revoke reviewer access and detach deleted accounts even if the old
application does not know about intake. Do not drop the tables as rollback.

## Verification

- `npm test --prefix backend` and backend build, contract and test typechecks.
- `npm test --prefix frontend`, frontend typecheck/lint/production build, and
  Word add-in typecheck for shared-contract compatibility.
- `npm run test:stack --prefix backend` on a disposable local Supabase stack.
  The intake suite uses real authentication, routes, SQL, queue processing and
  filesystem storage, including an export beyond 1,000 rows and later revocation.
  Stack suites run serially because queue claims are global to the test database.
- `MIKE_TEST_POSTGRES_CONTAINER=<isolated-container> npm test --prefix backend --
  src/modules/intake/__tests__/intake.postgres.test.ts` for transaction rollback,
  concurrent commands, revocation, lifecycle and export invalidation. Schema-drift
  CI explicitly runs these tests and the existing organization lifecycle suites.
- `npm run test:e2e -- e2e/intake.spec.ts --project=chromium` against the documented
  local stack. The browser journey restores drafts across Back/Forward, drops a
  submission response after commit, then injects a rate limit and checks the
  exact retry creates only one request. It also drops an answer response after
  the real commit and checks that retrying publishes exactly once. It also checks requester/Legal
  interaction, owner content denial, narrow layout and critical accessibility.

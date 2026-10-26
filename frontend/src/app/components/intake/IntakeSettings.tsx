"use client";
import { useEffect, useRef, useState } from "react";
import type {
  IntakeConfiguration,
  IntakeReviewer,
  IntakeConfigurationCommand,
} from "@mike/contracts";
import { useOrganizationSettings } from "@/app/components/organizations/OrganizationSettingsShell";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import {
  configureIntake,
  getIntakeConfiguration,
  getIntakeReviewers,
  isMfaRequiredError,
} from "@/app/lib/mikeApi";
import { MfaVerificationPopup } from "@/app/components/popups/MfaVerificationPopup";
import { TABLE_CHECKBOX_CLASS } from "@/app/components/shared/TablePrimitive";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import {
  intakeError,
  useIntakeDraftWarning,
  useIntakeOperation,
} from "./useIntakeOperation";
export function IntakeSettings() {
  const { orgId, org } = useOrganizationSettings();
  const { accountId } = useWorkspace();
  if (org?.role !== "owner")
    return <p>Only organization owners can configure intake.</p>;
  return <Settings key={`${accountId}:${orgId}`} orgId={orgId} />;
}
export function Settings({ orgId }: { orgId: string }) {
  const [config, setConfig] = useState<IntakeConfiguration | null>(null);
  const [people, setPeople] = useState<IntakeReviewer[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [mfa, setMfa] = useState(false);
  const submitted = useRef<IntakeConfigurationCommand | null>(null);
  const [conflict, setConflict] = useState(false);
  const operation = useIntakeOperation(
    () => {
      setDirty(false);
      setConflict(false);
      setReload((x) => x + 1);
      window.dispatchEvent(new Event("mike:intake-configured"));
    },
    (error) => {
      if (isMfaRequiredError(error)) setMfa(true);
      else {
        const status =
          error && typeof error === "object" && "status" in error
            ? Number(error.status)
            : 0;
        if ([401, 403, 404].includes(status)) {
          setConfig(null);
          setPeople([]);
          setError(intakeError(error));
        }
        setConflict(true);
      }
    },
  );
  const confirmDiscard = useIntakeDraftWarning(dirty || operation.uncertain);
  // Keep the original revision with the draft. Never silently rebase old
  // reviewer selections onto configuration another owner has changed.
  useEffect(() => {
    let active = true;
    Promise.all([getIntakeConfiguration(orgId), getIntakeReviewers(orgId)])
      .then(([c, p]) => {
        if (!active) return;
        setConfig(c);
        setPeople(p);
        setError(null);
        setEnabled(c.enabled);
        setSelected(c.reviewer_ids ?? []);
      })
      .catch((e) => {
        if (active) {
          setConfig(null);
          setPeople([]);
          setError(intakeError(e));
        }
      });
    return () => {
      active = false;
    };
  }, [orgId, reload]);
  function save(body: IntakeConfigurationCommand) {
    submitted.current = body;
    void operation.execute(async () => {
      const receipt = await configureIntake(orgId, body);
      if (receipt.request_id !== null)
        throw new Error("Mismatched configuration receipt");
      return receipt;
    });
  }
  if (error)
    return (
      <div role="alert">
        {error}{" "}
        <PillButtonUI tone="black" onClick={() => setReload((x) => x + 1)}>
          Try again
        </PillButtonUI>
        {operation.uncertain && (
          <p role="status">
            The previous save is still unconfirmed.{" "}
            <PillButtonUI
              tone="black"
              disabled={operation.busy}
              onClick={() => void operation.execute()}
            >
              Check again
            </PillButtonUI>
          </p>
        )}
      </div>
    );
  if (!config) return <p role="status">Loading intake settings…</p>;
  if (!config.can_configure)
    return <p>Only organization owners can configure intake.</p>;
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const body = {
          command_id: crypto.randomUUID(),
          expected_revision: config.revision!,
          enabled,
          reviewer_ids: [...selected],
        };
        save(body);
      }}
    >
      <h2 className="font-serif text-2xl">Legal requests</h2>
      <p className="text-sm">
        Choose who handles requests. Everyone on the Legal team can read the
        entire queue. Requesters can only see their own requests. This is not
        suitable for matters requiring separate access restrictions.
      </p>
      <p className="text-sm">
        Owners can add themselves to Legal; roster changes are recorded.
        Requests belong to the organization and stay when someone leaves. Their
        access ends immediately. Account deletion clears identity links, but
        does not remove names typed in messages.
      </p>
      <label className="flex items-center gap-2">
        <input
          className={TABLE_CHECKBOX_CLASS}
          type="checkbox"
          checked={enabled}
          disabled={operation.locked || mfa || conflict}
          onChange={(e) => {
            setDirty(true);
            setEnabled(e.target.checked);
          }}
        />
        Enable intake
      </label>
      <fieldset
        disabled={operation.locked || mfa || conflict}
        className="space-y-3"
      >
        <legend className="mb-3">Legal team</legend>
        {people.map((p) => (
          <label
            className="flex items-start gap-2 [overflow-wrap:anywhere]"
            key={p.user_id}
          >
            <input
              className={TABLE_CHECKBOX_CLASS}
              type="checkbox"
              checked={selected.includes(p.user_id)}
              onChange={(e) => {
                setDirty(true);
                setSelected((s) =>
                  e.target.checked
                    ? [...s, p.user_id]
                    : s.filter((id) => id !== p.user_id),
                );
              }}
            />
            <span>
              {p.display_name ?? "Member"}
              <span className="block text-sm">{p.email}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {enabled && selected.length === 0 && (
        <p role="alert">Select at least one Legal team member.</p>
      )}
      <p className="text-sm">
        Disabling intake pauses changes and new requests. Existing records stay
        readable. Deleting the organization uses its 30-day recovery period,
        followed by permanent deletion. Privacy & Data also lets an owner delete
        request data.
      </p>
      {conflict && (
        <p role="alert">
          The settings could not be saved. Reload the current settings before
          making changes.{" "}
          <PillButtonUI
            tone="black"
            type="button"
            onClick={() => {
              if (confirmDiscard()) {
                setDirty(false);
                setConflict(false);
                setReload((x) => x + 1);
              }
            }}
          >
            Reload settings
          </PillButtonUI>
        </p>
      )}
      <MfaVerificationPopup
        open={mfa}
        onCancel={() => setMfa(false)}
        onVerified={() => {
          setMfa(false);
          if (operation.uncertain) void operation.execute();
          else if (submitted.current) save(submitted.current);
        }}
      />
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
      <PillButtonUI
        tone="black"
        type="submit"
        disabled={
          operation.locked ||
          mfa ||
          conflict ||
          (enabled && selected.length === 0)
        }
      >
        Save intake settings
      </PillButtonUI>
    </form>
  );
}

"use client";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useIntakeMemory, useIntakeDraft } from "./useIntakeMemory";
import type {
  IntakeConfiguration,
  IntakeReviewer,
  IntakeConfigurationCommand,
} from "@mike/contracts";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import {
  configureIntake,
  getIntakeConfiguration,
  getIntakeReviewers,
  isMfaRequiredError,
} from "@/app/lib/mikeApi";
import { Modal } from "@/app/components/modals/Modal";
import { MfaVerificationPopup } from "@/app/components/popups/MfaVerificationPopup";
import {
  SkeletonLine,
  TABLE_CHECKBOX_CLASS,
} from "@/app/components/shared/TablePrimitive";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { UserAvatar } from "@/app/components/ui/user-avatar";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { ToggleSwitchUI } from "@/shared/ui/ToggleSwitchUI";
import { LIQUID_GLASS_MODAL_ROW_HOVER_CLASS } from "@/shared/ui/LiquidGlassUI";
import {
  intakeError,
  useIntakeDraftWarning,
  useIntakeOperation,
} from "./useIntakeOperation";

/**
 * The owner's intake configuration: the on/off switch and the Legal team.
 * Edits stay bound to the configuration revision they were made against, so
 * another owner's change is never silently overwritten, and an uncertain or
 * MFA-interrupted save is replayed with the exact same command.
 */
function useIntakeConfigurationEditor(
  orgId: string,
  scope: string,
  onSaved?: () => void,
) {
  const memory = useIntakeMemory(orgId, scope);
  const [baseRevision, setBaseRevision] = useIntakeDraft<number | null>(
    memory,
    "revision",
    null,
  );
  const [config, setConfig] = useState<IntakeConfiguration | null>(null);
  const [people, setPeople] = useState<IntakeReviewer[]>([]);
  const [enabled, setEnabled] = useIntakeDraft(memory, "enabled", false);
  const [selected, setSelected] = useIntakeDraft<string[]>(
    memory,
    "selected",
    [],
  );
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [dirty, setDirty] = useIntakeDraft(memory, "dirty", false);
  const [mfa, setMfa] = useIntakeDraft(memory, "mfa", false);
  const [submitted, setSubmitted] =
    useIntakeDraft<IntakeConfigurationCommand | null>(
      memory,
      "submitted",
      null,
    );
  const [conflict, setConflict] = useIntakeDraft(memory, "conflict", false);
  const operation = useIntakeOperation(
    (receipt) => {
      setDirty(false);
      setBaseRevision(receipt.applied_version);
      setConflict(false);
      setReload((x) => x + 1);
      window.dispatchEvent(new Event("mike:intake-configured"));
      onSaved?.();
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
        // Only a stale revision needs a reload. Other rejections are already
        // reported and must not hide "Check again" or block saving.
        const code =
          error && typeof error === "object" && "code" in error
            ? error.code
            : null;
        if (status === 409 && code === "intake_conflict") setConflict(true);
      }
    },
    memory,
  );
  const confirmDiscard = useIntakeDraftWarning(dirty || operation.locked);
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
        if (!memory.values.get("dirty") && !memory.pending) {
          const roster = c.reviewer_ids ?? [];
          setEnabled(c.enabled);
          // Until an owner narrows it, the Legal team is everyone.
          setSelected(roster.length > 0 ? roster : p.map((x) => x.user_id));
          setBaseRevision(c.revision ?? null);
        }
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
  }, [orgId, reload, memory, setEnabled, setSelected, setBaseRevision]);
  /** Retain the exact configuration command for MFA retry and uncertain-save recovery. */
  function save(body: IntakeConfigurationCommand) {
    setSubmitted(body);
    void operation.execute(async () => {
      const receipt = await configureIntake(orgId, body);
      if (receipt.request_id !== null)
        throw new Error("Mismatched configuration receipt");
      return receipt;
    });
  }
  function submit(next: { enabled: boolean; reviewer_ids: string[] }) {
    save({
      command_id: crypto.randomUUID(),
      expected_revision: baseRevision!,
      ...next,
    });
  }
  const mfaPopup = (
    <MfaVerificationPopup
      open={mfa}
      onCancel={() => setMfa(false)}
      onVerified={() => {
        setMfa(false);
        if (operation.uncertain) void operation.execute();
        else if (submitted) save(submitted);
      }}
    />
  );
  function reloadSettings() {
    if (confirmDiscard()) {
      setDirty(false);
      setConflict(false);
      setReload((x) => x + 1);
    }
  }
  return {
    config,
    people,
    error,
    enabled,
    setEnabled,
    selected,
    setSelected,
    setDirty,
    conflict,
    operation,
    locked: operation.locked || mfa || conflict,
    confirmDiscard,
    submit,
    retry: () => setReload((x) => x + 1),
    reloadSettings,
    mfaPopup,
  };
}

/** The Features tab's intake switch, for organization owners. */
export function IntakeFeatureSetting({ orgId }: { orgId: string }) {
  const { accountId } = useWorkspace();
  if (!accountId) return null;
  return <FeatureSwitch key={`${accountId}:${orgId}`} orgId={orgId} />;
}

function FeatureSwitch({ orgId }: { orgId: string }) {
  const editor = useIntakeConfigurationEditor(orgId, "feature");
  const { config } = editor;
  return (
    <>
      <SettingsRow>
        <div className="min-w-0 space-y-1">
          <SettingsLabel>Intake</SettingsLabel>
          <SettingsDescription>
            Let members send NDA requests and legal questions to the Legal team.
          </SettingsDescription>
          {editor.error && (
            <p className="text-sm text-red-600" role="alert">
              {editor.error}
            </p>
          )}
          {editor.conflict && (
            <p className="text-sm text-red-600" role="alert">
              The setting changed elsewhere. Reload it and try again.
            </p>
          )}
          {editor.operation.uncertain && (
            <p className="text-sm text-gray-500" role="status">
              Checking whether the change was saved.
            </p>
          )}
        </div>
        {editor.error ? (
          <PillButtonUI tone="white" size="sm" onClick={editor.retry}>
            Try again
          </PillButtonUI>
        ) : editor.conflict ? (
          <PillButtonUI tone="white" size="sm" onClick={editor.reloadSettings}>
            Reload
          </PillButtonUI>
        ) : editor.operation.uncertain ? (
          <PillButtonUI
            tone="white"
            size="sm"
            disabled={editor.operation.busy}
            onClick={() => void editor.operation.execute()}
          >
            Check again
          </PillButtonUI>
        ) : config?.can_configure ? (
          <ToggleSwitchUI
            checked={editor.enabled}
            aria-label="Enable intake"
            disabled={editor.locked}
            aria-busy={editor.operation.busy}
            onCheckedChange={(next) => {
              editor.setDirty(true);
              editor.setEnabled(next);
              // The switch never changes the Legal team; owners choose it
              // from Intake settings.
              editor.submit({
                enabled: next,
                reviewer_ids: config.reviewer_ids ?? [],
              });
            }}
          />
        ) : (
          <div
            className="h-5 w-9 shrink-0 animate-pulse rounded-full bg-app-surface"
            aria-hidden="true"
          />
        )}
      </SettingsRow>
      {editor.mfaPopup}
    </>
  );
}

/** Choose the Legal team, from the Intake page's settings button. */
export function IntakeTeamModal({
  orgId,
  onClose,
}: {
  orgId: string;
  onClose: () => void;
}) {
  const editor = useIntakeConfigurationEditor(orgId, "settings", onClose);
  const { config, people, selected, operation } = editor;
  const empty = editor.enabled && selected.length === 0;
  function close() {
    if (operation.locked) return;
    if (editor.confirmDiscard()) onClose();
  }
  return (
    <>
      <Modal
        open
        onClose={close}
        breadcrumbs={["Intake", "Legal team"]}
        footerStatus={
          operation.uncertain ? (
            <span role="status">Checking whether it was saved.</span>
          ) : editor.conflict ? (
            <span role="alert">The settings changed elsewhere.</span>
          ) : undefined
        }
        secondaryAction={
          operation.uncertain
            ? {
                label: "Check again",
                onClick: () => void operation.execute(),
                disabled: operation.busy,
              }
            : editor.conflict
              ? {
                  label: "Reload settings",
                  onClick: editor.reloadSettings,
                  disabled: operation.locked,
                }
              : undefined
        }
        primaryAction={
          config?.can_configure
            ? {
                label: operation.busy ? "Saving…" : "Save",
                icon: operation.busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : undefined,
                onClick: () =>
                  editor.submit({
                    enabled: editor.enabled,
                    reviewer_ids: [...selected],
                  }),
                disabled: editor.locked || empty,
              }
            : undefined
        }
        cancelAction={{
          label: "Cancel",
          onClick: close,
          disabled: operation.locked,
        }}
      >
        <div
          data-modal-scroll="vertical"
          className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-4"
        >
          <p className="text-sm text-gray-500">
            Legal team members can see and answer every request.
          </p>
          {editor.error ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-red-600" role="alert">
                {editor.error}
              </p>
              <PillButtonUI tone="white" size="sm" onClick={editor.retry}>
                Try again
              </PillButtonUI>
            </div>
          ) : !config ? (
            <div className="space-y-3">
              <span role="status" className="sr-only">
                Loading intake settings…
              </span>
              {["w-32", "w-40", "w-28"].map((width) => (
                <div key={width} className="flex items-center gap-3 px-2">
                  <SkeletonLine className="w-4" />
                  <SkeletonLine className={width} />
                </div>
              ))}
            </div>
          ) : !config.can_configure ? (
            <p className="text-sm text-gray-500">
              Only organization owners can choose the Legal team.
            </p>
          ) : (
            <fieldset disabled={editor.locked} className="space-y-1">
              <legend className="sr-only">Legal team</legend>
              {people.map((p) => (
                <label
                  key={p.user_id}
                  className={`flex min-w-0 cursor-pointer items-center gap-3 rounded-lg px-2 py-2 ${LIQUID_GLASS_MODAL_ROW_HOVER_CLASS}`}
                >
                  <input
                    className={TABLE_CHECKBOX_CLASS}
                    type="checkbox"
                    checked={selected.includes(p.user_id)}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      editor.setDirty(true);
                      editor.setSelected((s) =>
                        checked
                          ? [...s, p.user_id]
                          : s.filter((id) => id !== p.user_id),
                      );
                    }}
                  />
                  <UserAvatar name={p.display_name} email={p.email} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-gray-700 [overflow-wrap:anywhere]">
                      {p.display_name ?? "Member"}
                    </span>
                    {p.email && (
                      <span className="block text-xs text-gray-500 [overflow-wrap:anywhere]">
                        {p.email}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {empty && (
            <p className="text-sm text-red-600" role="alert">
              Select at least one Legal team member.
            </p>
          )}
        </div>
      </Modal>
      {editor.mfaPopup}
    </>
  );
}

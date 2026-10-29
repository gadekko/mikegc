"use client";
import { useId } from "react";
import { Loader2 } from "lucide-react";
import type { IntakeSubmission } from "@mike/contracts";
import { submitIntakeRequest } from "@/app/lib/mikeApi";
import { discardIntakeDraft } from "@/app/lib/intakeMemory";
import { Modal } from "@/app/components/modals/Modal";
import { ModalSegmentedToggle } from "@/app/components/modals/ModalSegmentedToggle";
import { ModalTextarea } from "@/app/components/modals/ModalTextarea";
import { FieldLabel, FormTextInput } from "@/app/components/ui/form-field";
import { useIntakeDraft, useIntakeMemory } from "./useIntakeMemory";
import { useIntakeDraftWarning, useIntakeOperation } from "./useIntakeOperation";

const CATEGORY_OPTIONS = [
  { value: "general" as const, label: "Legal question" },
  { value: "nda" as const, label: "NDA request" },
];

/**
 * Submits a request to the organization's intake queue. The draft lives in
 * intake memory, so it survives navigation, and an uncertain submission is
 * replayed with the same request and command IDs until its outcome is known.
 */
export function NewIntakeRequestModal({
  orgId,
  enabled,
  onSaved,
  onClose,
}: {
  orgId: string;
  /** False while intake is paused; the draft stays editable but cannot be sent. */
  enabled: boolean;
  onSaved: (id: string) => void;
  onClose: () => void;
}) {
  const memory = useIntakeMemory(orgId, "new-request");
  const [subject, setSubject] = useIntakeDraft(memory, "subject", "");
  const [description, setDescription] = useIntakeDraft(
    memory,
    "description",
    "",
  );
  const [category, setCategory] = useIntakeDraft<"nda" | "general">(
    memory,
    "category",
    "general",
  );
  const [date, setDate] = useIntakeDraft(memory, "date", "");
  const [timezone, setTimezone] = useIntakeDraft(
    memory,
    "timezone",
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const operation = useIntakeOperation(
    (receipt) => {
      if (receipt.request_id) {
        discardIntakeDraft(memory);
        onSaved(receipt.request_id);
      }
    },
    undefined,
    memory,
  );
  const confirmDiscard = useIntakeDraftWarning(
    !!subject || !!description || !!date || operation.locked,
  );
  const typeId = useId();
  const subjectId = useId();
  const descriptionId = useId();
  const dateId = useId();
  const timezoneId = useId();
  const complete =
    !!subject.trim() && !!description.trim() && (!date || !!timezone.trim());

  function close() {
    if (operation.locked) return;
    if (confirmDiscard() && discardIntakeDraft(memory)) onClose();
  }

  function submit() {
    if (!enabled || !complete || operation.locked) return;
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
  }

  return (
    <Modal
      open
      onClose={close}
      breadcrumbs={["Intake", "New request"]}
      footerStatus={
        operation.uncertain ? (
          <span role="status">Checking whether it was saved.</span>
        ) : undefined
      }
      secondaryAction={
        operation.uncertain
          ? {
              label: "Check again",
              onClick: () => void operation.execute(),
              disabled: operation.busy,
            }
          : undefined
      }
      primaryAction={{
        label: operation.busy ? "Submitting…" : "Submit request",
        icon: operation.busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : undefined,
        onClick: submit,
        disabled: !enabled || !complete || operation.locked,
      }}
      cancelAction={{
        label: "Cancel",
        onClick: close,
        disabled: operation.locked,
      }}
    >
      <form
        data-modal-scroll="vertical"
        className="min-h-0 flex-1 space-y-6 overflow-y-auto pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div role="group" aria-labelledby={typeId}>
          <FieldLabel as="p" id={typeId}>
            Request type
          </FieldLabel>
          <ModalSegmentedToggle
            value={category}
            onChange={setCategory}
            options={CATEGORY_OPTIONS}
            disabled={operation.locked}
          />
        </div>
        <div>
          <FieldLabel htmlFor={subjectId}>Subject</FieldLabel>
          <FormTextInput
            id={subjectId}
            variant="minimal"
            placeholder="Summarize what you need"
            maxLength={200}
            value={subject}
            disabled={operation.locked}
            autoFocus
            onChange={(event) => setSubject(event.target.value)}
          />
        </div>
        <div>
          <FieldLabel htmlFor={descriptionId}>
            What do you need help with?
          </FieldLabel>
          <ModalTextarea
            id={descriptionId}
            className="min-h-32"
            placeholder="Give the Legal team the context they need"
            maxLength={20000}
            value={description}
            disabled={operation.locked}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <FieldLabel htmlFor={dateId}>Target date (optional)</FieldLabel>
            <FormTextInput
              id={dateId}
              type="date"
              value={date}
              disabled={operation.locked}
              onChange={(event) => setDate(event.target.value)}
            />
          </div>
          {date && (
            <div>
              <FieldLabel htmlFor={timezoneId}>Timezone</FieldLabel>
              <FormTextInput
                id={timezoneId}
                value={timezone}
                disabled={operation.locked}
                onChange={(event) => setTimezone(event.target.value)}
              />
            </div>
          )}
        </div>
        <p className="text-xs text-gray-500">
          A target date helps the Legal team plan. It is not a legal deadline.
          Everyone on the Legal team can read your request. Your draft is kept
          while you move around the app, but closing or reloading the tab can
          lose it.
        </p>
        {!enabled && (
          <p className="text-xs text-gray-500" role="status">
            Intake is paused, so new requests cannot be submitted right now.
          </p>
        )}
      </form>
    </Modal>
  );
}

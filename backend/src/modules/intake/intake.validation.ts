import { z } from "zod";
export const intakeId = z.uuid();
/** Bound submitted text without changing the exact content later shown for review. */
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => v.trim().length > 0);
export const intakePage = z.object({
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const intakeList = intakePage.extend({
  view: z.enum(["mine", "queue"]).default("mine"),
  state: z
    .enum([
      "submitted",
      "in_review",
      "needs_information",
      "resolved",
      "cancelled",
    ])
    .optional(),
  assignee: intakeId.optional(),
  search: z.string().max(200).default(""),
});
export const intakeSubmit = z
  .object({
    id: intakeId,
    command_id: intakeId,
    category: z.enum(["nda", "general"]),
    subject: text(200),
    description: text(20000),
    requested_by_date: z.iso.date().nullable().default(null),
    timezone: z.string().min(1).max(100).nullable().default(null),
  })
  .strict()
  .refine((v) => (v.requested_by_date === null) === (v.timezone === null))
  .refine((v) => {
    if (v.timezone === null) return true;
    try {
      new Intl.DateTimeFormat("en", { timeZone: v.timezone });
      return true;
    } catch {
      return false;
    }
  });
export const intakeConfigure = z
  .object({
    command_id: intakeId,
    expected_revision: z.number().int().min(0),
    enabled: z.boolean(),
    reviewer_ids: z.array(intakeId).max(500),
  })
  .strict();
export const intakeCommand = z.object({
  command_id: intakeId,
  expected_version: z.number().int().positive(),
});
export const intakeMessageCommand = intakeCommand
  .extend({ body: text(20000) })
  .strict();
export const intakeAssignment = intakeCommand
  .extend({ assignee_id: intakeId.nullable() })
  .strict();

import { Router } from "express";
import type { IntakeReceipt } from "@mike/contracts";
import { requireAuth, requireMfaIfEnrolled } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure } from "../../lib/serviceResult";
import { intakeRpc } from "./intake.service";
import {
  intakeId,
  intakePage,
  intakeList,
  intakeSubmit,
  intakeConfigure,
  intakeCommand,
  intakeMessageCommand,
  intakeAssignment,
} from "./intake.validation";

export const intakeRouter = Router();
intakeRouter.use(requireAuth);
intakeRouter.param("orgId", (req, res, next, value) => {
  if (!intakeId.safeParse(value).success)
    return void res.status(400).json({ detail: "Invalid organization ID." });
  next();
});
intakeRouter.param("requestId", (req, res, next, value) => {
  if (!intakeId.safeParse(value).success)
    return void res.status(400).json({ detail: "Invalid request ID." });
  next();
});
for (const [path, rpc] of [
  ["configuration", "intake_configuration"],
  ["reviewers", "intake_roster"],
]) {
  intakeRouter.get(
    `/:orgId/${path}`,
    asyncRoute(async (req, res) => {
      const result = await intakeRpc(createServerSupabase(), rpc, {
        p_org: req.params.orgId,
        p_actor: res.locals.userId,
      });
      if (!result.ok) return void sendServiceFailure(res, result);
      res.json(result.data);
    }),
  );
}
intakeRouter.put(
  "/:orgId/configuration",
  requireMfaIfEnrolled,
  asyncRoute(async (req, res) => {
    const parsed = intakeConfigure.safeParse(req.body);
    if (!parsed.success)
      return void res
        .status(400)
        .json({ detail: "Check the intake configuration." });
    const v = parsed.data;
    const result = await intakeRpc(createServerSupabase(), "intake_configure", {
      p_org: req.params.orgId,
      p_actor: res.locals.userId,
      p_command: v.command_id,
      p_revision: v.expected_revision,
      p_enabled: v.enabled,
      p_reviewers: v.reviewer_ids,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);
intakeRouter.get(
  "/:orgId/requests",
  asyncRoute(async (req, res) => {
    const parsed = intakeList.safeParse(req.query);
    if (!parsed.success)
      return void res.status(400).json({ detail: "Invalid request filters." });
    const v = parsed.data;
    const result = await intakeRpc(
      createServerSupabase(),
      "intake_list_requests",
      {
        p_org: req.params.orgId,
        p_actor: res.locals.userId,
        p_view: v.view,
        p_state: v.state ?? null,
        p_assignee: v.assignee ?? null,
        p_search: v.search,
        p_offset: v.offset,
        p_limit: v.limit,
      },
    );
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);
intakeRouter.post(
  "/:orgId/requests",
  asyncRoute(async (req, res) => {
    const parsed = intakeSubmit.safeParse(req.body);
    if (!parsed.success)
      return void res
        .status(400)
        .json({
          detail:
            "Enter a subject, request and valid business target date/timezone if needed.",
        });
    const v = parsed.data;
    const result = await intakeRpc<IntakeReceipt>(
      createServerSupabase(),
      "intake_submit_request",
      {
        p_org: req.params.orgId,
        p_actor: res.locals.userId,
        p_command: v.command_id,
        p_request: v.id,
        p_category: v.category,
        p_subject: v.subject,
        p_description: v.description,
        p_date: v.requested_by_date,
        p_timezone: v.timezone,
      },
    );
    if (!result.ok) return void sendServiceFailure(res, result);
    res.status(result.data.replayed ? 200 : 201).json(result.data);
  }),
);
intakeRouter.get(
  "/:orgId/requests/:requestId",
  asyncRoute(async (req, res) => {
    const result = await intakeRpc(
      createServerSupabase(),
      "intake_get_request",
      {
        p_org: req.params.orgId,
        p_actor: res.locals.userId,
        p_request: req.params.requestId,
      },
    );
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);
for (const path of ["messages", "events"]) {
  intakeRouter.get(
    `/:orgId/requests/:requestId/${path}`,
    asyncRoute(async (req, res) => {
      const parsed = intakePage.safeParse(req.query);
      if (!parsed.success)
        return void res.status(400).json({ detail: "Invalid page." });
      const result = await intakeRpc(
        createServerSupabase(),
        "intake_read_history",
        {
          p_org: req.params.orgId,
          p_actor: res.locals.userId,
          p_request: req.params.requestId,
          p_events: path === "events",
          p_offset: parsed.data.offset,
          p_limit: parsed.data.limit,
        },
      );
      if (!result.ok) return void sendServiceFailure(res, result);
      res.json(result.data);
    }),
  );
}
for (const [path, rpc] of [
  ["assignment", "intake_assign_request"],
  ["questions", "intake_ask_request"],
  ["replies", "intake_reply_request"],
  ["answer", "intake_publish_request"],
  ["cancel", "intake_cancel_request"],
]) {
  intakeRouter.post(
    `/:orgId/requests/:requestId/${path}`,
    asyncRoute(async (req, res) => {
      const schema =
        path === "assignment"
          ? intakeAssignment
          : path === "cancel"
            ? intakeCommand.strict()
            : intakeMessageCommand;
      const parsed = schema.safeParse(req.body);
      if (!parsed.success)
        return void res
          .status(400)
          .json({ detail: "Check the command and message fields." });
      const v = parsed.data;
      const args: Record<string, unknown> = {
        p_org: req.params.orgId,
        p_actor: res.locals.userId,
        p_request: req.params.requestId,
        p_command: v.command_id,
        p_version: v.expected_version,
      };
      if ("body" in v) args.p_body = v.body;
      if ("assignee_id" in v) args.p_assignee = v.assignee_id;
      const result = await intakeRpc(createServerSupabase(), rpc, args);
      if (!result.ok) return void sendServiceFailure(res, result);
      res.json(result.data);
    }),
  );
}
intakeRouter.use(routerErrorHandler("[intake]"));

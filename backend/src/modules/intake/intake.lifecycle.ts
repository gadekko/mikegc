import type {
  IntakeRequest,
  IntakeMessage,
  IntakeEvent,
} from "@mike/contracts";
import type { Db } from "../../lib/supabase";
import { intakeRpc } from "./intake.requests";

export interface IntakeExport {
  version: 1;
  requests: {
    request: IntakeRequest;
    messages: IntakeMessage[];
    events: IntakeEvent[];
  }[];
}
async function required<T>(
  db: Db,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await intakeRpc<T>(db, name, args);
  if (!result.ok)
    throw new Error(
      "Intake data operation failed; rebuild the export after checking access.",
    );
  return result.data;
}
export async function buildIntakeExport(
  db: Db,
  userId: string,
): Promise<IntakeExport> {
  const requests: IntakeExport["requests"] = [];
  let after: string | null = null;
  for (;;) {
    const page: IntakeRequest[] = await required(db, "intake_export_requests", {
      p_actor: userId,
      p_after: after,
      p_limit: 100,
    });
    for (const request of page) {
      const history = async <T>(events: boolean): Promise<T[]> => {
        const rows: T[] = [];
        for (let offset = 0; ; offset += 100) {
          const batch = await required<T[]>(db, "intake_read_history", {
            p_org: request.org_id,
            p_actor: userId,
            p_request: request.id,
            p_events: events,
            p_offset: offset,
            p_limit: 100,
          });
          rows.push(...batch);
          if (batch.length < 100) return rows;
        }
      };
      const messages = await history<IntakeMessage>(false);
      const events = await history<IntakeEvent>(true);
      const current = await required<IntakeRequest>(db, "intake_get_request", {
        p_org: request.org_id,
        p_actor: userId,
        p_request: request.id,
      });
      if (
        current.version !== request.version ||
        current.incarnation_id !== request.incarnation_id
      ) {
        throw new Error(
          "Intake changed during export; retry to build a consistent snapshot.",
        );
      }
      requests.push({ request, messages, events });
    }
    if (page.length < 100) break;
    after = page[page.length - 1].id;
  }
  const manifest = {
    version: 1,
    requests: requests.map((x) => ({
      id: x.request.id,
      incarnation_id: x.request.incarnation_id,
    })),
  };
  if (!(await validateIntakeExport(db, userId, manifest)))
    throw new Error("Intake export scope changed during generation.");
  return { version: 1, requests };
}
export async function validateIntakeExport(
  db: Db,
  userId: string,
  manifest: unknown,
): Promise<boolean> {
  if (!manifest || typeof manifest !== "object") return false;
  const m = manifest as { version?: unknown; requests?: unknown };
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    m.version !== 1 ||
    !Array.isArray(m.requests) ||
    m.requests.some(
      (row) =>
        !row ||
        typeof row !== "object" ||
        !uuid.test(row.id) ||
        !uuid.test(row.incarnation_id),
    )
  )
    return false;
  for (let i = 0; i < m.requests.length; i += 100) {
    const result = await intakeRpc<boolean>(db, "intake_validate_export", {
      p_actor: userId,
      p_requests: m.requests.slice(i, i + 100),
    });
    if (!result.ok || result.data !== true) return false;
  }
  return true;
}
export async function eraseIntakeIdentity(
  db: Db,
  userId: string,
): Promise<void> {
  await required(db, "intake_erase_identity", { p_actor: userId });
}
export async function purgeIntake(
  db: Db,
  orgId: string,
  userId: string,
): Promise<void> {
  await required(db, "intake_purge", { p_org: orgId, p_actor: userId });
}

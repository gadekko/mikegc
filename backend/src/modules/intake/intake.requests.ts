import type { Db } from "../../lib/supabase";
import {
  failure,
  internalFailure,
  ok,
  type ServiceResult,
} from "../../lib/serviceResult";

/** SQL owns live scope checks, transactions and replay. Never log input text. */
export async function intakeRpc<T>(
  db: Db,
  name: string,
  args: Record<string, unknown>,
): Promise<ServiceResult<T>> {
  for (let attempt = 0; ; attempt++) {
    const { data, error } = await db.rpc(name, args);
    if (!error) return ok(data as T);
    // PostgreSQL guarantees these transactions aborted. Reuse the exact command.
    if (["40P01", "40001"].includes(error.code) && attempt < 2) continue;
    if (error.code === "P0002")
      return failure("not_found", "Legal request not found.");
    if (error.code === "42501")
      return failure("forbidden", "You don't have permission for this action.");
    if (error.code === "P0004")
      return failure(
        "conflict",
        "This command belongs to requests that were deleted. Start a new request.",
        "intake_purged",
      );
    if (error.code === "P0001" || error.code === "23505")
      return failure(
        "conflict",
        "This request changed. Reload it before trying again.",
        "intake_conflict",
      );
    if (error.code === "P0003")
      return failure(
        "conflict",
        "Intake is paused. Existing requests are read-only.",
        "intake_paused",
      );
    if (["22023", "23514", "22P02", "22007", "22008"].includes(error.code))
      return failure(
        "validation",
        "Check the request fields and selected Legal team members.",
      );
    // Postgres details can contain rejected request text. Report only its code.
    return internalFailure(
      new Error(
        `Intake database operation failed (${error.code ?? "unknown"})`,
      ),
    );
  }
}

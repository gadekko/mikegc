import { describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";
import { buildIntakeExport, validateIntakeExport } from "../intake.lifecycle";
import { intakeRpc } from "../intake.requests";
const id = "00000000-0000-4000-8000-000000000001";
const incarnation_id = "00000000-0000-4000-8000-000000000002";
describe("intake export consistency", () => {
  it("refuses a request whose version changed between history reads", async () => {
    const rpc = vi.fn(async (name: string) => ({
      error: null,
      data:
        name === "intake_export_requests"
          ? [{ id, incarnation_id, org_id: id, version: 1 }]
          : name === "intake_get_request"
            ? { id, incarnation_id, version: 2 }
            : [],
    }));
    await expect(
      buildIntakeExport({ rpc } as unknown as Db, id),
    ).rejects.toThrow("changed during export");
  });
  it("pages both child histories and validates precisely the serialized requests", async () => {
    const row = { id, incarnation_id, org_id: id, version: 1 };
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => ({
      error: null,
      data:
        name === "intake_export_requests"
          ? [row]
          : name === "intake_get_request"
            ? row
            : name === "intake_validate_export"
              ? true
              : Array.from(
                  { length: args.p_offset === 0 ? 100 : 1 },
                  (_, i) => ({ id: i + Number(args.p_offset) }),
                ),
    }));
    const result = await buildIntakeExport({ rpc } as unknown as Db, id);
    expect(result.requests[0].messages).toHaveLength(101);
    expect(result.requests[0].events).toHaveLength(101);
    expect(rpc).toHaveBeenCalledWith("intake_validate_export", {
      p_actor: id,
      p_requests: [{ id, incarnation_id }],
    });
  });
  it.each([
    null,
    {},
    { version: 2, requests: [] },
    { version: 1, request_ids: [id] },
    { version: 1, requests: [{ id }] },
    { version: 1, requests: [{ id: "x", incarnation_id }] },
  ])("fails closed for a malformed manifest %j", async (manifest) => {
    const rpc = vi.fn();
    expect(
      await validateIntakeExport({ rpc } as unknown as Db, id, manifest),
    ).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("fails closed if a download's access check fails", async () => {
    const rpc = vi.fn(async () => ({ error: { code: "42501" }, data: null }));
    expect(
      await validateIntakeExport({ rpc } as unknown as Db, id, {
        version: 1,
        requests: [{ id, incarnation_id }],
      }),
    ).toBe(false);
  });
});
describe("intake RPC failures", () => {
  it("retries only aborted transactions with exactly the same arguments", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ error: { code: "40P01" } })
      .mockResolvedValueOnce({ error: { code: "40001" } })
      .mockResolvedValue({ error: null, data: { saved: true } });
    const args = { p_command: id };
    expect(
      (await intakeRpc({ rpc } as unknown as Db, "intake_cancel_request", args))
        .ok,
    ).toBe(true);
    expect(rpc.mock.calls).toEqual(
      Array.from({ length: 3 }, () => ["intake_cancel_request", args]),
    );
  });
  it.each([
    "P0002",
    "42501",
    "P0001",
    "23505",
    "P0003",
    "22023",
    "23514",
    "22P02",
    "22007",
    "22008",
    "XX000",
    "40P01",
  ])("sanitizes database error %s", async (code) => {
    const rpc = vi.fn(async () => ({
      error: {
        code,
        message: "CONFIDENTIAL INPUT",
        details: "CONFIDENTIAL INPUT",
      },
    }));
    const result = await intakeRpc(
      { rpc } as unknown as Db,
      "intake_submit_request",
      {},
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("CONFIDENTIAL INPUT");
    expect(rpc).toHaveBeenCalledTimes(code === "40P01" ? 3 : 1);
  });
});

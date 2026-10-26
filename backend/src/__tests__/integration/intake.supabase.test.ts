import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbJob } from "../../lib/dbq/types";

const url = process.env.SUPABASE_TEST_URL;
const key = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const anon = process.env.SUPABASE_TEST_ANON_KEY;
// Uses real GoTrue tokens, route middleware, SQL transactions, queue runner and
// filesystem storage. No auth/database/worker mocks or external model calls.
describe.skipIf(!url || !key || !anon)(
  "intake authenticated stack and workers",
  () => {
    let db: SupabaseClient;
    const app = express();
    const org = randomUUID();
    const other = randomUUID();
    const users: { id: string; token: string; email: string }[] = [];
    let storageRoot = "";
    let exportId = "";
    const path = `/intake/${org}`;
    const post = (actor: number, suffix: string, body: object) =>
      request(app)
        .post(path + suffix)
        .auth(users[actor].token, { type: "bearer" })
        .send(body);
    const get = (actor: number, suffix: string) =>
      request(app)
        .get(path + suffix)
        .auth(users[actor].token, { type: "bearer" });
    const configure = (revision: number, enabled = true) =>
      request(app)
        .put(path + "/configuration")
        .auth(users[0].token, { type: "bearer" })
        .send({
          command_id: randomUUID(),
          expected_revision: revision,
          enabled,
          reviewer_ids: [users[2].id, users[3].id],
        });
    const input = () => ({
      id: randomUUID(),
      command_id: randomUUID(),
      category: "nda",
      subject: "Synthetic NDA",
      description: "Please review this request.",
    });
    beforeAll(async () => {
      vi.stubEnv("SUPABASE_URL", url!);
      vi.stubEnv("SUPABASE_SECRET_KEY", key!);
      vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", anon!);
      storageRoot = await mkdtemp(join(tmpdir(), "mikegc-intake-storage-"));
      vi.stubEnv("STORAGE_DRIVER", "fs");
      vi.stubEnv("STORAGE_FS_ROOT", storageRoot);
      db = createClient(url!, key!, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      for (let i = 0; i < 6; i++) {
        const email = `intake-${randomUUID()}@test.local`;
        const password = `IntakeTest-${randomUUID()}!`;
        const created = await db.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
        });
        if (created.error || !created.data.user)
          throw created.error ?? new Error("No user");
        const login = await createClient(url!, anon!, {
          auth: { persistSession: false, autoRefreshToken: false },
        }).auth.signInWithPassword({ email, password });
        if (login.error || !login.data.session)
          throw login.error ?? new Error("No session");
        users.push({
          id: created.data.user.id,
          email,
          token: login.data.session.access_token,
        });
      }
      expect(
        (
          await db.from("organizations").insert([
            { id: org, name: "Synthetic Legal", created_by: users[0].id },
            { id: other, name: "Other Legal", created_by: users[5].id },
          ])
        ).error,
      ).toBeNull();
      expect(
        (
          await db.from("org_members").insert(
            users.map((u, i) => ({
              org_id: i === 5 ? other : org,
              user_id: u.id,
              role: i === 0 || i === 5 ? "owner" : i === 4 ? "admin" : "member",
            })),
          )
        ).error,
      ).toBeNull();
      const { intakeRouter } = await import(
        "../../modules/intake/intake.routes.js"
      );
      app.use(express.json());
      app.use("/intake", intakeRouter);
      expect((await configure(0)).status).toBe(200);
      expect((await get(0, "/reviewers")).body).toHaveLength(5);
      expect((await get(2, "/reviewers")).body).toHaveLength(2);
    }, 60000);
    afterAll(async () => {
      if (db) {
        if (exportId) await db.from("db_jobs").delete().eq("id", exportId);
        expect(
          (await db.from("organizations").delete().in("id", [org, other]))
            .error,
        ).toBeNull();
        for (const u of users)
          expect((await db.auth.admin.deleteUser(u.id)).error).toBeNull();
      }
      if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }, 30000);
    it("enforces real authentication, hidden IDs and input validation", async () => {
      expect((await request(app).get(path + "/requests")).status).toBe(401);
      expect((await get(5, "/requests")).status).toBe(404);
      for (const extra of [
        { subject: " " },
        { requested_by_date: "2026-02-30", timezone: "Europe/Stockholm" },
        { requested_by_date: "2026-10-26", timezone: "invalid" },
        { requester_id: users[0].id },
      ]) {
        expect(
          (await post(1, "/requests", { ...input(), ...extra })).status,
        ).toBe(400);
      }
      const body = input();
      expect((await post(1, "/requests", body)).status).toBe(201);
      for (const actor of [0, 4, 5]) {
        const hidden = await get(actor, `/requests/${body.id}`);
        expect([403, 404]).toContain(hidden.status);
        expect(hidden.body).not.toHaveProperty("description");
      }
      expect((await get(4, "/requests?view=queue")).status).toBe(403);
      expect((await get(1, "/reviewers")).status).toBe(403);
      const direct = createClient(url!, anon!, {
        global: { headers: { Authorization: `Bearer ${users[1].token}` } },
      });
      for (const table of [
        "settings",
        "reviewers",
        "requests",
        "messages",
        "events",
        "commands",
        "purged_commands",
      ])
        expect(
          (await direct.from(`intake_${table}`).select("*")).error,
        ).not.toBeNull();
      expect(
        (
          await direct.rpc("intake_get_request", {
            p_org: org,
            p_actor: users[2].id,
            p_request: body.id,
          })
        ).error,
      ).not.toBeNull();
    });
    it("reconciles a lost response without duplication and publishes exact reviewed text", async () => {
      const body = input();
      await post(1, "/requests", body); // deliberately ignore the successful receipt
      const replay = await post(1, "/requests", body);
      expect(replay.status).toBe(200);
      expect(replay.body.replayed).toBe(true);
      expect(
        (await post(1, "/requests", { ...body, subject: "Changed" })).status,
      ).toBe(409);
      const action = (
        actor: number,
        name: string,
        version: number,
        fields = {},
      ) =>
        post(actor, `/requests/${body.id}/${name}`, {
          command_id: randomUUID(),
          expected_version: version,
          ...fields,
        });
      expect(
        (await action(2, "assignment", 1, { assignee_id: users[2].id })).status,
      ).toBe(200);
      expect(
        (await action(3, "answer", 2, { body: "Not assigned" })).status,
      ).toBe(403);
      expect(
        (await action(2, "questions", 2, { body: "Who is the supplier?" }))
          .status,
      ).toBe(200);
      expect(
        (await action(1, "replies", 3, { body: "Synthetic Ltd" })).status,
      ).toBe(200);
      const answer = {
        command_id: randomUUID(),
        expected_version: 4,
        body: "Exact answer.\nKeep this spacing.  ",
      };
      expect(
        (await post(2, `/requests/${body.id}/answer`, answer)).status,
      ).toBe(200);
      expect(
        (await post(2, `/requests/${body.id}/answer`, answer)).body.replayed,
      ).toBe(true);
      const messages = (await get(1, `/requests/${body.id}/messages`)).body;
      expect(messages.map((x: { body: string }) => x.body)).toEqual([
        "Who is the supplier?",
        "Synthetic Ltd",
        answer.body,
      ]);
      expect((await get(1, `/requests/${body.id}`)).body).toMatchObject({
        state: "resolved",
        version: 5,
      });
      expect((await action(1, "cancel", 5)).status).toBe(409);
    });
    it("paginates scoped lists and pauses writes while preserving reads", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const body = { ...input(), subject: `Pagination ${i}` };
        ids.push(body.id);
        expect((await post(1, "/requests", body)).status).toBe(201);
      }
      const rows: { id: string }[] = [];
      for (let offset = 0; offset < 3; offset++)
        rows.push(
          ...(
            await get(
              2,
              `/requests?view=queue&search=Pagination&limit=1&offset=${offset}`,
            )
          ).body,
        );
      expect(rows.map((x) => x.id).sort()).toEqual(ids.sort());
      expect((await configure(1, false)).status).toBe(200);
      expect((await post(1, "/requests", input())).status).toBe(409);
      const detail = await get(1, `/requests/${ids[0]}`);
      expect(detail.status).toBe(200);
      expect(Object.values(detail.body.capabilities)).not.toContain(true);
      expect((await configure(2, true)).status).toBe(200);
    });
    it("detaches a reviewer deleted through the real Auth role while the organization is suspended", async () => {
      const created = await db.auth.admin.createUser({
        email: `intake-erasure-${randomUUID()}@test.local`,
        email_confirm: true,
      });
      expect(created.error).toBeNull();
      const id = created.data.user!.id;
      const isolated = randomUUID();
      const requestId = randomUUID();
      try {
        expect(
          (
            await db.from("organizations").insert({
              id: isolated,
              name: "Suspended fixture",
              created_by: users[0].id,
            })
          ).error,
        ).toBeNull();
        expect(
          (
            await db.from("org_members").insert([
              { org_id: isolated, user_id: users[0].id, role: "owner" },
              { org_id: isolated, user_id: id, role: "member" },
            ])
          ).error,
        ).toBeNull();
        expect(
          (
            await db.rpc("intake_configure", {
              p_org: isolated,
              p_actor: users[0].id,
              p_command: randomUUID(),
              p_revision: 0,
              p_enabled: true,
              p_reviewers: [id],
            })
          ).error,
        ).toBeNull();
        expect(
          (
            await db.rpc("intake_submit_request", {
              p_org: isolated,
              p_actor: users[0].id,
              p_command: randomUUID(),
              p_request: requestId,
              p_category: "general",
              p_subject: "Retained",
              p_description: "Synthetic retained text",
            })
          ).error,
        ).toBeNull();
        expect(
          (
            await db.rpc("intake_assign_request", {
              p_org: isolated,
              p_actor: id,
              p_command: randomUUID(),
              p_request: requestId,
              p_version: 1,
              p_assignee: id,
            })
          ).error,
        ).toBeNull();
        expect(
          (
            await db.rpc("soft_delete_organization", {
              p_org_id: isolated,
              p_actor_id: users[0].id,
            })
          ).error,
        ).toBeNull();
        expect((await db.auth.admin.deleteUser(id)).error).toBeNull();
        expect(
          (
            await db
              .from("intake_settings")
              .select("enabled")
              .eq("org_id", isolated)
              .single()
          ).data?.enabled,
        ).toBe(false);
        expect(
          (
            await db
              .from("intake_requests")
              .select("assignee_id,description")
              .eq("id", requestId)
              .single()
          ).data,
        ).toEqual({
          assignee_id: null,
          description: "Synthetic retained text",
        });
      } finally {
        await db.from("organizations").delete().eq("id", isolated);
        await db.auth.admin.deleteUser(id);
      }
    });
    it("exports over 1,000 requests through the real worker and denies the stored artifact after revocation", async () => {
      const rows = Array.from({ length: 1001 }, (_, i) => ({
        id: randomUUID(),
        org_id: org,
        requester_id: users[1].id,
        subject: `Bulk ${i}`,
        description: "Synthetic",
        category: "general",
      }));
      for (let offset = 0; offset < rows.length; offset += 200)
        expect(
          (
            await db
              .from("intake_requests")
              .insert(rows.slice(offset, offset + 200))
          ).error,
        ).toBeNull();
      const { startUserExport, loadUserExportArtifact } = await import(
        "../../modules/user/user.export.js"
      );
      const { handleExportBuild } = await import(
        "../../modules/user/user.exportJobs.js"
      );
      const { processClaimedJob } = await import("../../lib/dbq/runner.js");
      const started = await startUserExport(db, {
        userId: users[1].id,
        type: "account",
        payload: {
          userId: users[1].id,
          userEmail: users[1].email,
          type: "account",
        },
      });
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error(started.detail);
      exportId = started.exportId;
      const claimed = await db.rpc("claim_db_job", {
        p_id: exportId,
        p_stale_seconds: 600,
      });
      expect(claimed.error).toBeNull();
      const job = (claimed.data as DbJob[]).find((x) => x.id === exportId);
      expect(job).toBeTruthy();
      await processClaimedJob(db, { "export.build": handleExportBuild }, job!);
      const stored = await db
        .from("db_jobs")
        .select("status,result,last_error")
        .eq("id", exportId)
        .single();
      expect(stored.data?.status, JSON.stringify(stored.data)).toBe("done");
      const downloaded = await loadUserExportArtifact(
        db,
        exportId,
        users[1].id,
      );
      expect(downloaded.ok).toBe(true);
      if (!downloaded.ok) throw new Error(downloaded.kind);
      const exported = JSON.parse(downloaded.body.toString()).intake
        .requests as { request: { id: string; incarnation_id: string } }[];
      expect(exported.length).toBeGreaterThan(1000);
      expect(new Set(exported.map((x) => x.request.id)).size).toBe(
        exported.length,
      );
      expect(stored.data!.result.intake_manifest.requests).toEqual(
        exported.map((x) => ({
          id: x.request.id,
          incarnation_id: x.request.incarnation_id,
        })),
      );
      expect(
        rows.every((r) => exported.some((x) => x.request.id === r.id)),
      ).toBe(true);
      // Revoke after real filesystem bytes are read, before the response leaves.
      // The second authorization check must refuse those already-read bytes.
      const { setStorageAdapter } = await import("../../lib/storage.js");
      const { createFilesystemStorageAdapter } = await import(
        "../../lib/storage/filesystem.js"
      );
      const filesystem = createFilesystemStorageAdapter();
      let storageRead = false;
      setStorageAdapter({
        ...filesystem,
        async downloadFile(key) {
          const bytes = await filesystem.downloadFile(key);
          storageRead = true;
          expect(bytes).not.toBeNull();
          expect(
            (
              await db.rpc("remove_org_member", {
                p_org_id: org,
                p_user_id: users[1].id,
                p_actor_id: users[0].id,
              })
            ).error,
          ).toBeNull();
          return bytes;
        },
      });
      try {
        expect(await loadUserExportArtifact(db, exportId, users[1].id)).toEqual(
          {
            ok: false,
            kind: "expired",
          },
        );
        expect(storageRead).toBe(true);
      } finally {
        setStorageAdapter(filesystem);
      }
      expect(await loadUserExportArtifact(db, exportId, users[1].id)).toEqual({
        ok: false,
        kind: "expired",
      });
      expect((await get(1, "/requests")).status).toBe(404);
      // Erasure uses the existing real worker path; organization request text survives.
      const { handleAccountDelete } = await import(
        "../../modules/user/user.accountJobs.js"
      );
      await handleAccountDelete(db, {
        ...job!,
        id: randomUUID(),
        kind: "account.delete",
        payload: { userId: users[1].id, userEmail: users[1].email },
      });
      const retained = await db
        .from("intake_requests")
        .select("requester_id,description")
        .eq("id", rows[0].id)
        .single();
      expect(retained.data).toEqual({
        requester_id: null,
        description: "Synthetic",
      });
      users.splice(1, 1); // account is already removed by the worker
    }, 180000);
  },
);

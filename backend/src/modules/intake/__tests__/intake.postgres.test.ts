import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
const container = process.env.MIKE_TEST_POSTGRES_CONTAINER;
const database = `mike_intake_${process.pid}_${Date.now()}`;
const uid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const q = (n: number) => `'${uid(n)}'`;
const args = () => [
  "exec",
  "-i",
  container!,
  "psql",
  "-U",
  "postgres",
  "-d",
  database,
  "-v",
  "ON_ERROR_STOP=1",
  "-XqAt",
];
const sql = (input: string) =>
  execFileSync("docker", args(), {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
const json = (query: string) => JSON.parse(sql(query));
const cmd = (
  name: string,
  actor: number,
  command: number,
  version: number,
  extra = "",
) =>
  `select public.intake_${name}_request(${q(10)},${q(actor)},${q(command)},${q(20)},${version}${extra});`;
const submit = (command = 100) =>
  `select public.intake_submit_request(${q(10)},${q(2)},${q(command)},${q(20)},'nda','Supplier NDA','Please review');`;
const parallel = (input: string) =>
  new Promise<{ code: number | null; out: string }>((resolveResult) => {
    const p = spawn("docker", args());
    let out = "";
    p.stdout.on("data", (x) => {
      out += x;
    });
    p.stderr.on("data", (x) => {
      out += x;
    });
    p.on("close", (code) => resolveResult({ code, out }));
    p.stdin.end(input);
  });
describe.skipIf(!container)("intake real PostgreSQL transactions", () => {
  beforeAll(() => {
    execFileSync("docker", [
      "exec",
      container!,
      "createdb",
      "-U",
      "postgres",
      database,
    ]);
    sql(
      "create schema auth; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',created_at timestamptz default now());",
    );
    sql(readFileSync(resolve("schema.sql"), "utf8"));
    const migration = readFileSync(
      resolve("migrations/20261026_01_intake_requests.sql"),
      "utf8",
    );
    sql(migration);
    sql(migration);
  }, 60000);
  afterAll(() => {
    execFileSync("docker", [
      "exec",
      container!,
      "dropdb",
      "-U",
      "postgres",
      "--force",
      database,
    ]);
  });
  beforeEach(() => {
    sql(`truncate auth.users,public.organizations,public.db_jobs cascade;
      insert into auth.users(id,email) values ${[1, 2, 3, 4, 5, 6].map((n) => `(${q(n)},'person${n}@example.test')`).join(",")};
      insert into public.organizations(id,name,created_by) values(${q(10)},'Test legal',${q(1)}),(${q(11)},'Other',${q(6)});
      insert into public.org_members(org_id,user_id,role) values(${q(10)},${q(1)},'owner'),(${q(10)},${q(2)},'member'),(${q(10)},${q(3)},'member'),(${q(10)},${q(4)},'member'),(${q(10)},${q(5)},'admin'),(${q(11)},${q(6)},'owner');
      select public.intake_configure(${q(10)},${q(1)},${q(90)},0,true,array[${q(3)},${q(4)}]::uuid[]);`);
  });
  it("keeps Auth lifecycle trigger execution under a trusted owner", () => {
    expect(
      sql(`select count(*) from pg_proc p join pg_roles r on r.oid=p.proowner
      where p.oid='public.cleanup_removed_org_member_overrides()'::regprocedure
      and p.prosecdef and r.rolsuper
      and 'search_path=pg_catalog, public, pg_temp'=any(p.proconfig)`),
    ).toBe("1");
    for (const role of ["anon", "authenticated", "service_role"])
      expect(
        sql(`select has_schema_privilege('${role}','public','CREATE')`),
      ).toBe("f");
  });
  it("completes submission, assignment, clarification, reply and exact answer once", () => {
    expect(json(submit()).applied_version).toBe(1);
    sql(cmd("assign", 3, 101, 1, `,${q(3)}`));
    sql(cmd("ask", 3, 102, 2, ",'Which supplier?'"));
    sql(cmd("reply", 2, 103, 3, ",'Example Ltd'"));
    const answer = cmd(
      "publish",
      3,
      104,
      4,
      ",'Reviewed answer.\nExact second line.'",
    );
    expect(json(answer).applied_version).toBe(5);
    expect(json(answer).replayed).toBe(true);
    expect(sql("select state||':'||version from public.intake_requests")).toBe(
      "resolved:5",
    );
    expect(
      sql("select count(*) from public.intake_messages where kind='answer'"),
    ).toBe("1");
    expect(
      sql("select body from public.intake_messages where kind='answer'"),
    ).toBe("Reviewed answer.\nExact second line.");
    expect(() => sql(cmd("cancel", 2, 105, 5))).toThrow();
  });
  it("denies outsiders, unassigned reviewers, owner and admin content access", () => {
    sql(submit());
    for (const actor of [1, 5, 6])
      expect(() =>
        sql(`select public.intake_get_request(${q(10)},${q(actor)},${q(20)});`),
      ).toThrow();
    expect(
      json(`select public.intake_list_requests(${q(10)},${q(5)});`),
    ).toEqual([]);
    expect(() =>
      sql(`select public.intake_list_requests(${q(10)},${q(5)},'queue');`),
    ).toThrow();
    sql(cmd("assign", 3, 101, 1, `,${q(3)}`));
    expect(() => sql(cmd("publish", 4, 102, 2, ",'No'"))).toThrow();
    expect(() => sql(cmd("assign", 3, 103, 2, `,${q(6)}`))).toThrow();
    expect(() =>
      sql(
        `select public.intake_configure(${q(10)},${q(5)},${q(110)},1,true,array[${q(5)}]::uuid[]);`,
      ),
    ).toThrow();
  });
  it("rejects changed commands and stale revisions without extra history", () => {
    sql(submit());
    expect(json(submit()).replayed).toBe(true);
    expect(() => sql(submit().replace("Please review", "Different"))).toThrow();
    sql(cmd("assign", 3, 101, 1, `,${q(3)}`));
    expect(() => sql(cmd("assign", 4, 102, 1, `,${q(4)}`))).toThrow();
    expect(
      sql(
        "select count(*) from public.intake_events where request_id is not null",
      ),
    ).toBe("2");
  });
  it("rolls back state and messages when history insertion fails", () => {
    sql(submit());
    sql(cmd("assign", 3, 101, 1, `,${q(3)}`));
    sql(
      "alter table public.intake_events add constraint test_reject_publish check(kind <> 'publish');",
    );
    try {
      expect(() =>
        sql(cmd("publish", 3, 102, 2, ",'Never committed'")),
      ).toThrow();
      expect(
        sql("select state||':'||version from public.intake_requests"),
      ).toBe("in_review:2");
      expect(sql("select count(*) from public.intake_messages")).toBe("0");
    } finally {
      sql(
        "alter table public.intake_events drop constraint test_reject_publish",
      );
    }
  });
  it("rolls back publication, history and state when receipt insertion fails", () => {
    sql(submit());
    sql(cmd("assign", 3, 101, 1, `,${q(3)}`));
    sql(
      "alter table public.intake_commands add constraint test_reject_publish_receipt check(action <> 'publish');",
    );
    try {
      expect(() =>
        sql(cmd("publish", 3, 102, 2, ",'Never committed'")),
      ).toThrow();
      expect(
        sql("select state||':'||version from public.intake_requests"),
      ).toBe("in_review:2");
      expect(sql("select count(*) from public.intake_messages")).toBe("0");
      expect(
        sql("select count(*) from public.intake_events where kind='publish'"),
      ).toBe("0");
      expect(
        sql(
          "select count(*) from public.intake_commands where action='publish'",
        ),
      ).toBe("0");
    } finally {
      sql(
        "alter table public.intake_commands drop constraint test_reject_publish_receipt",
      );
    }
    expect(
      json(cmd("publish", 3, 102, 2, ",'Never committed'")).applied_version,
    ).toBe(3);
  });
  it("unassigns departing reviewers and pauses after the last reviewer leaves", () => {
    sql(submit());
    sql(cmd("assign", 3, 101, 1, `,${q(3)}`));
    sql(`select public.remove_org_member(${q(10)},${q(3)},${q(1)});`);
    expect(sql("select state||':'||version from public.intake_requests")).toBe(
      "submitted:3",
    );
    expect(() => sql(cmd("assign", 3, 101, 1, `,${q(3)}`))).toThrow();
    sql(`select public.remove_org_member(${q(10)},${q(4)},${q(1)});`);
    expect(sql("select enabled from public.intake_settings")).toBe("f");
    expect(
      json(`select public.intake_get_request(${q(10)},${q(2)},${q(20)});`)
        .subject,
    ).toBe("Supplier NDA");
    expect(() => sql(cmd("cancel", 2, 110, 3))).toThrow();
    sql(
      `insert into public.org_members(org_id,user_id) values(${q(10)},${q(3)});`,
    );
    expect(sql(`select public.intake_is_reviewer(${q(10)},${q(3)})`)).toBe("f");
  });
  it("retains business records on requester departure and erases identity on account deletion", () => {
    sql(submit());
    sql(`select public.remove_org_member(${q(10)},${q(2)},${q(1)});`);
    expect(() =>
      sql(`select public.intake_get_request(${q(10)},${q(2)},${q(20)});`),
    ).toThrow();
    expect(
      json(`select public.intake_get_request(${q(10)},${q(3)},${q(20)});`)
        .description,
    ).toBe("Please review");
    sql(`delete from auth.users where id=${q(2)};`);
    expect(sql("select requester_id is null from public.intake_requests")).toBe(
      "t",
    );
    expect(
      sql(`select count(*) from public.intake_commands where actor_id=${q(2)}`),
    ).toBe("0");
  });
  it("denies browser roles both table and function access", () => {
    for (const role of ["anon", "authenticated"]) {
      expect(() =>
        sql(`set role ${role}; select * from public.intake_requests;`),
      ).toThrow();
      expect(() =>
        sql(`set role ${role}; select * from public.intake_purged_commands;`),
      ).toThrow();
      expect(() => sql(`set role ${role}; ${submit()}`)).toThrow();
    }
  });
  it("hides soft-deleted organizations, restores and cascades hard deletion", () => {
    sql(submit());
    sql(`select public.soft_delete_organization(${q(10)},${q(1)})`);
    expect(() =>
      sql(`select public.intake_get_request(${q(10)},${q(2)},${q(20)})`),
    ).toThrow();
    sql(`select public.restore_organization(${q(10)},${q(1)})`);
    expect(
      json(`select public.intake_get_request(${q(10)},${q(2)},${q(20)})`).id,
    ).toBe(uid(20));
    sql(`delete from public.organizations where id=${q(10)}`);
    for (const table of [
      "settings",
      "reviewers",
      "requests",
      "messages",
      "events",
      "commands",
      "purged_commands",
    ])
      expect(sql(`select count(*) from public.intake_${table}`)).toBe("0");
  });
  it("serializes simultaneous submissions and conflicting assignments", async () => {
    const created = await Promise.all([parallel(submit()), parallel(submit())]);
    expect(created.map((x) => x.code)).toEqual([0, 0]);
    expect(sql("select count(*) from public.intake_requests")).toBe("1");
    const assigned = await Promise.all([
      parallel(cmd("assign", 3, 101, 1, `,${q(3)}`)),
      parallel(cmd("assign", 4, 102, 1, `,${q(4)}`)),
    ]);
    expect(assigned.filter((x) => x.code === 0)).toHaveLength(1);
    expect(
      sql("select count(*) from public.intake_events where kind='assign'"),
    ).toBe("1");
  });
  async function waitUntilLocked(marker: number) {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      if (
        sql(
          `select count(*) from pg_locks where locktype='advisory' and objid=${marker} and granted`,
        ) === "1"
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Concurrent transaction never reached the lock barrier");
  }
  it("blocks publication when concurrent revocation commits first", async () => {
    sql(submit());
    sql(cmd("assign", 3, 101, 1, `,${q(3)}`));
    const marker = 700000 + process.pid;
    const revocation = parallel(
      `begin; select public.remove_org_member(${q(10)},${q(3)},${q(1)}); select pg_advisory_xact_lock(${marker}); select pg_sleep(1); commit;`,
    );
    await waitUntilLocked(marker);
    const published = await parallel(
      cmd("publish", 3, 102, 2, ",'Must not publish'"),
    );
    expect((await revocation).code).toBe(0);
    expect(published.code).not.toBe(0);
    expect(sql("select count(*) from public.intake_messages")).toBe("0");
  });
  it("retains exactly one historical answer when publication commits before revocation", async () => {
    sql(submit());
    sql(cmd("assign", 3, 101, 1, `,${q(3)}`));
    const marker = 800000 + process.pid;
    const published = parallel(
      `begin; ${cmd("publish", 3, 102, 2, ",'Committed answer'")} select pg_advisory_xact_lock(${marker}); select pg_sleep(1); commit;`,
    );
    await waitUntilLocked(marker);
    const revoked = await parallel(
      `select public.remove_org_member(${q(10)},${q(3)},${q(1)})`,
    );
    expect((await published).code).toBe(0);
    expect(revoked.code).toBe(0);
    expect(sql("select state||':'||version from public.intake_requests")).toBe(
      "resolved:3",
    );
    expect(
      sql(
        "select count(*) from public.intake_messages where body='Committed answer'",
      ),
    ).toBe("1");
    expect(() =>
      sql(cmd("publish", 3, 102, 2, ",'Committed answer'")),
    ).toThrow();
  });
  it("does not revive an export after purge and reuse of the request ID", () => {
    sql(submit());
    const incarnation = sql(
      "select incarnation_id from public.intake_requests",
    );
    const check = `select public.intake_validate_export(${q(2)},'[ {"id":"${uid(20)}","incarnation_id":"${incarnation}","export_revision":1} ]'::jsonb)`;
    expect(sql(check)).toBe("t");
    sql(`select public.intake_purge(${q(10)},${q(1)})`);
    expect(sql(check)).toBe("f");
    sql(submit(150));
    expect(sql(check)).toBe("f");
  });
  it.each(["requester", "assignee", "message", "event_actor", "event_assignee"])(
    "invalidates snapshots for erased %s identity without replacing the request", (source) => {
      sql(submit());
      const original = json("select to_jsonb(r) from public.intake_requests r");
      // History-only contributors need not still belong to the roster or organization.
      if (source === "assignee") sql(`update public.intake_requests set assignee_id=${q(5)}`);
      if (source === "message") sql(`insert into public.intake_messages(org_id,request_id,author_id,kind,body)
        values(${q(10)},${q(20)},${q(5)},'answer','Retained text')`);
      if (source.startsWith("event")) sql(`insert into public.intake_events(org_id,request_id,${source === "event_actor" ? "actor_id" : "assignee_id"},kind)
        values(${q(10)},${q(20)},${q(5)},'assign')`);
      const erased = source === "requester" ? 2 : 5;
      sql(`select public.remove_org_member(${q(10)},${q(erased)},${q(1)})`);
      const manifest = JSON.stringify([{ id: original.id, incarnation_id: original.incarnation_id, export_revision: 1 }]);
      sql(`delete from auth.users where id=${q(erased)}`);
      const current = json("select to_jsonb(r) from public.intake_requests r");
      expect(current.incarnation_id).toBe(original.incarnation_id);
      expect(current.export_revision).toBe(2);
      expect(current.version).toBe(2);
      expect(current.description).toBe(original.description);
      expect(sql(`select public.intake_validate_export(${q(2)},'${manifest}'::jsonb)`)).toBe("f");
      if (erased !== 2) {
        const refreshed = JSON.stringify([{ id: current.id, incarnation_id: current.incarnation_id, export_revision: 2 }]);
        expect(sql(`select public.intake_validate_export(${q(2)},'${refreshed}'::jsonb)`)).toBe("t");
        expect(JSON.stringify(json(`select public.intake_read_history(${q(10)},${q(2)},${q(20)},${source.startsWith("event")})`)))
          .not.toContain("person5@example.test");
      }
      // A retry after attribution is gone cannot invalidate the fresh artifact.
      sql(`select public.intake_erase_identity(${q(erased)})`);
      expect(sql("select export_revision from public.intake_requests")).toBe("2");
    },
  );
  it("rolls back attribution and export invalidation when Auth deletion aborts", () => {
    sql(submit());
    sql(`create function public.test_refuse_auth_delete() returns trigger language plpgsql as $$
      begin raise exception 'Synthetic deletion failure'; end $$;
      create trigger z_test_refuse_auth_delete before delete on auth.users
      for each row execute function public.test_refuse_auth_delete();`);
    try {
      expect(() => sql(`delete from auth.users where id=${q(2)}`)).toThrow(/Synthetic deletion failure/);
      expect(json("select jsonb_build_object('requester_id',requester_id,'export_revision',export_revision,'version',version) from public.intake_requests"))
        .toEqual({ requester_id: uid(2), export_revision: 1, version: 1 });
      expect(sql(`select count(*) from public.intake_commands where actor_id=${q(2)}`)).toBe("1");
      expect(sql(`select count(*) from auth.users where id=${q(2)}`)).toBe("1");
    } finally {
      sql("drop trigger z_test_refuse_auth_delete on auth.users; drop function public.test_refuse_auth_delete()");
    }
  });
  it("purges an unconfigured organization without creating a settings row", () => {
    sql(`select public.intake_purge(${q(11)},${q(6)})`);
    expect(
      sql(`select count(*) from public.intake_settings where org_id=${q(11)}`),
    ).toBe("0");
  });
  it("refuses old submissions after purge but permits fresh commands without retaining content", () => {
    sql(submit());
    sql(cmd("assign", 3, 101, 1, `,${q(3)}`));
    sql(`select public.intake_purge(${q(10)},${q(1)})`);
    const tombstones = json(
      "select json_agg(t order by command_id) from public.intake_purged_commands t",
    );
    expect(tombstones).toEqual([
      { org_id: uid(10), actor_id: uid(2), command_id: uid(100) },
      { org_id: uid(10), actor_id: uid(3), command_id: uid(101) },
    ]);
    expect(
      sql(
        "select count(*) from public.intake_commands where request_id is not null",
      ),
    ).toBe("0");
    expect(sql("select count(*) from public.intake_messages")).toBe("0");
    expect(
      sql(
        "select count(*) from public.intake_events where request_id is not null",
      ),
    ).toBe("0");
    expect(() => sql(submit())).toThrow(/purged request data/);
    expect(sql("select count(*) from public.intake_requests")).toBe("0");
    sql(`select public.remove_org_member(${q(10)},${q(2)},${q(1)});`);
    expect(() => sql(submit())).toThrow(/Intake not found/);
    sql(
      `insert into public.org_members(org_id,user_id) values(${q(10)},${q(2)});`,
    );
    expect(() => sql(submit())).toThrow(/purged request data/);
    expect(json(submit(150)).replayed).toBe(false);
    // Another actor's use of the same UUID does not inherit this tombstone.
    expect(
      json(
        `select public.intake_submit_request(${q(10)},${q(4)},${q(100)},${q(21)},'general','Fresh','New work');`,
      ).replayed,
    ).toBe(false);
  });
  it("erases tombstones with account identity and organization lifecycle", () => {
    sql(submit());
    sql(cmd("assign", 3, 101, 1, `,${q(3)}`));
    sql(cmd("ask", 3, 102, 2, ",'Question?'"));
    sql(cmd("reply", 2, 103, 3, ",'Reply'"));
    sql(cmd("assign", 4, 104, 4, `,${q(4)}`));
    sql(`select public.intake_purge(${q(10)},${q(1)})`);
    expect(sql("select count(*) from public.intake_purged_commands")).toBe("5");
    sql(`select public.intake_erase_identity(${q(2)})`);
    expect(
      sql(
        `select count(*) from public.intake_purged_commands where actor_id=${q(2)}`,
      ),
    ).toBe("0");
    sql(`delete from auth.users where id=${q(3)}`);
    expect(
      sql(
        `select count(*) from public.intake_purged_commands where actor_id=${q(3)}`,
      ),
    ).toBe("0");
    expect(sql("select count(*) from public.intake_purged_commands")).toBe("1");
    sql(`delete from public.organizations where id=${q(10)}`);
    expect(sql("select count(*) from public.intake_purged_commands")).toBe("0");
  });
  it("purges request data atomically while preserving configuration", () => {
    sql(submit());
    expect(() => sql(`select public.intake_purge(${q(10)},${q(5)})`)).toThrow();
    sql(`select public.intake_purge(${q(10)},${q(1)})`);
    expect(sql("select count(*) from public.intake_requests")).toBe("0");
    expect(sql("select count(*) from public.intake_reviewers")).toBe("2");
    expect(
      sql(
        "select count(*) from public.intake_commands where request_id is not null",
      ),
    ).toBe("0");
  });
});

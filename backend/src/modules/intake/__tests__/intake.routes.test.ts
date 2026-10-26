import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), mfa: vi.fn() }));
vi.mock("../../../lib/supabase", () => ({ createServerSupabase: () => ({ rpc: mocks.rpc }) }));
vi.mock("../../../middleware/auth", () => ({
  requireAuth: (_req: express.Request, res: express.Response, next: express.NextFunction) => { res.locals.userId = "signed-in-user"; next(); },
  requireMfaIfEnrolled: (_req: express.Request, _res: express.Response, next: express.NextFunction) => { mocks.mfa(); next(); },
}));
import { intakeRouter } from "../intake.routes";
const app = express(); app.use(express.json()); app.use("/intake", intakeRouter);
const org = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000002";
const command_id = "00000000-0000-4000-8000-000000000003";
const path = `/intake/${org}`;
beforeEach(() => { vi.clearAllMocks(); mocks.rpc.mockResolvedValue({ data: { request_id: id, applied_version: 1, replayed: false }, error: null }); });
describe("intake route contracts", () => {
  it("takes identity from authentication and rejects client-supplied actor fields", async () => {
    const body = { id, command_id, category: "general", subject: "Subject", description: "Exact  text.\n" };
    expect((await request(app).post(path+"/requests").send({...body,p_actor:"other"})).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect((await request(app).post(path+"/requests").send(body)).status).toBe(201);
    expect(mocks.rpc).toHaveBeenCalledWith("intake_submit_request", expect.objectContaining({p_org:org,p_actor:"signed-in-user",p_request:id,p_command:command_id,p_description:body.description,p_date:null,p_timezone:null}));
    mocks.rpc.mockResolvedValueOnce({data:{request_id:id,applied_version:1,replayed:true},error:null});
    expect((await request(app).post(path+"/requests").send(body)).status).toBe(200);
  });
  it("validates bounded reads and binds every read to the authenticated scope", async () => {
    for(const suffix of ["/configuration","/reviewers","/requests","/requests?view=queue&state=in_review&assignee="+id+"&search=text&offset=50&limit=100",`/requests/${id}`,`/requests/${id}/messages`,`/requests/${id}/events?offset=100&limit=100`]) {
      expect((await request(app).get(path+suffix)).status).toBe(200);
      expect(mocks.rpc.mock.calls.at(-1)?.[1]).toMatchObject({p_org:org,p_actor:"signed-in-user"});
    }
    for(const suffix of ["/requests?limit=101","/requests?offset=-1","/requests?view=other",`/requests/${id}/messages?limit=101`,`/requests/${id}/events?offset=-1`,"/requests/not-a-uuid"]) expect((await request(app).get(path+suffix)).status).toBe(400);
    expect((await request(app).get("/intake/invalid/configuration")).status).toBe(400);
  });
  it("protects configuration with MFA and validates an explicit revision and roster", async () => {
    const body={command_id,expected_revision:0,enabled:true,reviewer_ids:[id]};
    expect((await request(app).put(path+"/configuration").send(body)).status).toBe(200);
    expect(mocks.mfa).toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith("intake_configure",{p_actor:"signed-in-user",p_org:org,p_command:command_id,p_revision:0,p_enabled:true,p_reviewers:[id]});
    expect((await request(app).put(path+"/configuration").send({...body,expected_revision:-1})).status).toBe(400);
  });
  it.each(["assignment","questions","replies","answer","cancel"])("validates and forwards a versioned %s command without accepting actor IDs",async action=>{
    const body={command_id,expected_version:2,...(action==="assignment"?{assignee_id:id}:action==="cancel"?{}:{body:"Exact reviewed text.\n"})};
    expect((await request(app).post(`${path}/requests/${id}/${action}`).send(body)).status).toBe(200);
    expect(mocks.rpc.mock.calls.at(-1)?.[1]).toMatchObject({p_org:org,p_actor:"signed-in-user",p_request:id,p_command:command_id,p_version:2});
    expect((await request(app).post(`${path}/requests/${id}/${action}`).send({...body,actor_id:id})).status).toBe(400);
    mocks.rpc.mockResolvedValueOnce({data:null,error:{code:"P0002"}});
    const hidden=await request(app).post(`${path}/requests/${id}/${action}`).send(body);
    expect(hidden.status).toBe(404);expect(hidden.body).not.toHaveProperty("request_id");
  });
  it("returns scoped failures from reads, configuration and creation", async () => {
    mocks.rpc.mockResolvedValue({data:null,error:{code:"42501"}});
    for(const suffix of ["/configuration","/reviewers","/requests",`/requests/${id}`,`/requests/${id}/messages`]) expect((await request(app).get(path+suffix)).status).toBe(403);
    expect((await request(app).post(path+"/requests").send({id,command_id,category:"general",subject:"Subject",description:"Text"})).status).toBe(403);
    expect((await request(app).put(path+"/configuration").send({command_id,expected_revision:0,enabled:false,reviewer_ids:[]})).status).toBe(403);
  });
});

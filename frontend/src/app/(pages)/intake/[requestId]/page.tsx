import { IntakeDetail } from "@/app/components/intake/IntakeDetail";
/** Resolve the request route and require an organization before loading its detail. */
export default async function Page({params,searchParams}:{params:Promise<{requestId:string}>;searchParams:Promise<{org?:string}>}) {
  const {requestId}=await params; const {org}=await searchParams;
  if(!org)return <p className="p-6">Open this request from your team workspace.</p>;
  return <IntakeDetail orgId={org} requestId={requestId}/>;
}

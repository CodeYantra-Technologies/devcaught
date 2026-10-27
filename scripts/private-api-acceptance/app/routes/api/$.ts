import {createFileRoute} from '@tanstack/react-router';
async function handle({request}:{request:Request}) {
  try {
    const {handleAcceptanceRequest}=await import('../../entry.server.ts');
    return await handleAcceptanceRequest(request);
  }catch{return Response.json({error:'Acceptance unavailable'},{status:503});}
}
export const Route=createFileRoute('/api/$')({server:{handlers:{GET:handle,POST:handle,DELETE:handle}}});

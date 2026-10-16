import { NextRequest } from 'next/server';
export const dynamic='force-dynamic';
async function proxy(request:NextRequest,context:{params:Promise<{path:string[]}>}) {
  const origin=request.headers.get('origin');
  if(origin && new URL(origin).host!==request.headers.get('host')) return Response.json({detail:'origin_not_allowed'},{status:403});
  const {path}=await context.params;
  if(path.some(x=>x==='..'||x.includes('/')||x.includes('\\')))return Response.json({detail:'invalid_path'},{status:400});
  try {
    const upstream=await fetch(`${process.env.API_URL||'http://api:8000'}/api/${path.map(encodeURIComponent).join('/')}?${request.nextUrl.searchParams}`,{
      method:request.method,headers:{'Content-Type':'application/json',...(request.headers.get('last-event-id')?{'Last-Event-ID':request.headers.get('last-event-id')!}:{})},
      body:request.method==='POST'?await request.text():undefined,cache:'no-store',redirect:'error',signal:request.signal
    });
    return new Response(upstream.body,{status:upstream.status,headers:{'Content-Type':upstream.headers.get('content-type')||'application/json','Cache-Control':'no-store','X-Accel-Buffering':'no'}});
  } catch {return Response.json({detail:'api_unavailable'},{status:502});}
}
export const GET=proxy;
export const POST=proxy;

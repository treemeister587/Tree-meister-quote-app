const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'https://tree-meister-quote-app-final.onrender.com';
const JOBBER_CLIENT_ID = process.env.JOBBER_CLIENT_ID || '';
const JOBBER_CLIENT_SECRET = process.env.JOBBER_CLIENT_SECRET || '';
const JOBBER_REDIRECT_URI = process.env.JOBBER_REDIRECT_URI || '';
const JOBBER_GRAPHQL_VERSION = process.env.JOBBER_GRAPHQL_VERSION || '2025-04-16';

app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));
app.use(express.json({ limit: '1mb' }));

let tokens = null;
const pendingAuth = new Map();

function base64url(buf){ return Buffer.from(buf).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_'); }
function randomString(bytes=32){ return base64url(crypto.randomBytes(bytes)); }

async function refreshAccessToken(){
  if(!tokens?.refresh_token) throw new Error('Jobber is not connected.');
  const body = new URLSearchParams({
    client_id: JOBBER_CLIENT_ID,
    client_secret: JOBBER_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token
  });
  const r = await fetch('https://api.getjobber.com/api/oauth/token', {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body
  });
  const data = await r.json();
  if(!r.ok) throw new Error(data.error_description || data.error || 'Unable to refresh Jobber access.');
  tokens = {...tokens, ...data, obtained_at: Date.now()};
  return tokens.access_token;
}

async function accessToken(){
  if(!tokens?.access_token) throw new Error('Jobber is not connected.');
  const expiresIn = Number(tokens.expires_in || 3600) * 1000;
  if(Date.now() - Number(tokens.obtained_at || 0) > expiresIn - 60000) return refreshAccessToken();
  return tokens.access_token;
}

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let graphqlQueue=Promise.resolve();
let lastCall=0;
const responseCache=new Map();
async function jobberGraphQL(query,variables={}){
  async function perform(){
    for(let attempt=0;attempt<5;attempt++){
      await sleep(Math.max(0,200-(Date.now()-lastCall)));
      lastCall=Date.now();
      const token=await accessToken();
      const r=await fetch('https://api.getjobber.com/api/graphql',{
        method:'POST',headers:{
          Authorization:`Bearer ${token}`,
          'X-JOBBER-GRAPHQL-VERSION':JOBBER_GRAPHQL_VERSION,
          'Content-Type':'application/json'
        },body:JSON.stringify({query,variables})
      });
      const data=await r.json();
      const errors=(data.errors||[]).map(e=>e.message).join('; ');
      const throttled=r.status===429 || /throttl|rate.?limit|too many requests/i.test(errors);
      if(throttled && attempt<4){
        const retry=Number(r.headers.get('retry-after'));
        await sleep(Number.isFinite(retry)&&retry>0?Math.min(retry*1000,30000):Math.min(1500*2**attempt,12000));
        continue;
      }
      if(!r.ok || data.errors)throw new Error(errors||(throttled?'Jobber is temporarily throttling requests. Please retry shortly.':'Jobber API request failed.'));
      return data.data;
    }
  }
  const task=graphqlQueue.then(perform);
  graphqlQueue=task.catch(()=>{});
  return task;
}
// Cache read-only endpoints briefly and deduplicate simultaneous refreshes.
function cachedResponse(key,ttl,load){
  const item=responseCache.get(key);
  if(item && (item.expiry>Date.now() || item.pending)) return item.pending||Promise.resolve(item.value);
  const pending=Promise.resolve().then(load).then(value=>{
    responseCache.set(key,{value,expiry:Date.now()+ttl});
    return value;
  }).catch(error=>{responseCache.delete(key);throw error;});
  responseCache.set(key,{pending,expiry:0});
  return pending;
}

app.get('/health', (req,res)=>res.json({ok:true}));
app.get('/api/jobber/status', (req,res)=>res.json({connected:!!tokens?.access_token}));

app.get('/api/jobber/connect', (req,res)=>{
  if(!JOBBER_CLIENT_ID || !JOBBER_CLIENT_SECRET || !JOBBER_REDIRECT_URI){
    return res.status(503).json({error:'Jobber credentials are not configured on the server yet.'});
  }
  const state = randomString(24);
  pendingAuth.set(state, Date.now());
  const u = new URL('https://api.getjobber.com/api/oauth/authorize');
  u.searchParams.set('client_id', JOBBER_CLIENT_ID);
  u.searchParams.set('redirect_uri', JOBBER_REDIRECT_URI);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', state);
  res.json({url:u.toString()});
});

app.get('/api/jobber/callback', async (req,res)=>{
  try{
    const {code,state} = req.query;
    if(!code || !state || !pendingAuth.has(state)) return res.status(400).send('Invalid Jobber authorization response.');
    pendingAuth.delete(state);
    const body = new URLSearchParams({
      client_id: JOBBER_CLIENT_ID,
      client_secret: JOBBER_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: JOBBER_REDIRECT_URI
    });
    const r = await fetch('https://api.getjobber.com/api/oauth/token', {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body
    });
    const data = await r.json();
    if(!r.ok) throw new Error(data.error_description || data.error || 'Authorization failed.');
    tokens = {...data, obtained_at:Date.now()};
    res.redirect(FRONTEND_ORIGIN + '?jobber=connected');
  }catch(e){ res.status(500).send('Jobber connection failed: '+e.message); }
});

const readCacheRoutes=[
  [/^\\/api\\/jobber\\/recent-clients$/,90000],
  [/^\\/api\\/jobber\\/requests\\/recent$/,90000],
  [/^\\/api\\/jobber\\/clients\\/[^/]+\\/properties$/,120000],
  [/^\\/api\\/jobber\\/clients\\/[^/]+\\/requests$/,90000],
  [/^\\/api\\/jobber\\/clients$/,45000]
];
app.use((req,res,next)=>{
  if(req.method!=='GET')return next();
  const rule=readCacheRoutes.find(([pattern])=>pattern.test(req.path));
  if(!rule)return next();
  const key=req.originalUrl;
  const hit=responseCache.get(key);
  if(hit?.expiry>Date.now())return res.json(hit.value);
  const originalJson=res.json.bind(res);
  res.json=(body)=>{
    if(res.statusCode>=200 && res.statusCode<300) responseCache.set(key,{value:body,expiry:Date.now()+rule[1]});
    return originalJson(body);
  };
  next();
});

app.get('/api/jobber/recent-clients', async (req,res)=>{
  try{
    const clients=[];
    let after=null;
    for(let page=0;page<10;page++){
      const data=await jobberGraphQL(
        'query RecentClients($first:Int!,$after:String){ clients(first:$first,after:$after){ nodes{ id name createdAt } pageInfo{ hasNextPage endCursor } } }',
        {first:50,after}
      );
      const connection=data.clients;
      clients.push(...(connection?.nodes||[]));
      if(!connection?.pageInfo?.hasNextPage||!connection.pageInfo.endCursor)break;
      after=connection.pageInfo.endCursor;
    }
    clients.sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
    res.json({clients:clients.slice(0,25)});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/jobber/clients', async (req,res)=>{
  try{
    const q = String(req.query.q||'').trim();
    if(q.length < 2) return res.json({clients:[]});
    // Prefer Jobber's server-side search so older clients are not excluded by pagination.
    try{
      const data=await jobberGraphQL(
        'query SearchClients($q:String!){ clients(first:50,searchTerm:$q){ nodes{ id name } } }',
        {q}
      );
      return res.json({clients:data.clients?.nodes||[]});
    }catch(searchError){
      if(!/searchTerm|Unknown argument|not defined/i.test(searchError.message)) throw searchError;
      // Compatibility fallback for API versions without server-side search.
    }
    const matches = [];
    let after = null;
    // Jobber paginates clients. Look beyond the initial 50 records for a match.
    for(let page=0; page<12 && matches.length<25; page++){
      const data = await jobberGraphQL(
        `query Clients($first:Int!, $after:String){ clients(first:$first, after:$after){ nodes{ id name } pageInfo{ hasNextPage endCursor } } }`,
        {first:50, after}
      );
      const connection = data.clients;
      for(const client of connection?.nodes || []){
        if((client.name || '').toLowerCase().includes(q.toLowerCase())) matches.push(client);
        if(matches.length >= 25) break;
      }
      if(!connection?.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) break;
      after = connection.pageInfo.endCursor;
    }
    res.json({clients:matches});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/jobber/clients/:clientId/properties', async (req,res)=>{
  try {
    const clientId=String(req.params.clientId||'');
    const properties=[];
    let after=null;
    for(let page=0;page<20;page++){
      const data=await jobberGraphQL(
        `query Properties($first:Int!,$after:String){ properties(first:$first,after:$after){ nodes{ id client{ id } address{ street1 city } } pageInfo{ hasNextPage endCursor } } }`,
        {first:50,after}
      );
      const conn=data.properties;
      for(const p of conn?.nodes||[]){
        if(p.client?.id===clientId) properties.push({id:p.id,label:[p.address?.street1,p.address?.city].filter(Boolean).join(', ')||'Property'});
      }
      if(!conn?.pageInfo?.hasNextPage||!conn.pageInfo.endCursor)break;
      after=conn.pageInfo.endCursor;
    }
    res.json({properties});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/jobber/requests/recent', async (req,res)=>{
  try{
    // Fail closed: never present an unverified request as assessment completed.
    const schema=await jobberGraphQL('{ __type(name:"Request"){ fields{ name type{ kind name ofType{ kind name } } } } }');
    const fields=schema.__type?.fields||[];
    const candidate=['requestStatus','assessmentStatus','workflowStatus','state','currentStatus']
      .find(name=>fields.some(field=>field.name===name &&
        ['SCALAR','ENUM'].includes(field.type?.kind==='NON_NULL'?field.type?.ofType?.kind:field.type?.kind)));
    if(!candidate){
      return res.status(422).json({error:'Jobber does not expose an Assessment Completed status field through this API connection. The list is hidden rather than including unfinished requests.'});
    }
    const requests=[];
    let after=null;
    const query='query VerifiedRequests($first:Int!,$after:String){ requests(first:$first,after:$after){ nodes{ id title client{ id name } property{ id } '+candidate+' } pageInfo{ hasNextPage endCursor } } }';
    for(let page=0;page<10;page++){
      const data=await jobberGraphQL(query,{first:50,after});
      const conn=data.requests;
      for(const r of conn?.nodes||[]){
        const status=String(r[candidate]||'').replace(/[_-]/g,' ').trim().toLowerCase();
        if(r.client?.id && status==='assessment completed'){
          requests.push({id:r.id,title:r.title||'Assessment completed',clientId:r.client.id,clientName:r.client.name||'Unnamed client',propertyId:r.property?.id||''});
        }
      }
      if(!conn?.pageInfo?.hasNextPage||!conn.pageInfo.endCursor)break;
      after=conn.pageInfo.endCursor;
    }
    res.json({requests});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/jobber/clients/:clientId/requests', async (req,res)=>{
  try{
    const clientId=String(req.params.clientId||'');
    const matches=[];
    let after=null;
    for(let page=0;page<8;page++){
      const data=await jobberGraphQL(
        'query Requests($first:Int!,$after:String){ requests(first:$first,after:$after){ nodes{ id title client{ id } property{ id } } pageInfo{ hasNextPage endCursor } } }',
        {first:50,after}
      );
      const connection=data.requests;
      for(const r of connection?.nodes||[]){
        if(r.client?.id===clientId){
          matches.push({id:r.id,title:r.title||'Existing request',propertyId:r.property?.id||''});
        }
      }
      if(!connection?.pageInfo?.hasNextPage||!connection.pageInfo.endCursor)break;
      after=connection.pageInfo.endCursor;
    }
    res.json({requests:matches});
  }catch(e){res.status(500).json({error:e.message});}
});

async function attachInternalQuoteNote(quoteId, noteText){
  // Inspect the connected Jobber schema before writing: API note shapes vary by version.
  const schema=await jobberGraphQL('{ __schema { mutationType { fields { name args { name type { kind name ofType { kind name } } } } } } }');
  const mutation=(schema.__schema?.mutationType?.fields||[]).find(f=>f.name==='noteCreate');
  if(!mutation) throw new Error('Jobber noteCreate mutation is unavailable.');
  const arg=mutation.args?.find(a=>['attributes','input'].includes(a.name));
  const inputType=arg?.type?.name||arg?.type?.ofType?.name;
  if(!inputType) throw new Error('Jobber note creation input could not be identified.');
  const detail=await jobberGraphQL('{ __type(name:"'+inputType+'"){ inputFields { name type { kind name ofType { kind name } } } } }');
  const fields=(detail.__type?.inputFields||[]).map(x=>x.name);
  const contentKey=['message','content','text','body'].find(k=>fields.includes(k));
  const recordKey=['quoteId','linkedQuoteId'].find(k=>fields.includes(k));
  if(!contentKey || !recordKey) throw new Error('Jobber does not expose a verified quote-note attachment format.');
  const attributes={[contentKey]:noteText,[recordKey]:quoteId};
  const query='mutation AddQuoteNote($attrs:'+inputType+'!){ noteCreate('+arg.name+':$attrs){ userErrors{ message } } }';
  const data=await jobberGraphQL(query,{attrs:attributes});
  if(data.noteCreate?.userErrors?.length)throw new Error(data.noteCreate.userErrors.map(e=>e.message).join('; '));
}

app.post('/api/jobber/quotes', async (req,res)=>{
  try{
    const {clientId, propertyId, lineItems, title, requestId, internalNotes} = req.body || {};
    if(!clientId) return res.status(400).json({error:'Select a Jobber client first.'});
    if(!propertyId) return res.status(400).json({error:'Select a Jobber property first.'});
    if(!Array.isArray(lineItems) || !lineItems.length) return res.status(400).json({error:'Add at least one quote line item first.'});
    const input = {
      clientId,
      lineItems: lineItems.map(x=>({name:x.name||'Tree work', description:x.description||'', quantity:Number(x.quantity||1), unitPrice:Number(x.unitPrice||0), saveToProductsAndServices:false}))
    };
    input.propertyId = propertyId;
    const firstType = String(lineItems[0]?.name || '').trim().toLowerCase();
    const automaticTitle = ['removal','tree removal'].includes(firstType) ? 'Tree Removal'
      : ['trim','trimming','tree trimming'].includes(firstType) ? 'Tree Trimming'
      : ['stump','stump grinding'].includes(firstType) ? 'Stump Grinding'
      : ['cable','cabling','tree cabling'].includes(firstType) ? 'Cabling'
      : firstType === 'crane' ? 'Crane Service'
      : 'Tree Service Estimate';
    input.title = automaticTitle;
    if(requestId){
      const schema = await jobberGraphQL('{ __type(name: "QuoteCreateAttributes") { inputFields { name } } }');
      const fields = (schema.__type?.inputFields || []).map(f=>f.name);
      if(!fields.includes('requestId')) return res.status(409).json({error:'Jobber does not expose request association on quoteCreate in this API version. No duplicate quote was created.'});
      input.requestId = String(requestId);
    }
    const mutation = `mutation CreateQuote($attributes:QuoteCreateAttributes!){ quoteCreate(attributes:$attributes){ quote{ id quoteNumber } userErrors{ message path } } }`;
    const data = await jobberGraphQL(mutation, {attributes:input});
    const result = data.quoteCreate;
    if(result?.userErrors?.length) throw new Error(result.userErrors.map(e=>e.message).join('; '));
    let internalNoteWarning='';
    if(String(internalNotes||'').trim()){
      try{
        await attachInternalQuoteNote(result.quote.id,String(internalNotes).trim());
      }catch(err){
        internalNoteWarning='The draft quote was created, but crane notes were not attached. Use Copy crane notes to paste them into Jobber internal notes. ('+err.message+')';
      }
    }
    res.json({ok:true, quote:result.quote, message:'Draft quote created in Jobber.', internalNoteWarning});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.listen(PORT, ()=>console.log(`Jobber bridge listening on ${PORT}`));

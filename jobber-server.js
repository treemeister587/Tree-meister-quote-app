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

async function jobberGraphQL(query, variables={}){
  const token = await accessToken();
  const r = await fetch('https://api.getjobber.com/api/graphql', {
    method:'POST',
    headers:{
      'Authorization':`Bearer ${token}`,
      'X-JOBBER-GRAPHQL-VERSION':JOBBER_GRAPHQL_VERSION,
      'Content-Type':'application/json'
    },
    body:JSON.stringify({query, variables})
  });
  const data = await r.json();
  if(!r.ok || data.errors) throw new Error(data.errors?.map(e=>e.message).join('; ') || 'Jobber API request failed.');
  return data.data;
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

app.get('/api/jobber/clients', async (req,res)=>{
  try{
    const q = String(req.query.q||'').trim();
    if(q.length < 2) return res.json({clients:[]});
    const matches = [];
    let after = null;
    // Jobber paginates clients. Look beyond the initial 50 records for a match.
    for(let page=0; page<20 && matches.length<25; page++){
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

app.post('/api/jobber/quotes', async (req,res)=>{
  try{
    const {clientId, propertyId, lineItems, title} = req.body || {};
    if(!clientId) return res.status(400).json({error:'Select a Jobber client first.'});
    if(!propertyId) return res.status(400).json({error:'Select a Jobber property first.'});
    if(!Array.isArray(lineItems) || !lineItems.length) return res.status(400).json({error:'Add at least one quote line item first.'});
    const input = {
      clientId,
      lineItems: lineItems.map(x=>({name:x.name||'Tree work', description:x.description||'', quantity:Number(x.quantity||1), unitPrice:Number(x.unitPrice||0), saveToProductsAndServices:false}))
    };
    input.propertyId = propertyId;
    const firstType = String(lineItems[0]?.name || '').trim().toLowerCase();
    const automaticTitle = firstType === 'removal' ? 'Tree Removal'
      : firstType === 'trim' || firstType === 'trimming' ? 'Tree Trimming'
      : firstType === 'stump' ? 'Stump Grinding'
      : firstType === 'cable' || firstType === 'cabling' ? 'Tree Cabling'
      : firstType === 'crane' ? 'Crane Service'
      : 'Tree Service Estimate';
    input.title = automaticTitle;
    const mutation = `mutation CreateQuote($attributes:QuoteCreateAttributes!){ quoteCreate(attributes:$attributes){ quote{ id quoteNumber } userErrors{ message path } } }`;
    const data = await jobberGraphQL(mutation, {attributes:input});
    const result = data.quoteCreate;
    if(result?.userErrors?.length) throw new Error(result.userErrors.map(e=>e.message).join('; '));
    res.json({ok:true, quote:result.quote, message:'Draft quote created in Jobber.'});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.listen(PORT, ()=>console.log(`Jobber bridge listening on ${PORT}`));

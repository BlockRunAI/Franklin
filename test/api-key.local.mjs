import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, unwatchFile } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

process.env.FRANKLIN_NO_AUDIT='1';
process.env.FRANKLIN_NO_PERSIST='1';
process.env.FRANKLIN_NO_PREFETCH='1';
process.env.FRANKLIN_NO_EVAL='1';
process.env.FRANKLIN_NO_ANALYZER='1';
const key='brk_live_unit_test';
const originalFetch=globalThis.fetch;
const savedKey=process.env.BLOCKRUN_API_KEY;
const savedBase=process.env.BLOCKRUN_API_BASE_URL;
beforeEach(()=>{process.env.BLOCKRUN_API_KEY=key;delete process.env.BLOCKRUN_API_BASE_URL;});
afterEach(()=>{globalThis.fetch=originalFetch;if(savedKey===undefined)delete process.env.BLOCKRUN_API_KEY;else process.env.BLOCKRUN_API_KEY=savedKey;if(savedBase===undefined)delete process.env.BLOCKRUN_API_BASE_URL;else process.env.BLOCKRUN_API_BASE_URL=savedBase;});
const ctx=()=>({workingDir:process.cwd(),abortSignal:new AbortController().signal});
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});

test('shared account auth rewrites gateways, strips wallet headers and refuses other origins',async()=>{
 const {gatewayFetch}=await import('../dist/payments/account.js');
 const seen=[];globalThis.fetch=async(u,o)=>{seen.push([String(u),o]);return json({ok:true});};
 await gatewayFetch('https://sol.blockrun.ai/api/v1/search?q=x',{headers:{'PAYMENT-SIGNATURE':'remove','x-api-key':'placeholder'}});
 assert.equal(seen[0][0],'https://api.blockrun.ai/v1/search?q=x');
 assert.equal(seen[0][1].headers.get('authorization'),`Bearer ${key}`);
 assert.equal(seen[0][1].headers.get('payment-signature'),null);
 assert.equal(seen[0][1].redirect,'error');
 await assert.rejects(()=>gatewayFetch('https://evil.example/job'),/origin/);
 assert.equal(seen.length,1);
});

test('native ModelClient returns account 402 once without signing',async()=>{
 const {ModelClient}=await import('../dist/agent/llm.js');
 const {classifyAgentError}=await import('../dist/agent/error-classifier.js');
 let count=0;globalThis.fetch=async()=>{count++;return json({error:{message:key}},402);};
 const client=new ModelClient({apiUrl:'https://sol.blockrun.ai/api',chain:'solana'});
 const chunks=[];for await(const chunk of client.streamCompletion({model:'anthropic/claude-sonnet-4.6',messages:[{role:'user',content:'hi'}],max_tokens:5,stream:false}))chunks.push(chunk);
 assert.equal(count,1);
 const error=chunks.find(c=>c.kind==='error');assert.equal(error.payload.status,402);assert.match(error.payload.message,/account credits/);assert.equal(classifyAgentError(error.payload.message).isTransient,false);assert.equal(client.getLastPaidUsd(),0);
 assert.ok(!JSON.stringify(chunks).includes(key));
});

test('ModelClient streams account messages with tool events intact',async()=>{
 const {ModelClient}=await import('../dist/agent/llm.js');
 let seen;
 globalThis.fetch=async(u,o)=>{seen=[String(u),o];return new Response('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',{headers:{'content-type':'text/event-stream'}});};
 const client=new ModelClient({apiUrl:'https://blockrun.ai/api',chain:'base'});
 const chunks=[];for await(const chunk of client.streamCompletion({model:'anthropic/claude-sonnet-4.6',messages:[{role:'user',content:'hi'}],max_tokens:5}))chunks.push(chunk);
 assert.equal(seen[0],'https://api.blockrun.ai/v1/messages');assert.equal(seen[1].headers.get('authorization'),`Bearer ${key}`);assert.ok(chunks.some(c=>c.kind==='content_block_delta'));
});

test('Exa and Wallet tools support account mode without a wallet',async()=>{
 const {exaAnswerCapability}=await import('../dist/tools/exa.js');
 const {walletCapability}=await import('../dist/tools/wallet.js');
 let count=0;globalThis.fetch=async(u,o)=>{count++;assert.equal(o.headers.get('authorization'),`Bearer ${key}`);return json({answer:'account answer',citations:[]});};
 const result=await exaAnswerCapability.execute({query:'hi'},ctx());assert.notEqual(result.isError,true);assert.match(result.output,/account answer/);
 const status=await walletCapability.execute({},ctx());assert.match(status.output,/Account API/);assert.equal(count,1);
});

test('shared POST preserves account quota errors and Retry-After',async()=>{
 const {postWithPayment}=await import('../dist/payments/post-with-payment.js');
 for(const status of [401,402,429]){
 let count=0;globalThis.fetch=async()=>{count++;return new Response(JSON.stringify({error:{message:'fail',code:'account_error'}}),{status,headers:{'retry-after':'30','payment-required':'never-sign'}});};
 const result=await postWithPayment('https://blockrun.ai/api/v1/phone/lookup',{},'test');assert.equal(result.status,status);assert.equal(result.ok,false);assert.equal(count,1);
 }
});

test('account async polling authenticates GET and stops at completion',async()=>{
 const {pollAccountJob}=await import('../dist/payments/account.js');
 let count=0;globalThis.fetch=async(u,o)=>{count++;assert.equal(String(u),'https://api.blockrun.ai/v1/jobs/1');assert.equal(o.headers.get('authorization'),`Bearer ${key}`);return json({status:'completed',data:[{url:'https://cdn.example/result'}]});};
 const result=await pollAccountJob(json({status:'queued',poll_url:'/api/v1/jobs/1'},202),undefined,1);assert.equal((await result.json()).status,'completed');assert.equal(count,1);
 await assert.rejects(()=>pollAccountJob(json({poll_url:'https://evil.example/job'},202),undefined,1),/origin/);assert.equal(count,1);
});

test('proxy returns account 402 without wallet initialization or model fallback',async()=>{
 const {createProxy}=await import('../dist/proxy/server.js');
 let count=0;globalThis.fetch=async()=>{count++;return json({error:{message:'quota'}},402);};
 const proxy=createProxy({port:0,apiUrl:'https://blockrun.ai/api',chain:'base',fallbackEnabled:true});
 proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
 try{const result=await originalFetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'anthropic/claude-sonnet-4.6',max_tokens:5,messages:[{role:'user',content:'hi'}]})});assert.equal(result.status,402);assert.match(await result.text(),/account credits/);assert.equal(count,1);}finally{proxy.closeAllConnections();await new Promise(r=>proxy.close(r));}
});

test('panel exposes account status, never the credential',async()=>{
 const {createPanelServer}=await import('../dist/panel/server.js');
 const server=createPanelServer(0);server.listen(0,'127.0.0.1');await once(server,'listening');
 try{const result=await originalFetch(`http://127.0.0.1:${server.address().port}/api/wallet`);const value=await result.json();assert.equal(value.authMode,'api-key');assert.equal(value.balance,null);assert.equal(value.address,'');assert.ok(!JSON.stringify(value).includes(key));}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

after(()=>unwatchFile(join(homedir(), ".blockrun", "franklin-stats.json")));

test('VideoGen accepts first 202 without payment headers, polls, and downloads without key forwarding',async()=>{
 const {videoGenCapability}=await import('../dist/tools/videogen.js');
 const dir=mkdtempSync(join(tmpdir(),'franklin-api-video-'));
 const calls=[];
 globalThis.fetch=async(u,o)=>{
  const url=String(u);calls.push(url);
  if(url.includes('/models'))return json({data:[]});
  if(url.endsWith('/videos/generations'))return json({id:'job-1',status:'queued',poll_url:'/api/v1/videos/generations/job-1'},202);
  if(url.endsWith('/job-1')){assert.equal(o.headers.get('authorization'),`Bearer ${key}`);return json({status:'completed',data:[{url:'https://cdn.example/video.mp4',duration_seconds:5}]});}
  assert.equal(url,'https://cdn.example/video.mp4');assert.equal(new Headers(o.headers).get('authorization'),null);return new Response(new Uint8Array([1,2,3]));
 };
 try{const result=await videoGenCapability.execute({prompt:'cat',output_path:'video.mp4',duration_seconds:5},{workingDir:dir,abortSignal:new AbortController().signal});assert.notEqual(result.isError,true,result.output);assert.ok(existsSync(join(dir,'video.mp4')));assert.equal(calls.filter(u=>u.endsWith('/videos/generations')).length,1);}finally{rmSync(dir,{recursive:true,force:true});}
});

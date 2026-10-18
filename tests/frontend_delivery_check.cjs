/* Executes the shipped UI functions with controlled real fetch promises and the real DOM.
 * This checks delivery races, not browser rendering or external network performance. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const root=path.resolve(__dirname,'..');
const req=createRequire(path.join(process.env.ONSTAGE_DOM_MODULES || path.join(root,'node_modules'),'.delivery-test.cjs'));
const {JSDOM}=req('jsdom');
const dom=new JSDOM(fs.readFileSync(path.join(root,'static/index.html'),'utf8'),{url:'http://localhost/',runScripts:'outside-only'});
const w=dom.window;
w.matchMedia=()=>({matches:false}); w.AbortController=AbortController; w.TextEncoder=TextEncoder;
w.setTimeout=()=>0; w.clearTimeout=()=>{};
const requests=[];
w.fetch=(url,options)=>new Promise((resolve,reject)=>requests.push({url,body:JSON.parse(options.body),resolve,reject}));
const source=fs.readFileSync(path.join(root,'static/app.js'),'utf8').replace('  boot();','  window.testUI = {state, submitMessage, postPending, insertMessage, reconcileMessage, renderMessages, loadPending, persistPending, loadDrafts, persistDrafts};');
w.eval(source);
const ui=w.testUI,s=ui.state,$=id=>w.document.getElementById(id);
Object.assign(s,{authenticated:true,scope:'identity-a',csrf:'csrf',initialSynced:true,catalog:JSON.parse(fs.readFileSync(path.join(root,'app/catalog.json'),'utf8')),room:{id:'room-a',status:'live',members:[],me:{member_id:'member-a',can_stage:true,can_backstage:true}}});
function receipt(body,id='server-1',seq=10){return {id,seq,member_id:'member-a',channel:body.channel,client_message_id:body.client_message_id,content_type:body.content_type||'text',text:body.text||'[贴纸] 测试',kind:'speech',author:'我',created_at:'2026-10-18T10:00:00Z'};}
function ack(request,message){request.resolve({ok:true,status:200,json:async()=>({message})});}
function reset(){s.pending.clear();s.posting.clear();s.messages.stage.clear();s.messages.backstage.clear();s.messageSignature='';s.cursors={stage:0,backstage:0};s.channel='stage';s.scope='identity-a';s.stickerDrafts.clear();$('message-input').value='';requests.length=0;}
(async()=>{
  reset(); $('message-input').value='同一句'; const sending=ui.submitMessage({preventDefault(){}}); const first=requests[0];
  assert.equal($('message-input').value,''); assert.equal($('message-feed').querySelectorAll('[data-pending-id]').length,1); assert($('message-feed').querySelector('.is-sending')); assert($('pending-message').hidden);
  assert.equal($('message-feed').querySelectorAll('.message-report').length,0); assert.equal($('message-feed').querySelectorAll('time').length,0);
  $('message-input').value='同一句';s.drafts.set('room-a:stage','同一句');
  const committed=receipt(first.body);ui.insertMessage(committed);ui.renderMessages();
  assert.equal(s.pending.size,0);assert.equal($('message-feed').querySelectorAll('.message').length,1);assert.equal($('message-feed').querySelectorAll('.message-delivery').length,0);
  first.reject(new TypeError('ACK lost after commit'));await sending;
  assert.equal(s.pending.size,0);assert.equal($('message-input').value,'同一句');assert.equal(s.drafts.get('room-a:stage'),'同一句');assert.equal(s.cursors.stage,0);assert.equal($('toasts').children.length,0);
  const secondSend=ui.submitMessage({preventDefault(){}}); const second=requests[1]; assert.notEqual(first.body.client_message_id,second.body.client_message_id);ack(second,receipt(second.body,'server-2',11));await secondSend;
  assert.equal(s.messages.stage.size,2);assert.equal(s.cursors.stage,0);

  reset();$('message-input').value='原文';const uncertain=ui.submitMessage({preventDefault(){}});const req1=requests[0];req1.reject(new TypeError('network'));await uncertain;
  assert.equal(s.pending.get('room-a').status,'uncertain');assert($('message-feed').querySelector('.message-retry'));assert(!$('message-feed').querySelector('.is-sending'));
  const pending=s.pending.get('room-a');ui.persistPending();s.drafts.set('room-a:stage','新草稿');ui.persistDrafts();s.pending.clear();s.drafts.clear();ui.loadPending();ui.loadDrafts();
  assert.equal(s.pending.get('room-a').client_message_id,pending.client_message_id);assert.equal(s.drafts.get('room-a:stage'),'新草稿');
  const retry=ui.postPending(s.pending.get('room-a'));assert.deepEqual(requests[1].body,req1.body);
  requests[1].resolve({ok:false,status:403,json:async()=>({detail:'membership changed'})});await retry;assert.equal(s.pending.get('room-a').status,'uncertain');
  const item=s.pending.get('room-a'); const correct=receipt(req1.body);
  for(const bad of [{...correct,member_id:'another'},{...correct,channel:'backstage'},{...correct,client_message_id:'different-id'}])assert.equal(ui.reconcileMessage(bad),false);
  assert.equal(ui.reconcileMessage(correct,'other-room'),false);assert.equal(ui.reconcileMessage(correct,'room-a','other-scope'),false);
  // Reconcile even if the server message was already inserted by an earlier path.
  s.messages.stage.set(correct.id,correct);ui.insertMessage(correct);assert.equal(s.pending.size,0);assert.equal(s.messages.stage.size,1);

  reset();const sticker=s.catalog.stickers[0];const p={scope:s.scope,member_id:'member-a',room_id:'room-a',channel:'backstage',content_type:'sticker',sticker_id:sticker.id,sticker,client_message_id:'sticker-client-id',status:'uncertain',text:'[贴纸] '+sticker.label};
  s.pending.set('room-a',p);$('message-input').value='保留文字';s.drafts.set('room-a:stage','保留文字');ui.renderMessages();assert.equal($('message-feed').querySelectorAll('[data-pending-id]').length,0);
  s.channel='backstage';const stickerPost=ui.postPending(p);assert.equal($('message-feed').querySelectorAll('[data-pending-id]').length,1);
  const m={...receipt(requests[0].body,'sticker-server'),content_type:'sticker',sticker_id:sticker.id,sticker};ui.insertMessage(m);requests[0].resolve({ok:false,status:401,json:async()=>({detail:'late unauthorized'})});await stickerPost;
  assert(s.authenticated);assert.equal(s.pending.size,0);assert.equal($('message-input').value,'保留文字');assert.equal(s.drafts.get('room-a:stage'),'保留文字');
  dom.window.close();console.log('PASS: optimistic DOM; sync before ACK; lost ACK; late 401/403; unchanged retry; refresh; exact identity/room/member/channel/id; same-content independent sends; sticker/text draft isolation; POST cursor protection');
})().catch(error=>{console.error(error);dom.window.close();process.exitCode=1;});

/** Real isolated D1 paging with tied timestamps; never touches a deployed DB. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(process.env.ONSTAGE_NODE_MODULES ? path.join(process.env.ONSTAGE_NODE_MODULES, 'package.json') : import.meta.url);
const { Miniflare } = require('miniflare');
const { build } = require('esbuild');
const bundled = await build({ entryPoints:[path.join(root,'edge/testing-worker.ts')],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022' });
const mf = new Miniflare({modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-05-15',host:'127.0.0.1',port:0,inspectorPort:0,d1Databases:{DB:'pagination-isolated'},bindings:{ONSTAGE_VERSION:'pagination-test'}});
try {
 const origin=(await mf.ready).origin, db=await mf.getD1Database('DB');
 for (const file of (await readdir(path.join(root,'drizzle'))).filter(f=>f.endsWith('.sql')).sort()) {
  const statements=(await readFile(path.join(root,'drizzle',file),'utf8')).split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean);
  await db.batch(statements.map(s=>db.prepare(s)));
 }
 const call=async(route,cookie='',method='GET',body=undefined)=>{
  const response=await fetch(origin+route,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
 };
 const host=await call('/api/session','','POST',{nickname:'房主'}), guest=await call('/api/session','','POST',{nickname:'观众'});
 assert.equal(host.status,200); assert.equal(guest.status,200);
 const sessions=(await db.prepare('SELECT id,nickname FROM sessions').all()).results;
 const hostId=sessions.find(s=>s.nickname==='房主').id, guestId=sessions.find(s=>s.nickname==='观众').id;
 const at='2026-10-18T00:00:00.000Z'; const seed=[];
 for(let i=0;i<1107;i++) {
  const id=i.toString(16).padStart(32,'0');
  seed.push(db.prepare("INSERT INTO rooms(id,title,scenario_id,status,host_session_id,created_at,updated_at) VALUES(?,'page','mygo_rehearsal',?,?,?,?)").bind(id,i%2?'ended':'preparing',hostId,at,at));
  seed.push(db.prepare("INSERT INTO room_members(id,room_id,session_id,alias,display_alias,joined_at) VALUES(?,?,?,'观众 1','观众 1',?)").bind('host'+id,id,hostId,at));
  if(i%3===0) seed.push(db.prepare("INSERT INTO room_members(id,room_id,session_id,alias,display_alias,joined_at) VALUES(?,?,?,'观众 2','观众 2',?)").bind('guest'+id,id,guestId,at));
 }
 for(let i=0;i<seed.length;i+=80) await db.batch(seed.slice(i,i+80));
 const banned=(3).toString(16).padStart(32,'0');
 await db.prepare('INSERT INTO room_bans(room_id,session_id,removed_by_member_id,created_at) VALUES(?,?,?,?)').bind(banned,guestId,'host'+banned,at).run();
 for(const filter of ['all','active','ended','mine']) {
  let cursor=null,seen=[];
  do {
   const response=await call('/api/rooms?limit=37&filter='+filter+(cursor?'&cursor='+encodeURIComponent(cursor):''),guest.cookie);
   assert.equal(response.status,200); assert.ok(response.body.rooms.length<=37);
   seen.push(...response.body.rooms.map(r=>parseInt(r.id,16)));
   assert.equal(response.body.has_more,Boolean(response.body.next_cursor)); cursor=response.body.next_cursor;
  }while(cursor);
  const expected=Array.from({length:1107},(_,i)=>i).filter(i=>i!==3&&(filter==='active'?i%2===0:filter==='ended'?i%2===1:filter==='mine'?i%3===0:true));
  assert.deepEqual(seen,expected);
 }
 const first=await call('/api/rooms',guest.cookie); assert.equal(first.body.rooms.length,50);
 const cursor=encodeURIComponent(first.body.next_cursor);
 for(const route of ['/api/rooms?limit=0','/api/rooms?limit=101','/api/rooms?cursor=bad','/api/rooms?filter=active&cursor='+cursor]) assert.equal((await call(route,guest.cookie)).status,422);
 assert.equal((await call('/api/rooms?cursor='+cursor,host.cookie)).status,422);
 const indexes=(await db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all()).results;
 assert.ok(indexes.some(i=>i.name==='rooms_created_page'));
 console.log(JSON.stringify({result:'passed',rooms:1107,filters:['all','active','ended','mine'],scope:'isolated Miniflare D1, tied timestamps, bans, cursor scope, limit validation'}));
} finally {await mf.dispose();}

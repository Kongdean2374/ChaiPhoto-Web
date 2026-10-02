import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import worker from '../src/index.js';

async function fixture() {
  const db = new DatabaseSync(':memory:');
  for (const path of ['0001_create_feedback.sql', '0002_feedback_v2.sql']) {
    db.exec(readFileSync(new URL('../migrations/' + path, import.meta.url), 'utf8'));
  }
  const objects = new Map();
  const env = {
    DB: {
      prepare(sql) {
        let args = [];
        return {
          sql,
          bind(...values) { assert.ok(values.length <= 100); args = values; return this; },
          async all() { return { results: db.prepare(sql).all(...args) }; },
          async first() { return db.prepare(sql).get(...args) ?? null; },
          async run() { return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; }
        };
      },
      async batch(statements) {
        db.exec('BEGIN');
        try { const result = []; for (const s of statements) result.push(await s.run()); db.exec('COMMIT'); return result; }
        catch (e) { db.exec('ROLLBACK'); throw e; }
      }
    },
    FEEDBACK_MEDIA: {
      async put(key, bytes, options) { objects.set(key, { bytes, options }); },
      async get(key) { const o = objects.get(key); return o && { body: o.bytes, httpMetadata: o.options?.httpMetadata, writeHttpMetadata(headers) { headers.set('Content-Type',o.options?.httpMetadata?.contentType || 'image/png'); } }; },
      async delete() { assert.fail('Existing R2 objects must be preserved'); }
    }
  };
  async function call(path, body, method = body === undefined ? 'GET' : 'POST', headers = {}) {
    const request = new Request('https://photo.chaihome.cc' + path, {
      method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    return worker.fetch(request, env, {});
  }
  const admin = (path, body, method = 'PATCH') => call('/dashboard/api/feedback/' + path, body, method, { 'Cf-Access-Authenticated-User-Email': 'admin@example.test' });
  await call('/api/feedback-lookup-v2?id=bad');
  const seed = (id, source, number) => {
    db.prepare(`INSERT INTO feedback (id,created_at,status,category,description,steps,source,is_public,app_version,build_number,ios_version,device_model) VALUES (?,?,'new','other','PRIVATE 原文😀','PRIVATE steps',?,1,'1.2.5','45','26','iPhone18,1')`).run(id, '2026-10-01', source === 'tf' ? 'testflight' : 'web');
    db.prepare('INSERT INTO feedback_tracking(feedback_id,report_number) VALUES (?,?)').run(id, source === 'tf' ? 1000 + number : number);
    db.exec('UPDATE feedback_counter SET next_number=(SELECT MAX(report_number)+1 FROM feedback_tracking)');
    db.prepare(`INSERT INTO feedback_v2_meta(feedback_id,source_key,source_number,original_description,original_steps,edited_description,edited_steps,updated_at) VALUES (?,?,?,'PRIVATE 原文😀','PRIVATE steps','公開😀\n內容','公開步驟','2026-10-01')`).run(id,source,number);
  };
  seed('beta','beta',1); seed('tf','tf',1);
  return { db, env, objects, call, admin, seed };
}

test('BETA / TF aliases, ambiguous numbers and invalid references', async () => {
  const { call } = await fixture();
  for (const [id, expected] of [['BETA-001','BETA-001'],['b / 1','BETA-001'],['TestFlight_1','TF-001'],['FT.001','TF-001']]) {
    const r = await call('/api/feedback-lookup-v2?id=' + encodeURIComponent(id));
    assert.equal(r.status,200); assert.equal((await r.json()).matches[0].report_id,expected);
  }
  const both = await (await call('/api/feedback-lookup-v2?id=1')).json();
  assert.equal(both.ambiguous,true); assert.equal(both.matches.length,2);
  for (const id of ['0','ABC-1','9007199254740992','BETA-1<script>']) assert.equal((await call('/api/feedback-lookup-v2?id=' + encodeURIComponent(id))).status,400);
});

test('publication edits never change originals; cleared copy never falls back', async () => {
  const { db, admin, call } = await fixture();
  const before = db.prepare("SELECT description,steps FROM feedback WHERE id='beta'").get();
  assert.equal((await admin('publication', { id:'beta',isPublic:true,publicTitle:'公開標題',publicDescription:'',publicSteps:'' })).status,200);
  assert.deepEqual(db.prepare("SELECT description,steps FROM feedback WHERE id='beta'").get(),before);
  assert.equal(db.prepare("SELECT original_description FROM feedback_v2_meta WHERE feedback_id='beta'").get().original_description,'PRIVATE 原文😀');
  for (const path of ['/api/public-feedback','/api/feedback-lookup-v2?id=BETA-1']) {
    const body = await (await call(path)).json();
    const row = (body.feedback || body.matches).find(x=>x.report_id==='BETA-001');
    assert.equal(row.description,''); assert.equal(row.steps,'');
    assert.ok(!JSON.stringify(body).includes('PRIVATE'));
  }
});

test('all visibility switches remove values from both public responses', async () => {
  const { admin, call } = await fixture();
  await admin('publication',{id:'beta',isPublic:true,publicTitle:'公開標題',publicDescription:'SECRET',publicSteps:'SECRET',...Object.fromEntries(['Description','Steps','Category','AppVersion','BuildNumber','IosVersion','DeviceModel','CreatedAt','Source'].map(k=>['show'+k,false]))});
  for (const path of ['/api/public-feedback','/api/feedback-lookup-v2?id=BETA-1']) {
    const body = await (await call(path)).json();
    const row = (body.feedback || body.matches).find(x=>x.report_id==='BETA-001');
    for (const key of ['description','steps','category','app_version','build_number','ios_version','device_model','created_at','source']) assert.equal(row[key],null,key);
    assert.ok(!JSON.stringify(row).includes('SECRET'));
  }
});

test('deleted and unpublished lookup excludes publication and attachments', async () => {
  const { db, call } = await fixture();
  for (const sql of ["UPDATE feedback_tracking SET deleted_at='now' WHERE feedback_id='beta'", "UPDATE feedback SET is_public=0 WHERE id='beta'"]) {
    db.exec(sql);
    const row = (await (await call('/api/feedback-lookup-v2?id=BETA-1')).json()).matches[0];
    assert.equal(row.description,null); assert.equal(row.public_title,null); assert.deepEqual(row.attachments,[]);
  }
});

test('comments validate object, size, origin, report, claim and retries', async () => {
  const { db, call } = await fixture();
  const path='/api/public-feedback/comment';
  const valid={reportId:'BETA-1',category:'privacy',message:'中文😀\n<script>alert(1)</script>',claimantOriginal:true};
  assert.equal((await call(path,null)).status,400);
  assert.equal((await call(path,[])).status,400);
  assert.equal((await call(path,{...valid,message:'x'.repeat(70000)})).status,413);
  assert.equal((await call(path,{...valid,message:'x'.repeat(2001)})).status,400);
  assert.equal((await call(path,valid,'POST',{Origin:'https://evil.test'})).status,403);
  assert.equal((await call(path,{...valid,reportId:'BETA-999'})).status,404);
  assert.equal((await call(path,valid)).status,201);
  assert.equal((await call(path,valid)).status,429);
  const row=db.prepare('SELECT * FROM feedback_public_comments').get();
  assert.equal(row.claimant_original,1); assert.equal(row.message,valid.message); assert.equal(row.status,'new');
  db.exec("UPDATE feedback SET is_public=0 WHERE id='beta'");
  assert.equal((await call(path,valid)).status,404);
  db.exec("UPDATE feedback SET is_public=1 WHERE id='beta'; UPDATE feedback_tracking SET deleted_at='now' WHERE feedback_id='beta'");
  assert.equal((await call(path,valid)).status,404);
});

test('attachment requires flat copy and preserves original and disabled derivative', async () => {
  const { db, env, objects, admin, call } = await fixture();
  db.exec("INSERT INTO feedback_attachments(id,feedback_id,source,storage_key,mime_type,created_at) VALUES ('img','beta','web','original','image/png','now')");
  objects.set('original',{bytes:new Uint8Array([99])});
  assert.equal((await admin('attachment/public?id=img',undefined)).status,409);
  const response = await worker.fetch(new Request('https://photo.chaihome.cc/dashboard/api/feedback/attachment/public?id=img',{method:'PUT',headers:{'Content-Type':'image/png','Cf-Access-Authenticated-User-Email':'admin@example.test'},body:new Uint8Array([1,2,3])}),env,{});
  assert.equal(response.status,200);
  const published=db.prepare("SELECT * FROM feedback_attachments WHERE id='img'").get();
  assert.notEqual(published.public_storage_key,'original'); assert.equal(published.storage_key,'original');
  assert.deepEqual([...new Uint8Array(await (await call('/api/public-feedback/attachment?id=img')).arrayBuffer())],[1,2,3]);
  await admin('attachment/public?id=img',undefined,'DELETE');
  assert.equal((await call('/api/public-feedback/attachment?id=img')).status,404);
  assert.ok(objects.has(published.public_storage_key)); assert.ok(objects.has('original'));
  assert.equal((await admin('attachment/public?id=img',undefined)).status,200);
});

test('200 public reports remain within D1 parameter limits',async()=>{
  const { seed,call }=await fixture();
  for(let n=2;n<=200;n++) seed('beta'+n,'beta',n);
  const r=await call('/api/public-feedback'); assert.equal(r.status,200); assert.equal((await r.json()).feedback.length,200);
});

test('TestFlight failure is retryable, feedback and multiple attachments commit atomically',async()=>{
  const {db,env,call}=await fixture();
  const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  env.APP_STORE_API_KEY_ID='test-key';
  env.APP_STORE_API_ISSUER_ID='test-issuer';
  env.APP_STORE_API_PRIVATE_KEY=key.privateKey.export({type:'pkcs8',format:'pem'});
  env.APP_STORE_WEBHOOK_SECRET='test-webhook';
  const event={data:{id:'event-1',type:'betaFeedbackScreenshotSubmissionCreated',relationships:{instance:{data:{id:'resource-1',type:'betaFeedbackScreenshotSubmissions'}}}}};
  const signature='hmacsha256='+createHmac('sha256',env.APP_STORE_WEBHOOK_SECRET).update(JSON.stringify(event)).digest('hex');
  const realFetch=globalThis.fetch;
  globalThis.fetch=async url=>{
    if(String(url).includes('/preReleaseVersion'))return Response.json({data:{attributes:{version:'1.2.5'}}});
    if(String(url).startsWith('https://media.test/'))return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/png'}});
    return Response.json({data:{id:'resource-1',attributes:{comment:'測試😀\n第二行',osVersion:'26',deviceModel:'iPhone18,1',screenshots:[{url:'https://media.test/1',width:1206,height:2622},{url:'https://media.test/2',width:1206,height:2622}]}},included:[{type:'builds',id:'build-45',attributes:{version:'45'}},{type:'betaTesters',attributes:{email:'private@example.test'}}]});
  };
  const batch=env.DB.batch;
  let fail=true;
  env.DB.batch=async statements=>{
    if(fail && statements.some(s=>s.sql.includes('INSERT INTO feedback_attachments'))) {fail=false;throw Error('Simulated D1 failure');}
    return batch(statements);
  };
  try {
    assert.equal((await call('/api/webhooks/appstore',event,'POST',{'x-apple-signature':'bad'})).status,401);
    assert.equal((await call('/api/webhooks/appstore',event,'POST',{'x-apple-signature':signature})).status,503);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM feedback_v2_meta WHERE external_resource_id='resource-1'").get().n,0);
    assert.equal((await call('/api/webhooks/appstore',event,'POST',{'x-apple-signature':signature})).status,202);
    assert.equal((await call('/api/webhooks/appstore',event,'POST',{'x-apple-signature':signature})).status,202);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM feedback_v2_meta WHERE external_resource_id='resource-1'").get().n,1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feedback_attachments').get().n,2);
    const row=db.prepare("SELECT * FROM feedback WHERE source='testflight' AND description LIKE '測試%'").get();
    assert.equal(row.build_number,'45');assert.equal(row.app_version,'1.2.5');assert.equal(row.description,'測試😀\n第二行');
    const body=await (await call('/api/public-feedback')).text();assert.ok(!body.includes('private@example.test'));
  } finally {globalThis.fetch=realFetch;}
});

test('web submission → dashboard → publication → public feedback → dashboard',async()=>{
  const {call,admin,db}=await fixture();
  const submitted=await call('/api/feedback',{category:'ui',description:'繁體中文😀\n第二行',steps:'步驟一\n步驟二',appVersion:'1.2.5',buildNumber:'45',iosVersion:'26',deviceModel:'iPhone18,1',diagnostics:{photoAccess:'limited',language:'zh-Hant',unapproved:'private'}});
  assert.equal(submitted.status,201);
  const {id:reportId}=await submitted.json();
  const actual=await (await call('/dashboard/api/feedback',undefined,'GET',{'Cf-Access-Authenticated-User-Email':'admin@example.test'})).json();
  const row=actual.feedback.find(x=>x.description==='繁體中文😀\n第二行');
  assert.ok(row);assert.equal(row.build_number,'45');
  await admin('publication',{id:row.id,isPublic:true,publicTitle:'公開測試',publicDescription:'整理過的內容',publicSteps:'公開步驟'});
  const lookup=await (await call('/api/feedback-lookup-v2?id='+reportId)).json();
  assert.equal(lookup.matches[0].description,'整理過的內容');
  assert.equal((await call('/api/public-feedback/comment',{reportId,category:'incorrect',message:'這是使用者反饋'})).status,201);
  const comments=await (await call('/dashboard/api/public-feedback-comments',undefined,'GET',{'Cf-Access-Authenticated-User-Email':'admin@example.test'})).json();
  assert.ok(comments.ok);
  assert.equal(comments.comments[0].message,'這是使用者反饋');
  assert.equal(db.prepare('SELECT description FROM feedback WHERE id=?').get(row.id).description,'繁體中文😀\n第二行');
});

test('legacy lookup obeys time visibility and cannot alias a TestFlight ID',async()=>{
  const {db,call}=await fixture();
  db.exec("UPDATE feedback_v2_meta SET public_show_created_at=0 WHERE feedback_id='beta'");
  const row=await (await call('/api/feedback-status?id=BETA-1')).json();
  assert.equal(row.feedback.created_at,null);
  assert.equal((await call('/api/feedback-status?id=BETA-1001')).status,404);
});

test('concurrent unpublish wins over an in-flight image save',async()=>{
  const {db,env}=await fixture();
  db.exec("INSERT INTO feedback_attachments(id,feedback_id,source,storage_key,public_storage_key,is_public,created_at) VALUES ('race','beta','web','original','public/old',1,'now')");
  const put=env.FEEDBACK_MEDIA.put;
  env.FEEDBACK_MEDIA.put=async(...args)=>{await put(...args);db.exec("UPDATE feedback_attachments SET is_public=0 WHERE id='race'");};
  const response=await worker.fetch(new Request('https://photo.chaihome.cc/dashboard/api/feedback/attachment/public?id=race',{method:'PUT',headers:{'Content-Type':'image/png','Cf-Access-Authenticated-User-Email':'admin@example.test'},body:new Uint8Array([1])}),env,{});
  assert.equal(response.status,409);
  const row=db.prepare("SELECT * FROM feedback_attachments WHERE id='race'").get();
  assert.equal(row.is_public,0);assert.equal(row.public_storage_key,'public/old');assert.equal(row.storage_key,'original');
});

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const html=readFileSync(new URL('../../public/dashboard/index.html',import.meta.url),'utf8');
test.beforeEach(async({page})=>{
  await page.route('https://photo.chaihome.cc/**', async route=>{
    if(new URL(route.request().url()).pathname==='/dashboard') return route.fulfill({contentType:'text/html',body:html});
    return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,feedback:[],counts:{},attachments:[]})});
  });
  await page.goto('https://photo.chaihome.cc/dashboard');
  await page.evaluate(async()=>{
    const c=document.createElement('canvas'); c.width=1206;c.height=2622;
    const ctx=c.getContext('2d');ctx.fillStyle='#ff0000';ctx.fillRect(0,0,c.width,c.height);
    window.fixtureURL=c.toDataURL('image/png');
    await openPublicImageEditor({id:'one',url:window.fixtureURL},()=>{});
  });
});

test('zoom and pan map to full image; selection overlay is not burned in; undo/reset',async({page})=>{
  const result=await page.evaluate(()=>{
    imageEditorZoom=3; imageEditorPanX=-100;imageEditorPanY=80;updateImageEditorTransform();
    const r=imageEditorSelectionCanvas.getBoundingClientRect();
    const point=editorPoint({clientX:r.left+r.width/2,clientY:r.top+r.height/2});
    const selection={x:200,y:300,width:100,height:120,tool:'blackout'};
    setImageEditorSelection(selection);
    const pixel=()=>Array.from(imageEditorContext.getImageData(220,320,1,1).data);
    const before=pixel();
    applyConfirmedImageEditorSelection(selection);
    const after=pixel();
    imageEditorUndo.click();const undone=pixel();
    applyConfirmedImageEditorSelection(selection);imageEditorReset.click();
    return {point,before,after,undone,reset:pixel(),width:imageEditorCanvas.width,height:imageEditorCanvas.height};
  });
  expect(result.point).toEqual({x:603,y:1311});
  expect(result.before).toEqual([255,0,0,255]);expect(result.after).toEqual([0,0,0,255]);
  expect(result.undone).toEqual(result.before);expect(result.reset).toEqual(result.before);
  expect([result.width,result.height]).toEqual([1206,2622]);
});

test('unconfirmed selection blocks save and exported image keeps full dimensions',async({page})=>{
  const result=await page.evaluate(async()=>{
    let uploaded=null;
    const realFetch=window.fetch;
    window.fetch=async(url,options)=>{
      if(options?.method==='PUT') { uploaded={url,blob:options.body};return Response.json({ok:true}); }
      return realFetch(url,options);
    };
    setImageEditorSelection({x:10,y:10,width:50,height:50,tool:'blackout'});
    imageEditorSave.click();
    const blocked=uploaded===null;
    imageSelectionConfirm.click();
    imageEditorSave.click();
    while(!uploaded) await new Promise(resolve=>setTimeout(resolve,10));
    const bitmap=await createImageBitmap(uploaded.blob);
    return {blocked,width:bitmap.width,height:bitmap.height,url:uploaded.url};
  });
  expect(result.blocked).toBe(true);expect([result.width,result.height]).toEqual([1206,2622]);
  expect(result.url).toContain('id=one');
});

test('late load cannot replace a newer image and public derivative is preferred',async({page})=>{
  const result=await page.evaluate(async()=>{
    let resolveOld;
    const realFetch=window.fetch;
    window.fetch=(url,options)=>url==='/slow' ? new Promise(resolve=>resolveOld=resolve) : realFetch(url,options);
    const old=openPublicImageEditor({id:'old',url:'/slow'},()=>{});
    await openPublicImageEditor({id:'new',url:'/unavailable-original',public_url:window.fixtureURL},()=>{});
    resolveOld(await realFetch(window.fixtureURL));await old;
    return {id:imageEditorAttachment.id,width:imageEditorBitmap.width,hidden:imageEditorModal.hidden};
  });
  expect(result).toEqual({id:'new',width:1206,hidden:false});
});

test('nested modal retains body lock until both close',async({page})=>{
  const result=await page.evaluate(()=>{
    publicationModal.hidden=false;syncModalScrollLock();closePublicImageEditor();
    const nested=document.body.style.position;
    publicationModal.hidden=true;syncModalScrollLock();
    return {nested,closed:document.body.style.position};
  });
  expect(result).toEqual({nested:'fixed',closed:''});
});

test('pixelation produces identical image coordinates at different viewport transforms',async({page})=>{
  const result=await page.evaluate(()=>{
    function render(zoom,pan) {
      redrawImageEditorOriginal();
      const gradient=imageEditorContext.createLinearGradient(0,0,1206,0);
      gradient.addColorStop(0,'red');gradient.addColorStop(1,'blue');
      imageEditorContext.fillStyle=gradient;imageEditorContext.fillRect(0,0,1206,2622);
      imageEditorZoom=zoom;imageEditorPanX=pan;imageEditorPanY=-pan;updateImageEditorTransform();
      const r=imageEditorSelectionCanvas.getBoundingClientRect();
      const start=editorPoint({clientX:r.left+r.width*.25,clientY:r.top+r.height*.25});
      const end=editorPoint({clientX:r.left+r.width*.75,clientY:r.top+r.height*.75});
      const selection=normalizeImageEditorSelection(start,end,'pixelate');
      const before=imageEditorCanvas.toDataURL();applyConfirmedImageEditorSelection(selection);
      return {before,after:imageEditorCanvas.toDataURL(),selection,pixels:imageEditorContext.getImageData(0,0,1206,2622).data};
    }
    const a=render(1,0),b=render(4,-300);
    let maxDelta=0;
    for(let i=0;i<a.pixels.length;i++)maxDelta=Math.max(maxDelta,Math.abs(a.pixels[i]-b.pixels[i]));
    return {maxDelta,changed:a.before!==a.after,a:a.selection,b:b.selection};
  });
  expect(result.a).toEqual(result.b);
  expect(result.maxDelta).toBeLessThanOrEqual(1);expect(result.changed).toBe(true);
});

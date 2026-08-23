document.title='D0';
const skip=new URLSearchParams(location.search).get('skip')||'';
try{
const {defaultProject}=await import('../src/core/model.js');
const project=defaultProject();
globalThis.__fxSkip=skip;
const {createSharedReturns,createTrackFX}=await import('../src/audio/fx.js');
const {createDrumVoice}=await import('../src/audio/voices/kit.js');
const {mulberry32}=await import('../src/core/rng.js');
document.title='D1 skip='+skip;
const ctx=new OfflineAudioContext(2,200000,44100);
const returns=createSharedReturns(ctx);
returns.output.connect(ctx.destination);
returns.setBpm(project.bpm);
const ch=createTrackFX(ctx,returns);
ch.out.connect(returns.masterIn);
ch.setFX(project.tracks[0].fx);
ch.setMixer(project.tracks[0].mixer);
ch.applySolo(false);
document.title='D2 built';
const kick=project.tracks[0];
const voice=createDrumVoice(ctx,ch.input,'kick');
for(let i=0;i<4;i++){voice.trigger({time:0.1+i*0.25,velocity:0.9,ratchet:1},kick.params,mulberry32(i+1));}
document.title='D3 trig';
const buf=await ctx.startRendering();
document.title='DOK len='+buf.length;
}catch(e){document.title='DERR '+(e.stack||e.message).slice(0,250);}

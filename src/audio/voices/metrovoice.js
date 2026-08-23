export function createMetroVoice(ctx, destination) {
  let live = [];
  function trigger(event) {
    const t = event.time;
    const freq = event.note === 1 ? 1976 : 1319;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    const peak = 0.25 * Math.max(0.05, event.velocity);
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 600;
    osc.connect(g).connect(hp).connect(destination);
    osc.start(t);
    osc.stop(t + 0.05);
    live.push(osc);
    osc.onended = () => {
      hp.disconnect();
      const i = live.indexOf(osc);
      if (i >= 0) live.splice(i, 1);
    };
  }
  function dispose() {
    for (const o of live) { try { o.stop(); } catch {} }
    live = [];
  }
  return { trigger, dispose };
}

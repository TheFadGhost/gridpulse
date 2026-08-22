export const STEP_BEATS = 0.25;

export function makeBeatMap(anchors) {
  if (!anchors.length || anchors[0].beat !== 0) throw new Error('first anchor must be beat 0');
  for (let i = 1; i < anchors.length; i++) {
    if (!(anchors[i].bpm > 0)) throw new Error('anchor bpm must be > 0');
  }
  function segmentByBeat(b) {
    let lo = 0, hi = anchors.length - 1, res = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid].beat <= b) { res = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return anchors[res];
  }
  function segmentByTime(t) {
    let lo = 0, hi = anchors.length - 1, res = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid].time <= t) { res = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return anchors[res];
  }
  function beatToSec(b) {
    const a = segmentByBeat(b);
    return a.time + (b - a.beat) * (60 / a.bpm);
  }
  function secToBeat(t) {
    const a = segmentByTime(t);
    return a.beat + (t - a.time) * (a.bpm / 60);
  }
  return { beatToSec, secToBeat, anchors };
}

export function swingDelaySeconds(stepIndex, bpm, swingAmt) {
  if (!(swingAmt > 0)) return 0;
  return stepIndex % 2 === 1 ? swingAmt * (60 / bpm) / 4 : 0;
}

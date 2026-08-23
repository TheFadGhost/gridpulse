export function buildSchedulerView(project, selectedPatternId = null) {
  const patterns = {};
  for (const pat of project.patterns) {
    patterns[pat.id] = { id: pat.id, length: pat.length, steps: pat.steps };
  }
  const firstId = project.patterns[0] ? project.patterns[0].id : null;
  const chain = (project.song.chain && project.song.chain.length)
    ? project.song.chain
    : [firstId];
  const den = project.timeSig.den;
  return {
    tracks: project.tracks.map(t => ({ id: t.id, type: t.type, length: t.length })),
    patterns,
    patternId: selectedPatternId || chain[0] || firstId,
    chain,
    songMode: project.song.mode === 'song',
    seed: project.seed | 0,
    swing: project.swing,
    bpm: project.bpm,
    metronome: project.metronome,
    stepsPerBeat: Math.max(1, Math.round(16 / den)),
    beatsPerBar: (project.timeSig.num * den) / 4
  };
}

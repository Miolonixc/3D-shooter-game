let actx: AudioContext | null = null;

export function initAudio(): AudioContext {
  if (!actx) {
    actx = new (window.AudioContext || (window as any).webkitAudioContext)();
    // тихий keep-alive генератор держит аудио-конвейер «прогретым» —
    // иначе у первого выстрела (и после паузы) большая задержка звука
    const ka = actx.createOscillator(), kg = actx.createGain();
    kg.gain.value = 0.0001;
    ka.connect(kg).connect(actx.destination);
    ka.start();
  }
  if (actx.state === 'suspended') {
    actx.resume();
  }
  return actx;
}

export function blip(freq: number, dur: number, type: OscillatorType, vol: number, slideTo?: number) {
  const a = initAudio();
  const t = a.currentTime;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) {
    o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  }
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur);
}

export function noiseBurst(dur: number, vol: number, cutoff: number) {
  const a = initAudio();
  const t = a.currentTime;
  const n = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, n, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2);
  }
  const src = a.createBufferSource();
  src.buffer = buf;
  const g = a.createGain();
  g.gain.value = vol;
  const f = a.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = cutoff;
  src.connect(f).connect(g).connect(a.destination);
  src.start(t);
}

export function sndShoot(smg: boolean) {
  noiseBurst(smg ? 0.07 : 0.11, smg ? 0.16 : 0.26, smg ? 2200 : 1600);
  blip(smg ? 320 : 200, 0.06, 'square', 0.1, 90);
}

export function sndHit() {
  blip(880, 0.05, 'triangle', 0.16);
}

export function sndKill() {
  blip(660, 0.18, 'sawtooth', 0.18, 180);
}

export function sndReload() {
  blip(150, 0.04, 'square', 0.13);
  setTimeout(() => blip(230, 0.05, 'square', 0.13), 170);
}

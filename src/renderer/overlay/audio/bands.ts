// Three smoothed frequency bands from an AnalyserNode, using the same split and envelopes as the
// Voice Orb: low 45–250 Hz (bass pressure), mid 250–2400 Hz (voice body), high 2.4–12 kHz (sparkle).
const BANDS: [number, number, number, number][] = [
  // [fromHz, toHz, attack s, release s]
  [45, 250, 0.012, 0.2],
  [250, 2400, 0.028, 0.15],
  [2400, 12000, 0.006, 0.085],
];

export class BandMeter {
  private data: Float32Array<ArrayBuffer>;
  private levels: [number, number, number] = [0, 0, 0];
  private last = performance.now();

  constructor(readonly analyser: AnalyserNode) {
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    this.data = new Float32Array(analyser.frequencyBinCount);
  }

  read(): [number, number, number] {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.analyser.getFloatFrequencyData(this.data);
    const hzPerBin = this.analyser.context.sampleRate / this.analyser.fftSize;
    BANDS.forEach(([from, to, attack, release], i) => {
      let power = 0;
      const a = Math.max(1, Math.floor(from / hzPerBin)), b = Math.min(this.data.length - 1, Math.ceil(to / hzPerBin));
      for (let k = a; k <= b; k++) power += 10 ** (this.data[k] / 10);
      // Compressive gain: speech-level input lands around 0.4–0.9.
      const level = Math.min(1, Math.max(0, (10 * Math.log10(power + 1e-12) + 62) / 44));
      const tau = level > this.levels[i] ? attack : release;
      this.levels[i] += (level - this.levels[i]) * (1 - Math.exp(-dt / tau));
    });
    return [...this.levels];
  }
}

import type { RecorderApi } from '../../preload/recorder';

// Records the screen (and, on Windows, what the PC plays) into a video, with the microphone mixed in
// or out on request. Everything goes through one audio mix, so the mic can be switched mid-recording.

const api = (window as unknown as { ghostRecorder: RecorderApi }).ghostRecorder;

// MP4 (H.264 + AAC) plays everywhere on Windows; WebM is the fallback.
const TYPES = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];

let recorder: MediaRecorder | null = null;
let tracks: MediaStreamTrack[] = [];
let audio: AudioContext | null = null;
let mix: MediaStreamAudioDestinationNode | null = null;
let mic: { stream: MediaStream; node: MediaStreamAudioSourceNode } | null = null;
// Chunks are handed over strictly in order, and "stopped" only after the last one.
let queue: Promise<void> = Promise.resolve();

api.onStart(async ({ sourceId, width, height, systemAudio }) => {
  try {
    const video = { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxWidth: width, maxHeight: height, maxFrameRate: 30 } };
    // Electron's desktop capture: the legacy constraint form, which needs no click in the page.
    const screen = await navigator.mediaDevices.getUserMedia({
      video, audio: systemAudio ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
    } as unknown as MediaStreamConstraints);
    tracks.push(...screen.getTracks());
    audio = new AudioContext();
    mix = audio.createMediaStreamDestination();
    // An inaudible, constant signal keeps the audio track flowing. Without it a silent stretch (nothing
    // playing, no mic) gives the recorder no audio at all, and it holds back the video while it waits.
    const silence = audio.createGain();
    silence.gain.value = 0;
    const keepAlive = audio.createConstantSource();
    keepAlive.connect(silence).connect(mix);
    keepAlive.start();
    if (screen.getAudioTracks().length) audio.createMediaStreamSource(new MediaStream(screen.getAudioTracks())).connect(mix);
    const out = new MediaStream([...screen.getVideoTracks(), ...mix.stream.getAudioTracks()]);
    const mimeType = TYPES.find(t => MediaRecorder.isTypeSupported(t)) ?? '';
    recorder = new MediaRecorder(out, { mimeType, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 160_000 });
    recorder.ondataavailable = e => {
      if (!e.data.size) return;
      queue = queue.then(async () => api.chunk(new Uint8Array(await e.data.arrayBuffer())));
    };
    recorder.onstop = () => { queue = queue.then(() => { release(); api.stopped(); }); };
    recorder.onerror = e => api.error(String((e as ErrorEvent).message ?? 'recording failed'));
    // The screen went away (e.g. the monitor was unplugged): save what there is.
    screen.getVideoTracks()[0]?.addEventListener('ended', () => { if (recorder?.state === 'recording') recorder.stop(); });
    api.started(recorder.mimeType || mimeType || 'video/webm');
    recorder.start(1000);
  } catch (e) {
    release();
    api.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }
});

api.onStop(() => {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  else api.stopped();
});

api.onMic(async on => {
  if (!audio || !mix) return;
  if (!on) {
    mic?.node.disconnect();
    mic?.stream.getTracks().forEach(t => t.stop());
    mic = null;
    api.mic(false);
    return;
  }
  if (mic) return api.mic(true);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const node = audio.createMediaStreamSource(stream);
    node.connect(mix);
    mic = { stream, node };
    api.mic(true);
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    api.mic(false, name === 'NotFoundError' ? 'No microphone found' : name === 'NotAllowedError' ? 'Windows blocked the microphone (Settings → Privacy → Microphone)' : `Microphone unavailable (${name || String(e)})`);
  }
});

function release(): void {
  for (const t of tracks) t.stop();
  mic?.stream.getTracks().forEach(t => t.stop());
  tracks = [];
  mic = null;
  void audio?.close();
  audio = null;
  mix = null;
}

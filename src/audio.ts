/**
 * Diorama Soccer — Audio Manager
 * Authentic PES-style match audio: referee whistle, ball kick, crossbar clang, net swoosh, crowd cheers.
 */

export class AudioManager {
  private ctx: AudioContext | null = null;
  private buffers: Map<string, AudioBuffer> = new Map();
  private isMuted = false;
  private cheerSource: AudioBufferSourceNode | null = null;

  constructor() {
    // Lazily initialized on first user interaction
  }

  private initContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  public async preloadSounds(): Promise<void> {
    const soundList = [
      { name: 'cheer', url: './audio/cheer.mp3' },
      { name: 'whistle', url: './audio/whistle.mp3' },
      { name: 'kick', url: './audio/kick.mp3' },
      { name: 'post', url: './audio/post.mp3' },
      { name: 'net', url: './audio/net.mp3' },
    ];

    const ctx = this.initContext();

    await Promise.all(
      soundList.map(async ({ name, url }) => {
        try {
          const resp = await fetch(url);
          const arrayBuf = await resp.arrayBuffer();
          const audioBuf = await ctx.decodeAudioData(arrayBuf);
          this.buffers.set(name, audioBuf);
        } catch (e) {
          console.warn(`[Audio] Falha ao carregar ${url}:`, e);
        }
      })
    );
  }

  public playKick(power = 0.5): void {
    if (this.isMuted) return;
    const ctx = this.initContext();
    const buf = this.buffers.get('kick');
    if (!buf) return;

    const source = ctx.createBufferSource();
    source.buffer = buf;
    // Slight pitch variation for realism
    source.playbackRate.value = 0.95 + Math.random() * 0.12;

    const gain = ctx.createGain();
    const vol = THREE_clamp(0.25 + power * 0.55, 0.2, 0.85);
    gain.gain.value = vol;

    source.connect(gain);
    gain.connect(ctx.destination);
    source.start(0);
  }

  public playWhistle(): void {
    if (this.isMuted) return;
    const ctx = this.initContext();
    const buf = this.buffers.get('whistle');
    if (!buf) return;

    const source = ctx.createBufferSource();
    source.buffer = buf;

    const gain = ctx.createGain();
    gain.gain.value = 0.65;

    source.connect(gain);
    gain.connect(ctx.destination);
    source.start(0);
  }

  public playGoal(): void {
    if (this.isMuted) return;
    this.playWhistle();
    this.playNet();

    const ctx = this.initContext();
    const buf = this.buffers.get('cheer');
    if (!buf) return;

    if (this.cheerSource) {
      try {
        this.cheerSource.stop();
      } catch {
        // Ignore if already stopped
      }
    }

    const source = ctx.createBufferSource();
    source.buffer = buf;

    const gain = ctx.createGain();
    gain.gain.value = 0.75;

    source.connect(gain);
    gain.connect(ctx.destination);
    source.start(0.15); // Slight delay after whistle
    this.cheerSource = source;
  }

  public playPost(): void {
    if (this.isMuted) return;
    const ctx = this.initContext();
    const buf = this.buffers.get('post');
    if (!buf) return;

    const source = ctx.createBufferSource();
    source.buffer = buf;

    const gain = ctx.createGain();
    gain.gain.value = 0.70;

    source.connect(gain);
    gain.connect(ctx.destination);
    source.start(0);
  }

  public playNet(): void {
    if (this.isMuted) return;
    const ctx = this.initContext();
    const buf = this.buffers.get('net');
    if (!buf) return;

    const source = ctx.createBufferSource();
    source.buffer = buf;

    const gain = ctx.createGain();
    gain.gain.value = 0.55;

    source.connect(gain);
    gain.connect(ctx.destination);
    source.start(0);
  }

  public setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (muted && this.cheerSource) {
      try {
        this.cheerSource.stop();
      } catch {
        // Ignore
      }
    }
  }
}

function THREE_clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export const matchAudio = new AudioManager();


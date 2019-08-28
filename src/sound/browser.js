import { Buffer } from 'buffer';
import EventEmitter from 'eventemitter3';
const AudioContext = window.webkitAudioContext || window.AudioContext;

class BrowserSound extends EventEmitter {
  constructor({ volume, muted }) {
    super();
    this.duration = 0;
    this.state = 'blocked';
    this.blockedCurrTime = 0;
    this.skimmedTime = 0;

    this.vol = volume;
    this.muted = muted;
    this.context = new AudioContext();
    this.gainNode = this.context.createGain();
    this.gainNode.gain.value = this.muted ? 0.0 : this.vol;
    this.gainNode.connect(this.context.destination);

    this.audioSrcNodes = [];
    this.playStartedAt = 0;
    this.totalTimeScheduled = 0;
    this.data = Buffer.alloc(0);
  }

  setBlockedCurrTime(currTime = 0) {
    this.blockedCurrTime = currTime;
    for (let i = 0; i < this.audioSrcNodes.length; i++) {
      const { timestamp } = this.audioSrcNodes[i];
      if (currTime <= timestamp * 1000) {
        const nodes = this.audioSrcNodes.splice(0, !i ? 0 : i - 1);
        nodes.forEach(({ source }) => {
          source.onended = null;
          source.disconnect();
        });
        break;
      }
    }
  }

  unblock(offset) {
    if (this.state != 'blocked') {
      return;
    }

    this.state = 'running';
    this.context.resume();
    this.setBlockedCurrTime(offset);
    this.playStartedAt = 0;
    this.totalTimeScheduled = 0;
    for (let i = 0; i < this.audioSrcNodes.length; i++) {
      const { source, timestamp, duration } = this.audioSrcNodes[i];
      source.onended = null;
      source.disconnect();

      const audioSrc = this.context.createBufferSource();
      audioSrc.onended = this._onAudioBufferEnded.bind(this);
      if (!this.playStartedAt) {
        const { currentTime, baseLatency, sampleRate } = this.context;
        const startDelay = duration + (baseLatency || 128 / sampleRate);
        this.playStartedAt = currentTime + startDelay;
      }

      audioSrc.buffer = source.buffer;
      try {
        audioSrc.connect(this.gainNode);
        audioSrc.start(
          this.totalTimeScheduled + this.playStartedAt,
          !i ? offset / 1000 - timestamp : 0
        );
      } catch (e) {}

      this.audioSrcNodes[i].source = audioSrc;
      this.audioSrcNodes[i].timestamp = this.totalTimeScheduled;
      this.totalTimeScheduled += duration;
    }
  }

  getAvaiableDuration() {
    return this.duration;
  }

  getCurrentTime() {
    if (this.context) {
      return this.state == 'blocked'
        ? this.blockedCurrTime
        : this.context.currentTime - this.playStartedAt + this.skimmedTime;
    }
    return 0.0;
  }

  volume(vol) {
    if (vol != null) {
      this.vol = vol;
      this.gainNode.gain.value = this.muted ? 0.0 : vol;
    }
    return this.vol;
  }

  mute(muted) {
    if (muted != null) {
      this.muted = muted;
      this.gainNode.gain.value = this.muted ? 0.0 : this.vol;
    }
    return this.muted;
  }

  pause() {
    if (this.context) {
      return this.context.suspend();
    }
    return Promise.resolve();
  }

  resume() {
    if (this.context) {
      return this.context.resume();
    }
    return Promise.resolve();
  }

  decode(data) {
    data = Buffer.from(data);
    this.data = Buffer.concat([this.data, data]);
    if (this.context) {
      return new Promise(resolve => {
        this.context.decodeAudioData(
          this.data.buffer,
          buffer => {
            this._onDecodeSuccess(buffer);
            resolve();
          },
          error => {
            this._onDecodeError(error);
            resolve();
          }
        );
      });
    }
    return Promise.resolve();
  }

  destroy() {
    this.removeAllListeners();
    if (this.context) {
      this.context.close();
      this.context = null;
    }

    this.data = null;
    this.gainNode = null;
    this.audioSrcNodes = [];
    this.state = 'destroy';
  }

  _onDecodeSuccess(audioBuffer) {
    const audioSrc = this.context.createBufferSource();
    audioSrc.onended = this._onAudioBufferEnded.bind(this);

    if (!this.playStartedAt) {
      const { duration } = audioBuffer;
      const { currentTime, baseLatency, sampleRate } = this.context;
      const startDelay = duration + (baseLatency || 128 / sampleRate);
      this.playStartedAt = currentTime + startDelay;
    }

    audioSrc.buffer = audioBuffer;
    if (this.state == 'running') {
      try {
        audioSrc.connect(this.gainNode);
        audioSrc.start(this.totalTimeScheduled + this.playStartedAt);
      } catch (e) {}
    }

    this.audioSrcNodes.push({
      source: audioSrc,
      duration: audioBuffer.duration,
      timestamp: this.totalTimeScheduled
    });

    this.totalTimeScheduled += audioBuffer.duration;
    this.duration += audioBuffer.duration;

    this.data = Buffer.alloc(0);
    this.emit('decode:success');
  }

  _onDecodeError(e) {
    this.emit('decode:error', e);
  }

  _onAudioBufferEnded() {
    const { source } = this.audioSrcNodes.shift();
    source.disconnect();
  }
}

export default BrowserSound;

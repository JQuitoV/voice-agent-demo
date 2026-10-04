import { StreamProcessorSrc } from './worklets/stream_processor.js';
import { AudioAnalysis } from './analysis/audio_analysis.js';

// ====== EFECTOS DE VOZ: PERSONALIZA AQUI ======
// Estilo "IA de pelicula": voz limpia y cercana, con un brillo digital sutil.
const EFECTOS_ACTIVOS = true; // false = voz normal, sin efectos
const QUITAR_GRAVES_HZ = 120; // corta graves por debajo de esta frecuencia (voz mas limpia)
const PRESENCIA_DB = 3; // realce en 3 kHz: voz mas clara y nitida (0 a 6)
const AIRE_DB = 1.5; // realce en agudos: brillo "digital" (0 a 4)
const SALON = 0.2; // reverberacion corta tipo cabina (0 = nada, 0.4 = notable)
const DURACION_SALON = 0.12; // segundos de reverberacion (0.08 a 0.2 = cabina, mas de 0.5 = tunel)
const BRILLO_DIGITAL = 0.15; // chorus sutil que da textura sintetica (0 a 0.4)
const ECO = 0; // eco repetido (dejar en 0 para estilo IA; subir solo si lo quieres)
const ECO_RETARDO = 0.18; // segundos entre la voz y su eco
// ==============================================

/**
 * Plays audio streams received in raw PCM16 chunks from the browser
 * @class
 */
export class WavStreamPlayer {
  /**
   * Creates a new WavStreamPlayer instance
   * @param {{sampleRate?: number}} options
   * @returns {WavStreamPlayer}
   */
  constructor({ sampleRate = 44100 } = {}) {
    this.scriptSrc = StreamProcessorSrc;
    this.sampleRate = sampleRate;
    this.context = null;
    this.stream = null;
    this.analyser = null;
    this.input = null;
    this.trackSampleOffsets = {};
    this.interruptedTrackIds = {};
  }

  /**
   * Connects the audio context and enables output to speakers
   * @returns {Promise<true>}
   */
  async connect() {
    this.context = new AudioContext({ sampleRate: this.sampleRate });
    if (this.context.state === 'suspended') {
      await this.context.resume();
    }
    try {
      await this.context.audioWorklet.addModule(this.scriptSrc);
    } catch (e) {
      console.error(e);
      throw new Error(`Could not add audioWorklet module: ${this.scriptSrc}`);
    }
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0.1;
    this.analyser = analyser;
    this.input = this._crearEfectos();
    return true;
  }

  /**
   * Crea la cadena de efectos de voz y devuelve el punto de entrada
   * @private
   */
  _crearEfectos() {
    const ctx = this.context;
    if (!EFECTOS_ACTIVOS) return ctx.destination;

    // Ecualizacion: limpia graves, realza presencia y aire
    const graves = ctx.createBiquadFilter();
    graves.type = 'highpass';
    graves.frequency.value = QUITAR_GRAVES_HZ;
    const presencia = ctx.createBiquadFilter();
    presencia.type = 'peaking';
    presencia.frequency.value = 3000;
    presencia.Q.value = 0.9;
    presencia.gain.value = PRESENCIA_DB;
    const aire = ctx.createBiquadFilter();
    aire.type = 'highshelf';
    aire.frequency.value = 9000;
    aire.gain.value = AIRE_DB;
    graves.connect(presencia);
    presencia.connect(aire);

    const salida = ctx.createGain();
    salida.connect(ctx.destination);

    // Voz directa
    aire.connect(salida);

    // Brillo digital (chorus muy sutil)
    if (BRILLO_DIGITAL > 0) {
      const retardo = ctx.createDelay(0.05);
      retardo.delayTime.value = 0.012;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 1.5;
      const profundidad = ctx.createGain();
      profundidad.gain.value = 0.002;
      lfo.connect(profundidad);
      profundidad.connect(retardo.delayTime);
      lfo.start();
      const nivel = ctx.createGain();
      nivel.gain.value = BRILLO_DIGITAL;
      aire.connect(retardo);
      retardo.connect(nivel);
      nivel.connect(salida);
    }

    // Reverberacion corta tipo cabina
    if (SALON > 0) {
      const largo = Math.max(1, Math.floor(ctx.sampleRate * DURACION_SALON));
      const impulso = ctx.createBuffer(2, largo, ctx.sampleRate);
      for (let c = 0; c < 2; c++) {
        const datos = impulso.getChannelData(c);
        for (let i = 0; i < largo; i++) {
          datos[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / largo, 4);
        }
      }
      const convolver = ctx.createConvolver();
      convolver.buffer = impulso;
      const nivel = ctx.createGain();
      nivel.gain.value = SALON;
      aire.connect(convolver);
      convolver.connect(nivel);
      nivel.connect(salida);
    }

    // Eco opcional (desactivado por defecto)
    if (ECO > 0) {
      const retardo = ctx.createDelay(2);
      retardo.delayTime.value = ECO_RETARDO;
      const nivel = ctx.createGain();
      nivel.gain.value = ECO;
      aire.connect(retardo);
      retardo.connect(nivel);
      nivel.connect(salida);
    }

    return graves;
  }

  /**
   * Gets the current frequency domain data from the playing track
   * @param {"frequency"|"music"|"voice"} [analysisType]
   * @param {number} [minDecibels] default -100
   * @param {number} [maxDecibels] default -30
   * @returns {import('./analysis/audio_analysis.js').AudioAnalysisOutputType}
   */
  getFrequencies(
    analysisType = 'frequency',
    minDecibels = -100,
    maxDecibels = -30
  ) {
    if (!this.analyser) {
      throw new Error('Not connected, please call .connect() first');
    }
    return AudioAnalysis.getFrequencies(
      this.analyser,
      this.sampleRate,
      null,
      analysisType,
      minDecibels,
      maxDecibels
    );
  }

  /**
   * Starts audio streaming
   * @private
   * @returns {Promise<true>}
   */
  _start() {
    const streamNode = new AudioWorkletNode(this.context, 'stream_processor');
    streamNode.connect(this.input || this.context.destination);
    streamNode.port.onmessage = (e) => {
      const { event } = e.data;
      if (event === 'stop') {
        streamNode.disconnect();
        this.stream = null;
      } else if (event === 'offset') {
        const { requestId, trackId, offset } = e.data;
        const currentTime = offset / this.sampleRate;
        this.trackSampleOffsets[requestId] = { trackId, offset, currentTime };
      }
    };
    this.analyser.disconnect();
    streamNode.connect(this.analyser);
    this.stream = streamNode;
    return true;
  }

  /**
   * Adds 16BitPCM data to the currently playing audio stream
   * You can add chunks beyond the current play point and they will be queued for play
   * @param {ArrayBuffer|Int16Array} arrayBuffer
   * @param {string} [trackId]
   * @returns {Int16Array}
   */
  add16BitPCM(arrayBuffer, trackId = 'default') {
    if (typeof trackId !== 'string') {
      throw new Error(`trackId must be a string`);
    } else if (this.interruptedTrackIds[trackId]) {
      return;
    }
    if (!this.stream) {
      this._start();
    }
    let buffer;
    if (arrayBuffer instanceof Int16Array) {
      buffer = arrayBuffer;
    } else if (arrayBuffer instanceof ArrayBuffer) {
      buffer = new Int16Array(arrayBuffer);
    } else {
      throw new Error(`argument must be Int16Array or ArrayBuffer`);
    }
    this.stream.port.postMessage({ event: 'write', buffer, trackId });
    return buffer;
  }

  /**
   * Gets the offset (sample count) of the currently playing stream
   * @param {boolean} [interrupt]
   * @returns {{trackId: string|null, offset: number, currentTime: number}}
   */
  async getTrackSampleOffset(interrupt = false) {
    if (!this.stream) {
      return null;
    }
    const requestId = crypto.randomUUID();
    this.stream.port.postMessage({
      event: interrupt ? 'interrupt' : 'offset',
      requestId,
    });
    let trackSampleOffset;
    while (!trackSampleOffset) {
      trackSampleOffset = this.trackSampleOffsets[requestId];
      await new Promise((r) => setTimeout(() => r(), 1));
    }
    const { trackId } = trackSampleOffset;
    if (interrupt && trackId) {
      this.interruptedTrackIds[trackId] = true;
    }
    return trackSampleOffset;
  }

  /**
   * Strips the current stream and returns the sample offset of the audio
   * @param {boolean} [interrupt]
   * @returns {{trackId: string|null, offset: number, currentTime: number}}
   */
  async interrupt() {
    return this.getTrackSampleOffset(true);
  }
}

globalThis.WavStreamPlayer = WavStreamPlayer;

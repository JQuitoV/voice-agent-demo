import { StreamProcessorSrc } from './worklets/stream_processor.js';
import { AudioAnalysis } from './analysis/audio_analysis.js';

// ====== EFECTOS DE VOZ: PERSONALIZA AQUI ======
const EFECTOS_ACTIVOS = true; // false = voz normal, sin efectos
const VOZ_DIRECTA = 0.85; // volumen de la voz original (0 a 1)
const REVERBERACION = 0.35; // cantidad de "salon" (0 = nada, 1 = mucho)
const DURACION_SALON = 1.8; // segundos que dura la reverberacion (1 = cuarto, 3 = catedral)
const ECO = 0.25; // volumen del eco (0 = sin eco, 0.6 = eco fuerte)
const ECO_RETARDO = 0.18; // segundos entre la voz y su eco
const ECO_REPETICIONES = 0.3; // cuanto se repite el eco (0 = una vez, 0.6 = varias)
const METALICO = false; // true = toque robotico/digital
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

    const entrada = ctx.createGain();
    const salida = ctx.createGain();
    salida.connect(ctx.destination);

    // Toque metalico opcional (filtro de peine)
    let fuente = entrada;
    if (METALICO) {
      const peine = ctx.createDelay(0.05);
      peine.delayTime.value = 0.008;
      const realimentacion = ctx.createGain();
      realimentacion.gain.value = 0.55;
      const mezcla = ctx.createGain();
      entrada.connect(mezcla);
      entrada.connect(peine);
      peine.connect(realimentacion);
      realimentacion.connect(peine);
      peine.connect(mezcla);
      fuente = mezcla;
    }

    // Voz directa
    const directa = ctx.createGain();
    directa.gain.value = VOZ_DIRECTA;
    fuente.connect(directa);
    directa.connect(salida);

    // Reverberacion (salon generado por codigo)
    if (REVERBERACION > 0) {
      const largo = Math.max(1, Math.floor(ctx.sampleRate * DURACION_SALON));
      const impulso = ctx.createBuffer(2, largo, ctx.sampleRate);
      for (let c = 0; c < 2; c++) {
        const datos = impulso.getChannelData(c);
        for (let i = 0; i < largo; i++) {
          datos[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / largo, 3);
        }
      }
      const convolver = ctx.createConvolver();
      convolver.buffer = impulso;
      const reverb = ctx.createGain();
      reverb.gain.value = REVERBERACION;
      fuente.connect(convolver);
      convolver.connect(reverb);
      reverb.connect(salida);
    }

    // Eco
    if (ECO > 0) {
      const retardo = ctx.createDelay(2);
      retardo.delayTime.value = ECO_RETARDO;
      const repeticiones = ctx.createGain();
      repeticiones.gain.value = Math.min(ECO_REPETICIONES, 0.9);
      const eco = ctx.createGain();
      eco.gain.value = ECO;
      fuente.connect(retardo);
      retardo.connect(repeticiones);
      repeticiones.connect(retardo);
      retardo.connect(eco);
      eco.connect(salida);
    }

    return entrada;
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

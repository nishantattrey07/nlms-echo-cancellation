/**
 * Audio Playback System
 * Handles playback of recorded audio and processed results
 */

import { EchoCancellationSystem } from '../main.js';
import type { RecordedAudio } from './audio-recorder.js';

export interface PlaybackConfig {
  sampleRate: number;
  autoLoop: boolean;
  volume: number;
}

export interface AudioComparison {
  original: Float32Array;
  processed: Float32Array;
  metrics: {
    erle: number;
    signalPower: number;
    noisePower: number;
  };
}

export class AudioPlayer {
  private config: PlaybackConfig;
  private audioContext!: AudioContext;
  private currentSource: AudioBufferSourceNode | null = null;
  private isPlaying: boolean = false;
  private gainNode!: GainNode;

  constructor(config: Partial<PlaybackConfig> = {}) {
    this.config = {
      sampleRate: 48000,
      autoLoop: false,
      volume: 0.8,
      ...config
    };
  }

  /**
   * Initialize audio context for playback
   */
  public async initialize(): Promise<void> {
    try {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: this.config.sampleRate
      });

      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      // Create gain node for volume control
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = this.config.volume;
      this.gainNode.connect(this.audioContext.destination);

      console.log('Audio player initialized');

    } catch (error) {
      console.error('Failed to initialize audio player:', error);
      throw error;
    }
  }

  /**
   * Process recorded audio through echo cancellation system
   */
  public async processRecordedAudio(recordedAudio: RecordedAudio): Promise<AudioComparison> {
    console.log('Processing recorded audio...');
    
    const echoCanceller = new EchoCancellationSystem({
      sampleRate: recordedAudio.sampleRate,
      blockSize: 128
    });

    const blockSize = 128;
    const numBlocks = Math.ceil(recordedAudio.mixed_signal.length / blockSize);
    const processedAudio = new Float32Array(recordedAudio.mixed_signal.length);

    // Process in blocks
    for (let blockIndex = 0; blockIndex < numBlocks; blockIndex++) {
      const startIdx = blockIndex * blockSize;
      const endIdx = Math.min(startIdx + blockSize, recordedAudio.mixed_signal.length);
      const currentBlockSize = endIdx - startIdx;

      // Extract blocks
      const micBlock = recordedAudio.mixed_signal.slice(startIdx, endIdx);
      const refBlock = recordedAudio.clean_system.slice(startIdx, endIdx);

      // Ensure blocks are the right size
      const micPadded = new Float32Array(blockSize);
      const refPadded = new Float32Array(blockSize);
      micPadded.set(micBlock);
      refPadded.set(refBlock);

      // Process block
      const processedBlock = echoCanceller.processBlock(micPadded, refPadded);

      // Copy result
      processedAudio.set(processedBlock.slice(0, currentBlockSize), startIdx);
    }

    // Calculate metrics
    const metrics = this.calculateMetrics(recordedAudio.mixed_signal, processedAudio);

    console.log('Processing complete:', {
      inputLength: recordedAudio.mixed_signal.length,
      outputLength: processedAudio.length,
      erle: metrics.erle.toFixed(1) + 'dB'
    });

    return {
      original: recordedAudio.mixed_signal,
      processed: processedAudio,
      metrics
    };
  }

  private calculateMetrics(original: Float32Array, processed: Float32Array): AudioComparison['metrics'] {
    // Calculate signal and noise powers
    let originalPower = 0;
    let processedPower = 0;
    let errorPower = 0;

    for (let i = 0; i < Math.min(original.length, processed.length); i++) {
      originalPower += original[i] * original[i];
      processedPower += processed[i] * processed[i];
      const error = original[i] - processed[i];
      errorPower += error * error;
    }

    const length = Math.min(original.length, processed.length);
    originalPower /= length;
    processedPower /= length;
    errorPower /= length;

    // Echo Return Loss Enhancement (ERLE)
    const erle = originalPower > 1e-10 ? 
                 10 * Math.log10(originalPower / (processedPower + 1e-10)) : 0;

    return {
      erle: Math.max(0, erle),
      signalPower: 10 * Math.log10(originalPower + 1e-10),
      noisePower: 10 * Math.log10(errorPower + 1e-10)
    };
  }

  /**
   * Play audio buffer
   */
  public async playAudio(audioData: Float32Array, sampleRate: number = this.config.sampleRate): Promise<void> {
    if (this.isPlaying) {
      this.stopPlayback();
    }

    try {
      // Create audio buffer
      const audioBuffer = this.audioContext.createBuffer(1, audioData.length, sampleRate);
      audioBuffer.copyToChannel(audioData, 0);

      // Create source node
      this.currentSource = this.audioContext.createBufferSource();
      this.currentSource.buffer = audioBuffer;
      this.currentSource.loop = this.config.autoLoop;

      // Connect to output
      this.currentSource.connect(this.gainNode);

      // Handle playback end
      this.currentSource.onended = () => {
        this.isPlaying = false;
        this.currentSource = null;
      };

      // Start playback
      this.currentSource.start();
      this.isPlaying = true;

      console.log('Playback started:', {
        duration: (audioData.length / sampleRate).toFixed(2) + 's',
        sampleRate,
        samples: audioData.length
      });

    } catch (error) {
      console.error('Playback failed:', error);
      throw error;
    }
  }

  /**
   * Stop current playback
   */
  public stopPlayback(): void {
    if (this.currentSource && this.isPlaying) {
      this.currentSource.stop();
      this.currentSource = null;
      this.isPlaying = false;
      console.log('Playback stopped');
    }
  }

  /**
   * Set playback volume
   */
  public setVolume(volume: number): void {
    this.config.volume = Math.max(0, Math.min(1, volume));
    if (this.gainNode) {
      this.gainNode.gain.value = this.config.volume;
    }
  }

  /**
   * Create comparison demo
   */
  public createComparisonDemo(comparison: AudioComparison): {
    playOriginal: () => Promise<void>;
    playProcessed: () => Promise<void>;
    playComparison: () => Promise<void>;
    getMetrics: () => AudioComparison['metrics'];
  } {
    return {
      playOriginal: () => this.playAudio(comparison.original),
      playProcessed: () => this.playAudio(comparison.processed),
      playComparison: async () => {
        // Play original, then processed with a gap
        await this.playAudio(comparison.original);
        
        // Wait for completion + 1 second gap
        const originalDuration = comparison.original.length / this.config.sampleRate;
        setTimeout(async () => {
          await this.playAudio(comparison.processed);
        }, (originalDuration + 1) * 1000);
      },
      getMetrics: () => comparison.metrics
    };
  }

  /**
   * Generate audio visualization data
   */
  public generateVisualizationData(audioData: Float32Array, windowSize: number = 1024): {
    waveform: Float32Array;
    spectrum: Float32Array;
  } {
    // Downsample for waveform visualization
    const decimationFactor = Math.max(1, Math.floor(audioData.length / windowSize));
    const waveform = new Float32Array(Math.ceil(audioData.length / decimationFactor));
    
    for (let i = 0; i < waveform.length; i++) {
      const start = i * decimationFactor;
      const end = Math.min(start + decimationFactor, audioData.length);
      let sum = 0;
      for (let j = start; j < end; j++) {
        sum += Math.abs(audioData[j]);
      }
      waveform[i] = sum / (end - start);
    }

    // Simple spectrum analysis (magnitude only)
    const spectrum = new Float32Array(windowSize / 2);
    const fftSize = Math.min(windowSize, audioData.length);
    
    // Take a window from the middle of the audio
    const startIdx = Math.floor((audioData.length - fftSize) / 2);
    const window = audioData.slice(startIdx, startIdx + fftSize);
    
    // Simple magnitude spectrum calculation
    for (let k = 0; k < spectrum.length; k++) {
      let real = 0;
      let imag = 0;
      for (let n = 0; n < window.length; n++) {
        const angle = -2 * Math.PI * k * n / window.length;
        real += window[n] * Math.cos(angle);
        imag += window[n] * Math.sin(angle);
      }
      spectrum[k] = Math.sqrt(real * real + imag * imag) / window.length;
    }

    return { waveform, spectrum };
  }

  /**
   * Export audio as downloadable file
   */
  public exportAudio(audioData: Float32Array, filename: string, sampleRate: number = this.config.sampleRate): void {
    // Create WAV file
    const length = audioData.length;
    const buffer = new ArrayBuffer(44 + length * 2);
    const view = new DataView(buffer);
    
    // WAV header
    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };
    
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, length * 2, true);
    
    // Convert samples to 16-bit PCM
    let offset = 44;
    for (let i = 0; i < length; i++) {
      const sample = Math.max(-1, Math.min(1, audioData[i]));
      view.setInt16(offset, sample * 0x7FFF, true);
      offset += 2;
    }
    
    // Download
    const blob = new Blob([buffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.endsWith('.wav') ? filename : filename + '.wav';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  public getStatus() {
    return {
      isPlaying: this.isPlaying,
      volume: this.config.volume,
      sampleRate: this.config.sampleRate
    };
  }

  public cleanup(): void {
    this.stopPlayback();
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
    }
  }
}

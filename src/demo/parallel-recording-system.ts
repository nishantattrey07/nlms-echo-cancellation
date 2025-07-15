/**
 * Parallel Recording System
 * Records both contaminated (BEFORE) and clean (AFTER) audio simultaneously
 */

import { AudioRecorder } from './audio-recorder.js';
import { RealTimeProcessor, type ProcessingMetrics } from './real-time-processor.js';

export interface ParallelRecordingConfig {
  sampleRate: number;
  maxDuration: number;
  recordingBlockSize: number;
}

export interface ParallelRecordingResult {
  before: {
    mixed: Float32Array;           // Contaminated audio (mic + echo)
    rawMicrophone: Float32Array;   // Original microphone
    rawSystemAudio: Float32Array;  // Original system audio
  };
  after: {
    cleanMicrophone: Float32Array; // Echo-cancelled microphone
    cleanSystemAudio: Float32Array; // Clean system audio
  };
  metrics: {
    averageERLE: number;
    maxERLE: number;
    doubleTalkPercentage: number;
    processingLatency: number;
    recordingDuration: number;
  };
  sampleRate: number;
}

/**
 * Records both raw contaminated audio and real-time processed clean audio simultaneously
 */
export class ParallelRecordingSystem {
  private config: ParallelRecordingConfig;
  private audioRecorder: AudioRecorder;
  private realTimeProcessor: RealTimeProcessor;
  
  private isRecording: boolean = false;
  private recordingStartTime: number = 0;
  private recordingTimeoutId: number | null = null;
  
  // Recording buffers
  private rawRecordings = {
    microphone: [] as Float32Array[],
    systemAudio: [] as Float32Array[],
    mixed: [] as Float32Array[]
  };
  
  private processedRecordings = {
    cleanMicrophone: [] as Float32Array[],
    cleanSystemAudio: [] as Float32Array[]
  };
  
  // Metrics collection
  private recordedMetrics: ProcessingMetrics[] = [];
  
  // Audio processing nodes
  private recordingContext: AudioContext | null = null;
  private rawRecordingProcessor: ScriptProcessorNode | null = null;
  private processedRecordingProcessor: ScriptProcessorNode | null = null;

  constructor(config: Partial<ParallelRecordingConfig> = {}) {
    this.config = {
      sampleRate: 48000,
      maxDuration: 30,
      recordingBlockSize: 4096,
      ...config
    };

    this.audioRecorder = new AudioRecorder({
      sampleRate: this.config.sampleRate,
      maxDuration: this.config.maxDuration
    });

    this.realTimeProcessor = new RealTimeProcessor({
      sampleRate: this.config.sampleRate,
      blockSize: 128 // Smaller block for low-latency processing
    });
  }

  /**
   * Initialize the parallel recording system
   */
  public async initialize(): Promise<void> {
    try {
      console.log('Initializing parallel recording system...');
      
      // Initialize components
      await this.audioRecorder.initialize();
      await this.realTimeProcessor.initialize();
      
      // Create dedicated recording context
      this.recordingContext = new AudioContext({
        sampleRate: this.config.sampleRate,
        latencyHint: 'interactive'
      });

      if (this.recordingContext.state === 'suspended') {
        await this.recordingContext.resume();
      }

      console.log('✅ Parallel recording system initialized');
      
    } catch (error) {
      console.error('Failed to initialize parallel recording system:', error);
      throw error;
    }
  }

  /**
   * Start parallel recording with microphone and system audio
   */
  public async startRecording(
    microphoneStream: MediaStream,
    systemAudioStream: MediaStream
  ): Promise<void> {
    if (this.isRecording) {
      throw new Error('Recording already in progress');
    }

    try {
      console.log('Starting parallel recording (BEFORE + AFTER simultaneously)...');
      
      this.isRecording = true;
      this.recordingStartTime = performance.now();
      this.clearRecordings();

      // Setup Path 1: Raw audio recording (BEFORE)
      await this.setupRawRecording(microphoneStream, systemAudioStream);
      
      // Setup Path 2: Real-time processed recording (AFTER)
      await this.setupProcessedRecording(microphoneStream, systemAudioStream);

      // Auto-stop after configured duration
      this.recordingTimeoutId = window.setTimeout(() => {
        if (this.isRecording) {
          console.log('Auto-stopping recording after', this.config.maxDuration, 'seconds');
          this.stopRecording();
        }
      }, this.config.maxDuration * 1000);

      console.log('✅ Parallel recording started - capturing BEFORE and AFTER simultaneously');

    } catch (error) {
      this.isRecording = false;
      console.error('Failed to start parallel recording:', error);
      throw error;
    }
  }

  /**
   * Setup raw audio recording path (BEFORE - contaminated audio)
   */
  private async setupRawRecording(
    microphoneStream: MediaStream,
    systemAudioStream: MediaStream
  ): Promise<void> {
    if (!this.recordingContext) {
      throw new Error('Recording context not initialized');
    }

    // Create source nodes
    const micSource = this.recordingContext.createMediaStreamSource(microphoneStream);
    const sysSource = this.recordingContext.createMediaStreamSource(systemAudioStream);

    // Create recording processor
    this.rawRecordingProcessor = this.recordingContext.createScriptProcessor(
      this.config.recordingBlockSize,
      2, // 2 input channels
      2  // 2 output channels (passthrough)
    );

    // Create channel merger
    const merger = this.recordingContext.createChannelMerger(2);
    micSource.connect(merger, 0, 0);
    sysSource.connect(merger, 0, 1);
    merger.connect(this.rawRecordingProcessor);

    // Record raw audio blocks
    this.rawRecordingProcessor.onaudioprocess = (event) => {
      if (!this.isRecording) return;

      const micData = event.inputBuffer.getChannelData(0);
      const sysData = event.inputBuffer.getChannelData(1);

      // Store raw signals
      this.rawRecordings.microphone.push(new Float32Array(micData));
      this.rawRecordings.systemAudio.push(new Float32Array(sysData));

      // Create mixed signal (realistic echo contamination)
      const mixed = new Float32Array(micData.length);
      for (let i = 0; i < micData.length; i++) {
        // Simulate acoustic echo: 30% of system audio leaks into microphone
        mixed[i] = micData[i] + sysData[i] * 0.3;
      }
      this.rawRecordings.mixed.push(mixed);

      // Passthrough for monitoring (optional)
      event.outputBuffer.getChannelData(0).set(micData);
      event.outputBuffer.getChannelData(1).set(sysData);
    };

    // Connect to destination for monitoring
    this.rawRecordingProcessor.connect(this.recordingContext.destination);

    console.log('✅ Raw recording path setup complete');
  }

  /**
   * Setup processed audio recording path (AFTER - clean audio)
   */
  private async setupProcessedRecording(
    microphoneStream: MediaStream,
    systemAudioStream: MediaStream
  ): Promise<void> {
    if (!this.recordingContext) {
      throw new Error('Recording context not initialized');
    }

    // Start real-time processing
    const processingResult = await this.realTimeProcessor.startProcessing(
      microphoneStream,
      systemAudioStream
    );

    // Create recording processor for clean audio
    this.processedRecordingProcessor = this.recordingContext.createScriptProcessor(
      this.config.recordingBlockSize,
      2, // Clean mic + clean system
      2  // Passthrough
    );

    // Connect processed stream to recording processor
    const processedSource = this.recordingContext.createMediaStreamSource(
      processingResult.outputStream
    );
    processedSource.connect(this.processedRecordingProcessor);

    // Record processed audio blocks
    this.processedRecordingProcessor.onaudioprocess = (event) => {
      if (!this.isRecording) return;

      const cleanMic = event.inputBuffer.getChannelData(0);
      const cleanSys = event.inputBuffer.getChannelData(1);

      // Store processed signals
      this.processedRecordings.cleanMicrophone.push(new Float32Array(cleanMic));
      this.processedRecordings.cleanSystemAudio.push(new Float32Array(cleanSys));

      // Collect metrics from real-time processor
      const stats = this.realTimeProcessor.getProcessingStats();
      const nlmsMetrics = this.realTimeProcessor.getNLMSMetrics();
      
      // Create metrics snapshot
      const doubleTalkState = this.realTimeProcessor.getDoubleTalkState();
      const isDoubleTalk = doubleTalkState === 'double_talk';
      
      const metrics: ProcessingMetrics = {
        erle: nlmsMetrics.echoReturnLoss || 0,
        doubleTalkState: isDoubleTalk,
        estimatedDelay: stats.estimatedDelay,
        adaptationEnabled: !isDoubleTalk,
        inputLevel: this.calculateRMS(cleanMic),
        outputLevel: this.calculateRMS(cleanSys),
        processingLatency: stats.averageLatency
      };
      
      this.recordedMetrics.push(metrics);

      // Passthrough for monitoring
      event.outputBuffer.getChannelData(0).set(cleanMic);
      event.outputBuffer.getChannelData(1).set(cleanSys);
    };

    // Connect to destination for monitoring
    this.processedRecordingProcessor.connect(this.recordingContext.destination);

    console.log('✅ Processed recording path setup complete');
  }

  /**
   * Stop parallel recording and return results
   */
  public stopRecording(): ParallelRecordingResult {
    if (!this.isRecording) {
      throw new Error('No recording in progress');
    }

    console.log('Stopping parallel recording...');

    this.isRecording = false;
    
    // Clear timeout
    if (this.recordingTimeoutId) {
      clearTimeout(this.recordingTimeoutId);
      this.recordingTimeoutId = null;
    }

    // Stop real-time processing
    this.realTimeProcessor.stopProcessing();

    // Cleanup recording processors
    this.cleanupRecordingNodes();

    // Calculate recording duration
    const duration = (performance.now() - this.recordingStartTime) / 1000;

    // Combine recorded chunks
    const result: ParallelRecordingResult = {
      before: {
        mixed: this.combineChunks(this.rawRecordings.mixed),
        rawMicrophone: this.combineChunks(this.rawRecordings.microphone),
        rawSystemAudio: this.combineChunks(this.rawRecordings.systemAudio)
      },
      after: {
        cleanMicrophone: this.combineChunks(this.processedRecordings.cleanMicrophone),
        cleanSystemAudio: this.combineChunks(this.processedRecordings.cleanSystemAudio)
      },
      metrics: this.calculateOverallMetrics(duration),
      sampleRate: this.config.sampleRate
    };

    console.log('✅ Parallel recording completed:', {
      duration: duration.toFixed(2) + 's',
      beforeSamples: result.before.mixed.length,
      afterSamples: result.after.cleanMicrophone.length,
      averageERLE: result.metrics.averageERLE.toFixed(1) + 'dB'
    });

    return result;
  }

  /**
   * Calculate RMS (Root Mean Square) of audio signal
   */
  private calculateRMS(signal: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < signal.length; i++) {
      sum += signal[i] * signal[i];
    }
    return Math.sqrt(sum / signal.length);
  }

  /**
   * Combine audio chunks into single Float32Array
   */
  private combineChunks(chunks: Float32Array[]): Float32Array {
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Float32Array(totalLength);
    
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    
    return combined;
  }

  /**
   * Calculate overall recording metrics
   */
  private calculateOverallMetrics(duration: number) {
    if (this.recordedMetrics.length === 0) {
      return {
        averageERLE: 0,
        maxERLE: 0,
        doubleTalkPercentage: 0,
        processingLatency: 0,
        recordingDuration: duration
      };
    }

    const erleValues = this.recordedMetrics.map(m => m.erle);
    const doubleTalkCount = this.recordedMetrics.filter(m => m.doubleTalkState).length;
    const latencyValues = this.recordedMetrics.map(m => m.processingLatency);

    return {
      averageERLE: erleValues.reduce((a, b) => a + b, 0) / erleValues.length,
      maxERLE: Math.max(...erleValues),
      doubleTalkPercentage: (doubleTalkCount / this.recordedMetrics.length) * 100,
      processingLatency: latencyValues.reduce((a, b) => a + b, 0) / latencyValues.length,
      recordingDuration: duration
    };
  }

  /**
   * Clear all recording buffers
   */
  private clearRecordings(): void {
    this.rawRecordings.microphone = [];
    this.rawRecordings.systemAudio = [];
    this.rawRecordings.mixed = [];
    this.processedRecordings.cleanMicrophone = [];
    this.processedRecordings.cleanSystemAudio = [];
    this.recordedMetrics = [];
  }

  /**
   * Cleanup recording audio nodes
   */
  private cleanupRecordingNodes(): void {
    if (this.rawRecordingProcessor) {
      this.rawRecordingProcessor.disconnect();
      this.rawRecordingProcessor = null;
    }
    
    if (this.processedRecordingProcessor) {
      this.processedRecordingProcessor.disconnect();
      this.processedRecordingProcessor = null;
    }
  }

  /**
   * Get current recording status
   */
  public getRecordingStatus() {
    const currentTime = this.isRecording 
      ? (performance.now() - this.recordingStartTime) / 1000 
      : 0;

    return {
      isRecording: this.isRecording,
      recordingTime: currentTime,
      rawBufferSizes: {
        microphone: this.rawRecordings.microphone.length,
        systemAudio: this.rawRecordings.systemAudio.length,
        mixed: this.rawRecordings.mixed.length
      },
      processedBufferSizes: {
        cleanMicrophone: this.processedRecordings.cleanMicrophone.length,
        cleanSystemAudio: this.processedRecordings.cleanSystemAudio.length
      },
      metricsCount: this.recordedMetrics.length,
      processingStats: this.realTimeProcessor.getProcessingStats()
    };
  }

  /**
   * Create WAV files from parallel recording results
   */
  public createWAVFiles(result: ParallelRecordingResult): {
    beforeMixed: Blob;
    beforeMicrophone: Blob;
    beforeSystemAudio: Blob;
    afterCleanMicrophone: Blob;
    afterCleanSystemAudio: Blob;
  } {
    const createWAV = (audioData: Float32Array): Blob => {
      return this.audioRecorder.createWAVFile(audioData, result.sampleRate);
    };

    return {
      beforeMixed: createWAV(result.before.mixed),
      beforeMicrophone: createWAV(result.before.rawMicrophone),
      beforeSystemAudio: createWAV(result.before.rawSystemAudio),
      afterCleanMicrophone: createWAV(result.after.cleanMicrophone),
      afterCleanSystemAudio: createWAV(result.after.cleanSystemAudio)
    };
  }

  /**
   * Download all recorded files
   */
  public downloadRecording(result: ParallelRecordingResult): void {
    const files = this.createWAVFiles(result);
    
    const downloads = [
      { name: 'BEFORE_mixed_contaminated.wav', blob: files.beforeMixed },
      { name: 'BEFORE_raw_microphone.wav', blob: files.beforeMicrophone },
      { name: 'BEFORE_raw_system_audio.wav', blob: files.beforeSystemAudio },
      { name: 'AFTER_clean_microphone.wav', blob: files.afterCleanMicrophone },
      { name: 'AFTER_clean_system_audio.wav', blob: files.afterCleanSystemAudio }
    ];

    downloads.forEach(({ name, blob }) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });

    console.log('✅ Downloaded', downloads.length, 'audio files');
  }

  /**
   * Reset the recording system
   */
  public reset(): void {
    if (this.isRecording) {
      this.stopRecording();
    }
    
    this.realTimeProcessor.reset();
    this.clearRecordings();
  }

  /**
   * Cleanup resources
   */
  public cleanup(): void {
    this.reset();
    this.cleanupRecordingNodes();
    
    if (this.recordingContext && this.recordingContext.state !== 'closed') {
      this.recordingContext.close();
      this.recordingContext = null;
    }
    
    this.audioRecorder.cleanup();
  }
}

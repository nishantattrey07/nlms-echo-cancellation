/**
 * Real-Time Echo Cancellation Processor
 * Connects NLMS algorithms to live audio streams for real-time processing
 */

import { DoubleTalkDetector } from '../core/double-talk-detector.js';
import { NLMSProcessor } from '../core/nlms-processor.js';
import { CircularBuffer } from '../utils/circular-buffer.js';

export interface ProcessingConfig {
  sampleRate: number;
  blockSize: number;
  nlmsConfig?: {
    filterLength?: number;
    stepSize?: number;
    regularization?: number;
    leakageFactor?: number;
  };
  doubleTalkConfig?: {
    powerRatioThreshold?: number;
    correlationThreshold?: number;
    hangoverTime?: number;
    windowSize?: number;
  };
}

export interface ProcessingMetrics {
  erle: number;
  doubleTalkState: boolean;
  estimatedDelay: number;
  adaptationEnabled: boolean;
  inputLevel: number;
  outputLevel: number;
  processingLatency: number;
}

export interface ProcessedBlock {
  cleanMicrophone: Float32Array;
  cleanSystemAudio: Float32Array;
  metrics: ProcessingMetrics;
  timestamp: number;
}

/**
 * Real-time echo cancellation processor using NLMS algorithm
 */
export class RealTimeProcessor {
  private config: ProcessingConfig;
  private audioContext!: AudioContext;
  
  // Processing components
  private nlmsProcessor: NLMSProcessor;
  private doubleTalkDetector: DoubleTalkDetector;
  
  // Audio buffers for block processing
  private micBuffer: CircularBuffer;
  private sysBuffer: CircularBuffer;
  private outputBuffer: CircularBuffer;
  
  // Delay estimation
  private estimatedDelay: number = 0;
  
  // Performance tracking
  private processingTimes: number[] = [];
  private isProcessing: boolean = false;
  
  // Audio processing nodes
  private workletNode: AudioWorkletNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private sysSource: MediaStreamAudioSourceNode | null = null;
  
  constructor(config: Partial<ProcessingConfig> = {}) {
    this.config = {
      sampleRate: 48000,
      blockSize: 128,
      ...config
    };

    // Initialize processing components
    this.nlmsProcessor = new NLMSProcessor(this.config.nlmsConfig);
    this.doubleTalkDetector = new DoubleTalkDetector(this.config.doubleTalkConfig);
    
    // Initialize buffers (4x block size for lookahead)
    const bufferSize = this.config.blockSize * 4;
    this.micBuffer = new CircularBuffer(bufferSize);
    this.sysBuffer = new CircularBuffer(bufferSize);
    this.outputBuffer = new CircularBuffer(bufferSize);
  }

  /**
   * Initialize audio context for real-time processing
   */
  public async initialize(): Promise<void> {
    try {
      this.audioContext = new AudioContext({
        sampleRate: this.config.sampleRate,
        latencyHint: 'interactive'
      });

      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      // Load the AudioWorklet processor
      try {
        await this.audioContext.audioWorklet.addModule('/audio-worklet-processor.js');
        console.log('✅ AudioWorklet processor loaded');
      } catch (error) {
        console.error('Failed to load AudioWorklet processor:', error);
        throw new Error('AudioWorklet not supported or failed to load');
      }

      console.log('Real-time processor initialized:', {
        sampleRate: this.audioContext.sampleRate,
        blockSize: this.config.blockSize,
        latency: this.audioContext.baseLatency
      });

    } catch (error) {
      console.error('Failed to initialize real-time processor:', error);
      throw new Error('Real-time processing initialization failed');
    }
  }

  /**
   * Start real-time processing with microphone and system audio streams
   */
  public async startProcessing(
    microphoneStream: MediaStream,
    systemAudioStream: MediaStream
  ): Promise<{
    outputStream: MediaStream;
    stop: () => void;
  }> {
    if (this.isProcessing) {
      throw new Error('Processing already active');
    }

    try {
      console.log('Starting real-time echo cancellation processing...');
      
      // Create source nodes from input streams
      this.micSource = this.audioContext.createMediaStreamSource(microphoneStream);
      this.sysSource = this.audioContext.createMediaStreamSource(systemAudioStream);

      // Create AudioWorklet node for real-time processing
      this.workletNode = new AudioWorkletNode(this.audioContext, 'echo-cancellation-processor', {
        numberOfInputs: 1,   // Single input with 2 channels
        numberOfOutputs: 1,  // Clean audio output
        channelCount: 2,     // Stereo input (mic on L, system on R)
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete',
        processorOptions: {
          sampleRate: this.audioContext.sampleRate,
          filterLength: 512,
          stepSize: 0.1
        }
      });

      // Create channel merger to combine mic and system audio
      const channelMerger = this.audioContext.createChannelMerger(2);
      
      // Connect sources to merger
      this.micSource.connect(channelMerger, 0, 0);  // Mic to left channel
      this.sysSource.connect(channelMerger, 0, 1);  // System to right channel
      
      // Connect merger to worklet
      channelMerger.connect(this.workletNode);

      // Create output destination
      const destination = this.audioContext.createMediaStreamDestination();
      this.workletNode.connect(destination);

      // Set up worklet message handling
      this.workletNode.port.onmessage = (event) => {
        this.handleWorkletMessage(event.data);
      };

      // Start processing
      this.workletNode.port.postMessage({ type: 'start' });
      this.isProcessing = true;
      
      console.log('✅ Real-time processing started with AudioWorklet');

      return {
        outputStream: destination.stream,
        stop: () => this.stopProcessing()
      };

    } catch (error) {
      console.error('Failed to start real-time processing:', error);
      this.cleanup();
      throw error;
    }
  }

  /**
   * Handle messages from AudioWorklet processor
   */
  private handleWorkletMessage(data: any): void {
    switch (data.type) {
      case 'started':
        console.log('AudioWorklet processor started');
        break;
        
      case 'stopped':
        console.log('AudioWorklet processor stopped');
        break;
        
      case 'metrics':
        // Update metrics from worklet
        // This could be used to update UI in real-time
        break;
        
      default:
        console.log('Unknown worklet message:', data);
    }
  }

  /**
   * Process audio block in real-time
   */
  private processAudioBlock(event: AudioProcessingEvent): void {
    const startTime = performance.now();
    
    try {
      // Get input audio data
      const micData = event.inputBuffer.getChannelData(0);
      const sysData = event.inputBuffer.getChannelData(1);
      
      // Process through echo cancellation pipeline
      const result = this.processBlock(
        new Float32Array(micData),
        new Float32Array(sysData)
      );

      // Output processed audio
      const outputMic = event.outputBuffer.getChannelData(0);
      const outputSys = event.outputBuffer.getChannelData(1);
      
      outputMic.set(result.cleanMicrophone);
      outputSys.set(result.cleanSystemAudio);

      // Track processing performance
      const processingTime = performance.now() - startTime;
      this.processingTimes.push(processingTime);
      
      // Keep only last 100 measurements
      if (this.processingTimes.length > 100) {
        this.processingTimes.shift();
      }

    } catch (error) {
      console.error('Audio processing error:', error);
      // Output silence on error to prevent audio artifacts
      event.outputBuffer.getChannelData(0).fill(0);
      event.outputBuffer.getChannelData(1).fill(0);
    }
  }

  /**
   * Core echo cancellation processing block
   */
  private processBlock(micBlock: Float32Array, sysBlock: Float32Array): ProcessedBlock {
    const timestamp = performance.now();
    
    // Step 1: Add blocks to circular buffers
    this.micBuffer.writeBlock(micBlock);
    this.sysBuffer.writeBlock(sysBlock);

    // Step 2: Estimate and compensate for delay
    this.estimatedDelay = this.estimateDelay(micBlock, sysBlock);
    
    // Step 3: Get aligned audio blocks
    const alignedMic = new Float32Array(micBlock.length);
    const alignedSys = new Float32Array(sysBlock.length);
    
    this.micBuffer.readBlock(alignedMic, 0);
    this.sysBuffer.readBlock(alignedSys, this.estimatedDelay);

    // Step 4: Detect double-talk to control adaptation
    const adaptationEnabled = this.doubleTalkDetector.process(
      alignedMic,
      alignedSys,
      new Float32Array(micBlock.length) // Error signal placeholder
    );

    // Step 5: Apply NLMS echo cancellation
    const cleanMic = this.nlmsProcessor.process(
      alignedSys,      // Reference signal (system audio)
      alignedMic,      // Input signal (microphone with echo)
      adaptationEnabled // Control adaptation based on double-talk
    );

    // Step 6: Apply residual echo suppression if needed
    const finalCleanMic = this.applyResidualSuppression(cleanMic, alignedSys);

    // Step 7: Calculate metrics
    const metrics = this.calculateMetrics(
      alignedMic,
      finalCleanMic,
      alignedSys,
      adaptationEnabled
    );

    return {
      cleanMicrophone: finalCleanMic,
      cleanSystemAudio: alignedSys, // System audio is already clean
      metrics,
      timestamp
    };
  }

  /**
   * Estimate delay between microphone and system audio using cross-correlation
   */
  private estimateDelay(mic: Float32Array, sys: Float32Array): number {
    const maxDelay = Math.min(480, Math.floor(mic.length / 2)); // Max 10ms at 48kHz
    let maxCorrelation = 0;
    let bestDelay = 0;

    // Cross-correlation for delay estimation
    for (let delay = 0; delay < maxDelay; delay++) {
      let correlation = 0;
      let count = 0;
      
      for (let i = delay; i < mic.length && i - delay < sys.length; i++) {
        correlation += mic[i] * sys[i - delay];
        count++;
      }
      
      if (count > 0) {
        correlation /= count; // Normalize
        
        if (Math.abs(correlation) > Math.abs(maxCorrelation)) {
          maxCorrelation = correlation;
          bestDelay = delay;
        }
      }
    }

    // Smooth delay estimation to avoid jitter
    const alpha = 0.1; // Smoothing factor
    this.estimatedDelay = this.estimatedDelay * (1 - alpha) + bestDelay * alpha;
    
    return Math.round(this.estimatedDelay);
  }

  /**
   * Apply spectral post-filtering for residual echo suppression
   */
  private applyResidualSuppression(signal: Float32Array, reference: Float32Array): Float32Array {
    // Simple time-domain residual suppression
    // In production, use FFT-based spectral subtraction
    
    const output = new Float32Array(signal.length);
    const suppressionFactor = 0.1; // 10% residual suppression
    
    for (let i = 0; i < signal.length; i++) {
      // Apply gentle suppression when reference signal is present
      const refLevel = Math.abs(reference[i]);
      const suppression = refLevel > 0.001 ? suppressionFactor : 0;
      output[i] = signal[i] * (1 - suppression);
    }
    
    return output;
  }

  /**
   * Calculate real-time processing metrics
   */
  private calculateMetrics(
    originalMic: Float32Array,
    cleanMic: Float32Array,
    _systemAudio: Float32Array,
    adaptationEnabled: boolean
  ): ProcessingMetrics {
    // Calculate Echo Return Loss Enhancement (ERLE)
    const originalPower = this.calculatePower(originalMic);
    const cleanPower = this.calculatePower(cleanMic);
    const erle = originalPower > 0 ? 10 * Math.log10(originalPower / (cleanPower + 1e-10)) : 0;

    // Calculate signal levels
    const inputLevel = Math.sqrt(originalPower);
    const outputLevel = Math.sqrt(cleanPower);

    // Calculate average processing latency
    const avgProcessingTime = this.processingTimes.length > 0 
      ? this.processingTimes.reduce((a, b) => a + b, 0) / this.processingTimes.length 
      : 0;

    return {
      erle: Math.max(0, Math.min(60, erle)), // Clamp ERLE to reasonable range
      doubleTalkState: !adaptationEnabled,
      estimatedDelay: this.estimatedDelay,
      adaptationEnabled,
      inputLevel,
      outputLevel,
      processingLatency: avgProcessingTime
    };
  }

  /**
   * Calculate signal power (RMS squared)
   */
  private calculatePower(signal: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < signal.length; i++) {
      sum += signal[i] * signal[i];
    }
    return sum / signal.length;
  }

  /**
   * Stop real-time processing
   */
  public stopProcessing(): void {
    if (!this.isProcessing) return;

    console.log('Stopping real-time processing...');
    
    this.isProcessing = false;
    this.cleanup();
    
    console.log('✅ Real-time processing stopped');
  }

  /**
   * Get current processing statistics
   */
  public getProcessingStats(): {
    isProcessing: boolean;
    averageLatency: number;
    maxLatency: number;
    estimatedDelay: number;
    bufferUtilization: number;
  } {
    const avgLatency = this.processingTimes.length > 0 
      ? this.processingTimes.reduce((a, b) => a + b, 0) / this.processingTimes.length 
      : 0;
    
    const maxLatency = this.processingTimes.length > 0 
      ? Math.max(...this.processingTimes) 
      : 0;

    return {
      isProcessing: this.isProcessing,
      averageLatency: avgLatency,
      maxLatency: maxLatency,
      estimatedDelay: this.estimatedDelay,
      bufferUtilization: this.micBuffer.available() / this.micBuffer.getSize()
    };
  }

  /**
   * Reset processing state
   */
  public reset(): void {
    this.nlmsProcessor.reset();
    this.doubleTalkDetector.reset();
    this.micBuffer.clear();
    this.sysBuffer.clear();
    this.outputBuffer.clear();
    this.estimatedDelay = 0;
    this.processingTimes = [];
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'stop' });
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    
    if (this.micSource) {
      this.micSource.disconnect();
      this.micSource = null;
    }
    
    if (this.sysSource) {
      this.sysSource.disconnect();
      this.sysSource = null;
    }
  }

  /**
   * Get NLMS processor metrics
   */
  public getNLMSMetrics() {
    return this.nlmsProcessor.getMetrics();
  }

  /**
   * Get double-talk detector state
   */
  public getDoubleTalkState() {
    return this.doubleTalkDetector.getState();
  }
}

/**
 * Double-Talk Detector
 * Detects when both near-end and far-end speakers are active
 * Critical for preventing NLMS filter divergence
 */

export interface DoubleTalkConfig {
  powerRatioThreshold: number;    // Threshold for power ratio test
  correlationThreshold: number;   // Threshold for correlation test  
  hangoverTime: number;          // Hold time in samples
  windowSize: number;            // Analysis window size
}

export type TalkState = 'idle' | 'single_talk' | 'double_talk' | 'hold';

export const TalkState = {
  IDLE: 'idle' as const,
  SINGLE_TALK: 'single_talk' as const,
  DOUBLE_TALK: 'double_talk' as const,
  HOLD: 'hold' as const
} as const;

export class DoubleTalkDetector {
  private config: DoubleTalkConfig;
  private state: TalkState = TalkState.IDLE;
  private hangoverCounter: number = 0;
  
  // Power estimation
  private nearEndPower: number = 1e-10;
  private farEndPower: number = 1e-10;
  private crossPower: number = 1e-10;
  
  // Correlation calculation
  private nearEndBuffer!: Float32Array;
  private farEndBuffer!: Float32Array;
  private bufferIndex: number = 0;
  
  // Performance metrics
  private detectionAccuracy: number = 0;

  constructor(config: Partial<DoubleTalkConfig> = {}) {
    this.config = {
      powerRatioThreshold: 2.0,      // 3dB threshold
      correlationThreshold: 0.6,     // Correlation threshold
      hangoverTime: 2400,            // 50ms at 48kHz
      windowSize: 512,               // Analysis window
      ...config
    };

    this.initializeBuffers();
  }

  private initializeBuffers(): void {
    const { windowSize } = this.config;
    this.nearEndBuffer = new Float32Array(windowSize);
    this.farEndBuffer = new Float32Array(windowSize);
  }

  /**
   * Process audio samples and detect double-talk condition
   * @param nearEndSignal Microphone signal  
   * @param farEndSignal Reference (system audio) signal
   * @param errorSignal Echo canceller error signal
   * @returns Whether adaptation should be enabled
   */
  public process(
    nearEndSignal: Float32Array,
    farEndSignal: Float32Array, 
    errorSignal: Float32Array
  ): boolean {
    this.updatePowerEstimates(nearEndSignal, farEndSignal, errorSignal);
    this.updateCorrelationBuffers(nearEndSignal, farEndSignal);
    
    const isDoubleTalk = this.detectDoubleTalk();
    this.updateState(isDoubleTalk);
    
    // Return true if adaptation should be enabled
    return this.state !== TalkState.DOUBLE_TALK && this.state !== TalkState.HOLD;
  }

  private updatePowerEstimates(
    nearEnd: Float32Array,
    farEnd: Float32Array,
    _error: Float32Array
  ): void {
    const alpha = 0.95; // Smoothing factor
    
    // Calculate block powers
    let nearPower = 0;
    let farPower = 0;
    let crossPower = 0;
    
    for (let i = 0; i < nearEnd.length; i++) {
      nearPower += nearEnd[i] * nearEnd[i];
      farPower += farEnd[i] * farEnd[i];
      crossPower += nearEnd[i] * farEnd[i];
    }
    
    // Normalize by block size
    nearPower /= nearEnd.length;
    farPower /= farEnd.length;
    crossPower /= nearEnd.length;
    
    // Update running estimates
    this.nearEndPower = alpha * this.nearEndPower + (1 - alpha) * nearPower;
    this.farEndPower = alpha * this.farEndPower + (1 - alpha) * farPower;
    this.crossPower = alpha * this.crossPower + (1 - alpha) * crossPower;
  }

  private updateCorrelationBuffers(nearEnd: Float32Array, farEnd: Float32Array): void {
    const { windowSize } = this.config;
    
    for (let i = 0; i < nearEnd.length; i++) {
      this.nearEndBuffer[this.bufferIndex] = nearEnd[i];
      this.farEndBuffer[this.bufferIndex] = farEnd[i];
      this.bufferIndex = (this.bufferIndex + 1) % windowSize;
    }
  }

  private detectDoubleTalk(): boolean {
    // Geigel Algorithm: Check power ratio
    const powerRatio = this.nearEndPower / (this.farEndPower + 1e-10);
    const powerTest = powerRatio > this.config.powerRatioThreshold;
    
    // Cross-correlation test
    const correlation = this.calculateCorrelation();
    const correlationTest = Math.abs(correlation) < this.config.correlationThreshold;
    
    // Double-talk detected if either test is positive
    return powerTest || correlationTest;
  }

  private calculateCorrelation(): number {
    const { windowSize } = this.config;
    
    // Calculate normalized cross-correlation
    let correlation = 0;
    let nearSum = 0;
    let farSum = 0;
    let nearSumSq = 0;
    let farSumSq = 0;
    
    for (let i = 0; i < windowSize; i++) {
      const nearSample = this.nearEndBuffer[i];
      const farSample = this.farEndBuffer[i];
      
      correlation += nearSample * farSample;
      nearSum += nearSample;
      farSum += farSample;
      nearSumSq += nearSample * nearSample;
      farSumSq += farSample * farSample;
    }
    
    // Normalize correlation
    const nearMean = nearSum / windowSize;
    const farMean = farSum / windowSize;
    const nearVar = nearSumSq / windowSize - nearMean * nearMean;
    const farVar = farSumSq / windowSize - farMean * farMean;
    
    const denominator = Math.sqrt(nearVar * farVar);
    return denominator > 1e-10 ? 
           (correlation / windowSize - nearMean * farMean) / denominator : 0;
  }

  private updateState(isDoubleTalk: boolean): void {
    switch (this.state) {
      case TalkState.IDLE:
        if (this.farEndPower > 1e-6) {
          this.state = isDoubleTalk ? TalkState.DOUBLE_TALK : TalkState.SINGLE_TALK;
        }
        break;
        
      case TalkState.SINGLE_TALK:
        if (isDoubleTalk) {
          this.state = TalkState.DOUBLE_TALK;
          this.hangoverCounter = this.config.hangoverTime;
        } else if (this.farEndPower < 1e-7) {
          this.state = TalkState.IDLE;
        }
        break;
        
      case TalkState.DOUBLE_TALK:
        if (!isDoubleTalk) {
          this.state = TalkState.HOLD;
          this.hangoverCounter = this.config.hangoverTime;
        }
        break;
        
      case TalkState.HOLD:
        this.hangoverCounter--;
        if (this.hangoverCounter <= 0) {
          this.state = this.farEndPower > 1e-7 ? TalkState.SINGLE_TALK : TalkState.IDLE;
        } else if (isDoubleTalk) {
          this.state = TalkState.DOUBLE_TALK;
        }
        break;
    }
  }

  /**
   * Get current detection state
   */
  public getState(): TalkState {
    return this.state;
  }

  /**
   * Get detection metrics
   */
  public getMetrics() {
    const powerRatio = this.nearEndPower / (this.farEndPower + 1e-10);
    const correlation = this.calculateCorrelation();
    
    return {
      state: this.state,
      nearEndPower: this.nearEndPower,
      farEndPower: this.farEndPower,
      powerRatio: powerRatio,
      correlation: correlation,
      hangoverCounter: this.hangoverCounter,
      detectionAccuracy: this.detectionAccuracy
    };
  }

  /**
   * Reset detector state
   */
  public reset(): void {
    this.state = TalkState.IDLE;
    this.hangoverCounter = 0;
    this.nearEndPower = 1e-10;
    this.farEndPower = 1e-10;
    this.crossPower = 1e-10;
    this.initializeBuffers();
  }

  /**
   * Update configuration
   */
  public updateConfig(newConfig: Partial<DoubleTalkConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }
}

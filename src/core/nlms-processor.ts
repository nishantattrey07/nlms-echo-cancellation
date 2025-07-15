/**
 * NLMS (Normalized Least Mean Squares) Adaptive Filter
 * Core echo cancellation algorithm implementation
 * 
 * This implements the NLMS algorithm which is the industry standard for
 * acoustic echo cancellation in real-time communication systems.
 */

export interface NLMSConfig {
  filterLength: number;      // Number of filter taps (512-1024 typical)
  stepSize: number;          // Learning rate μ (0.01-0.5)
  regularization: number;    // Regularization parameter δ (1e-6)
  leakageFactor: number;     // Weight leakage factor (0.99999)
}

export class NLMSProcessor {
  private config: NLMSConfig;
  private weights!: Float32Array;          // Adaptive filter weights
  private delayLine!: Float32Array;        // Reference signal delay line
  private powerEstimate!: number;          // Input power estimate
  private writeIndex!: number;             // Circular buffer write index
  
  // Performance metrics
  private echoReturnLoss: number = 0;
  private convergenceTime: number = 0;
  private lastUpdateTime: number = 0;

  constructor(config: Partial<NLMSConfig> = {}) {
    // Default configuration optimized for speech at 48kHz
    this.config = {
      filterLength: 512,        // ~10ms at 48kHz
      stepSize: 0.1,           // Conservative starting point
      regularization: 1e-6,     // Numerical stability
      leakageFactor: 0.99999,   // Prevent weight drift
      ...config
    };

    this.initializeFilter();
  }

  private initializeFilter(): void {
    const { filterLength } = this.config;
    
    // Initialize filter weights to zero
    this.weights = new Float32Array(filterLength);
    
    // Initialize delay line (circular buffer for reference signal)
    this.delayLine = new Float32Array(filterLength);
    
    this.powerEstimate = 1e-6; // Small initial value
    this.writeIndex = 0;
    this.lastUpdateTime = Date.now();
  }

  /**
   * Process a block of samples
   * @param referenceSignal Far-end signal (system audio)
   * @param microphoneSignal Near-end signal (mic + echo)
   * @param enableAdaptation Whether to update filter weights
   * @returns Processed signal with echo removed
   */
  public process(
    referenceSignal: Float32Array,
    microphoneSignal: Float32Array,
    enableAdaptation: boolean = true
  ): Float32Array {
    const blockSize = referenceSignal.length;
    const output = new Float32Array(blockSize);
    
    for (let i = 0; i < blockSize; i++) {
      // Add reference sample to delay line
      this.delayLine[this.writeIndex] = referenceSignal[i];
      
      // Calculate filter output (estimated echo)
      const estimatedEcho = this.calculateFilterOutput();
      
      // Error signal = microphone - estimated echo
      const errorSignal = microphoneSignal[i] - estimatedEcho;
      output[i] = errorSignal;
      
      if (enableAdaptation) {
        this.updateWeights(errorSignal);
      }
      
      // Update circular buffer index
      this.writeIndex = (this.writeIndex + 1) % this.config.filterLength;
    }
    
    this.updateMetrics();
    return output;
  }

  private calculateFilterOutput(): number {
    let output = 0;
    const { filterLength } = this.config;
    
    // Convolution: y(n) = w^T * x(n)
    for (let i = 0; i < filterLength; i++) {
      const delayIndex = (this.writeIndex - i + filterLength) % filterLength;
      output += this.weights[i] * this.delayLine[delayIndex];
    }
    
    return output;
  }

  private updateWeights(errorSignal: number): void {
    const { filterLength, stepSize, regularization, leakageFactor } = this.config;
    
    // Update input power estimate
    const currentSample = this.delayLine[this.writeIndex];
    this.powerEstimate = 0.95 * this.powerEstimate + 0.05 * currentSample * currentSample;
    
    // Normalized step size: μ / (x^T * x + δ)
    const normalizedStepSize = stepSize / (this.powerEstimate * filterLength + regularization);
    
    // Update weights: w(n+1) = λ * w(n) + μ * e(n) * x(n)
    for (let i = 0; i < filterLength; i++) {
      const delayIndex = (this.writeIndex - i + filterLength) % filterLength;
      const refSample = this.delayLine[delayIndex];
      
      // NLMS weight update with leakage
      this.weights[i] = leakageFactor * this.weights[i] + 
                       normalizedStepSize * errorSignal * refSample;
    }
  }

  private updateMetrics(): void {
    const now = Date.now();
    if (now - this.lastUpdateTime > 100) { // Update every 100ms
      // Calculate Echo Return Loss Enhancement (ERLE)
      this.echoReturnLoss = this.calculateERLE();
      this.lastUpdateTime = now;
    }
  }

  private calculateERLE(): number {
    // Simplified ERLE calculation
    // In production, this would use running averages of signal powers
    const weightMagnitude = Math.sqrt(
      this.weights.reduce((sum, w) => sum + w * w, 0)
    );
    
    // Convert to dB scale (rough approximation)
    return Math.max(0, 20 * Math.log10(weightMagnitude + 1e-10));
  }

  /**
   * Reset the adaptive filter
   */
  public reset(): void {
    this.initializeFilter();
  }

  /**
   * Get current performance metrics
   */
  public getMetrics() {
    return {
      echoReturnLoss: this.echoReturnLoss,
      convergenceTime: this.convergenceTime,
      powerEstimate: this.powerEstimate,
      filterNorm: Math.sqrt(this.weights.reduce((sum, w) => sum + w * w, 0))
    };
  }

  /**
   * Update configuration parameters
   */
  public updateConfig(newConfig: Partial<NLMSConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Get current filter weights (for visualization)
   */
  public getWeights(): Float32Array {
    return new Float32Array(this.weights);
  }
}

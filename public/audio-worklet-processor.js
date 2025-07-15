/**
 * AudioWorklet Processor for Real-Time Echo Cancellation
 * Replaces deprecated ScriptProcessorNode with modern AudioWorkletNode
 */

class EchoCancellationProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    // Initialize processor state
    this.sampleRate = sampleRate;
    this.blockSize = 128; // AudioWorklet uses 128 sample blocks by default
    this.isProcessing = false;

    // Circular buffers for audio history
    this.microphoneBuffer = new Float32Array(8192); // 170ms at 48kHz
    this.systemAudioBuffer = new Float32Array(8192);
    this.bufferIndex = 0;

    // NLMS filter parameters
    this.filterLength = 512; // 10.6ms at 48kHz
    this.adaptiveFilter = new Float32Array(this.filterLength);
    this.stepSize = 0.1;
    this.regularization = 1e-6;

    // Double-talk detection
    this.micPowerHistory = new Float32Array(64);
    this.echoPowerHistory = new Float32Array(64);
    this.powerIndex = 0;
    this.doubleTalkThreshold = 0.5;

    // Performance metrics
    this.processedSamples = 0;
    this.erleSum = 0;
    this.erleCount = 0;

    // Listen for configuration messages
    this.port.onmessage = (event) => {
      this.handleMessage(event.data);
    };

    console.log('EchoCancellationProcessor initialized:', {
      sampleRate: this.sampleRate,
      blockSize: this.blockSize,
      filterLength: this.filterLength
    });

    // Debug: Log first few blocks to verify audio routing
    this.debugBlockCount = 0;
  }

  handleMessage(data) {
    switch (data.type) {
      case 'start':
        this.isProcessing = true;
        this.port.postMessage({ type: 'started' });
        break;

      case 'stop':
        this.isProcessing = false;
        this.port.postMessage({ type: 'stopped' });
        break;

      case 'getMetrics':
        const avgErle = this.erleCount > 0 ? this.erleSum / this.erleCount : 0;
        this.port.postMessage({
          type: 'metrics',
          data: {
            processedSamples: this.processedSamples,
            averageERLE: avgErle,
            isProcessing: this.isProcessing
          }
        });
        break;

      case 'reset':
        this.reset();
        break;
    }
  }

  reset() {
    // Reset all buffers and state
    this.adaptiveFilter.fill(0);
    this.microphoneBuffer.fill(0);
    this.systemAudioBuffer.fill(0);
    this.micPowerHistory.fill(0);
    this.echoPowerHistory.fill(0);
    this.bufferIndex = 0;
    this.powerIndex = 0;
    this.processedSamples = 0;
    this.erleSum = 0;
    this.erleCount = 0;

    console.log('EchoCancellationProcessor reset');
  }

  process(inputs, outputs, parameters) {
    if (!this.isProcessing) {
      // Pass through microphone input if not processing
      if (inputs[0] && inputs[0][0] && outputs[0] && outputs[0][0]) {
        outputs[0][0].set(inputs[0][0]); // Pass through left channel (microphone)
      }
      return true;
    }

    // Get input channels from the merged stereo input
    const input = inputs[0];
    if (!input || input.length < 2) {
      // If we don't have stereo input, just output silence
      if (outputs[0] && outputs[0][0]) {
        outputs[0][0].fill(0);
      }
      return true;
    }

    const microphoneInput = input[0]; // Left channel = microphone
    const systemAudioInput = input[1]; // Right channel = system audio
    const output = outputs[0] && outputs[0][0] ? outputs[0][0] : null;

    if (!microphoneInput || !systemAudioInput || !output) {
      // If we don't have both inputs, just pass through microphone
      if (microphoneInput && output) {
        output.set(microphoneInput);
      } else if (output) {
        output.fill(0);
      }
      return true;
    }

    const blockSize = microphoneInput.length;

    // Debug: Log audio levels for first few blocks
    if (this.debugBlockCount < 10) {
      const micLevel = Math.sqrt(microphoneInput.reduce((sum, sample) => sum + sample * sample, 0) / blockSize);
      const sysLevel = Math.sqrt(systemAudioInput.reduce((sum, sample) => sum + sample * sample, 0) / blockSize);
      console.log(`Block ${this.debugBlockCount}: Mic RMS=${micLevel.toFixed(4)}, Sys RMS=${sysLevel.toFixed(4)}`);
      this.debugBlockCount++;
    }

    // Process each sample in the block
    for (let i = 0; i < blockSize; i++) {
      const micSample = microphoneInput[i];
      const systemSample = systemAudioInput[i];

      // Store samples in circular buffers
      this.microphoneBuffer[this.bufferIndex] = micSample;
      this.systemAudioBuffer[this.bufferIndex] = systemSample;

      // Perform echo cancellation
      const cleanSample = this.processSample(micSample, systemSample);
      output[i] = cleanSample;

      // Update buffer index
      this.bufferIndex = (this.bufferIndex + 1) % this.microphoneBuffer.length;
    }

    this.processedSamples += blockSize;

    // Send metrics periodically
    if (this.processedSamples % 4800 === 0) { // Every 0.1 seconds at 48kHz
      const avgErle = this.erleCount > 0 ? this.erleSum / this.erleCount : 0;
      this.port.postMessage({
        type: 'metrics',
        data: {
          processedSamples: this.processedSamples,
          averageERLE: avgErle,
          isProcessing: this.isProcessing
        }
      });
    }

    return true;
  }

  processSample(micSample, systemSample) {
    // Enhanced NLMS Adaptive Filtering Algorithm

    // 1. Get reference signal history (system audio) - this is what causes the echo
    const referenceVector = new Float32Array(this.filterLength);
    for (let i = 0; i < this.filterLength; i++) {
      const index = (this.bufferIndex - i + this.systemAudioBuffer.length) % this.systemAudioBuffer.length;
      referenceVector[i] = this.systemAudioBuffer[index];
    }

    // 2. Calculate estimated echo using adaptive filter
    let estimatedEcho = 0;
    for (let i = 0; i < this.filterLength; i++) {
      estimatedEcho += this.adaptiveFilter[i] * referenceVector[i];
    }

    // 3. Calculate error signal (what we want to keep - original voice)
    const errorSignal = micSample - estimatedEcho;

    // 4. Enhanced double-talk detection
    const micPower = micSample * micSample;
    const echoPower = estimatedEcho * estimatedEcho;
    const systemPower = systemSample * systemSample;

    this.micPowerHistory[this.powerIndex] = micPower;
    this.echoPowerHistory[this.powerIndex] = echoPower;
    this.powerIndex = (this.powerIndex + 1) % this.micPowerHistory.length;

    // Calculate average powers over window
    let avgMicPower = 0;
    let avgEchoPower = 0;
    for (let i = 0; i < this.micPowerHistory.length; i++) {
      avgMicPower += this.micPowerHistory[i];
      avgEchoPower += this.echoPowerHistory[i];
    }
    avgMicPower /= this.micPowerHistory.length;
    avgEchoPower /= this.echoPowerHistory.length;

    // Improved double-talk detection: 
    // Don't adapt when near-end speech is much stronger than echo
    const isDoubleTalk = avgMicPower > this.doubleTalkThreshold * (avgEchoPower + systemPower + 1e-10);

    // 5. Update adaptive filter (NLMS algorithm) - only when no double-talk
    if (!isDoubleTalk && systemPower > 1e-6) { // Only adapt when system audio is playing
      // Calculate reference signal power for normalization
      let refPower = 0;
      for (let i = 0; i < this.filterLength; i++) {
        refPower += referenceVector[i] * referenceVector[i];
      }
      refPower += this.regularization; // Prevent division by zero

      // NLMS weight update
      const normalizedStepSize = this.stepSize / refPower;
      for (let i = 0; i < this.filterLength; i++) {
        this.adaptiveFilter[i] += normalizedStepSize * errorSignal * referenceVector[i];

        // Apply leakage to prevent filter divergence
        this.adaptiveFilter[i] *= 0.9999;
      }
    }

    // 6. Calculate ERLE (Echo Return Loss Enhancement) for monitoring
    if (Math.abs(micSample) > 1e-6 && Math.abs(estimatedEcho) > 1e-6) {
      const erle = 20 * Math.log10(Math.abs(micSample) / Math.max(Math.abs(errorSignal), 1e-6));
      this.erleSum += Math.max(0, Math.min(60, erle)); // Clamp ERLE between 0-60 dB
      this.erleCount++;
    }

    // 7. Apply post-processing: spectral subtraction for residual echo
    let processedSignal = errorSignal;

    // Simple noise gate: suppress very quiet signals that might be residual echo
    const noiseFloor = 0.001; // -60dB
    if (Math.abs(processedSignal) < noiseFloor && systemPower > 1e-6) {
      processedSignal *= 0.1; // Suppress potential residual echo
    }

    // Soft limiting to prevent clipping
    const maxAmplitude = 0.95;
    if (Math.abs(processedSignal) > maxAmplitude) {
      processedSignal = Math.sign(processedSignal) * maxAmplitude;
    }

    return processedSignal;
  }
}

// Register the processor
registerProcessor('echo-cancellation-processor', EchoCancellationProcessor);

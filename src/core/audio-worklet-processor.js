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
            return true;
        }

        // Get input channels
        const microphoneInput = inputs[0] ? inputs[0][0] : null;
        const systemAudioInput = inputs[1] ? inputs[1][0] : null;
        const output = outputs[0][0];

        if (!microphoneInput || !systemAudioInput || !output) {
            return true;
        }

        const blockSize = microphoneInput.length;

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

        return true;
    }

    processSample(micSample, systemSample) {
        // NLMS Adaptive Filtering Algorithm

        // 1. Get reference signal history (system audio)
        const referenceVector = new Float32Array(this.filterLength);
        for (let i = 0; i < this.filterLength; i++) {
            const index = (this.bufferIndex - i + this.systemAudioBuffer.length) % this.systemAudioBuffer.length;
            referenceVector[i] = this.systemAudioBuffer[index];
        }

        // 2. Calculate estimated echo
        let estimatedEcho = 0;
        for (let i = 0; i < this.filterLength; i++) {
            estimatedEcho += this.adaptiveFilter[i] * referenceVector[i];
        }

        // 3. Calculate error signal (residual echo)
        const errorSignal = micSample - estimatedEcho;

        // 4. Double-talk detection
        const micPower = micSample * micSample;
        const echoPower = estimatedEcho * estimatedEcho;

        this.micPowerHistory[this.powerIndex] = micPower;
        this.echoPowerHistory[this.powerIndex] = echoPower;
        this.powerIndex = (this.powerIndex + 1) % this.micPowerHistory.length;

        // Calculate average powers
        let avgMicPower = 0;
        let avgEchoPower = 0;
        for (let i = 0; i < this.micPowerHistory.length; i++) {
            avgMicPower += this.micPowerHistory[i];
            avgEchoPower += this.echoPowerHistory[i];
        }
        avgMicPower /= this.micPowerHistory.length;
        avgEchoPower /= this.echoPowerHistory.length;

        // Detect double-talk (both near-end and far-end speech present)
        const isDoubleTalk = avgMicPower > this.doubleTalkThreshold * avgEchoPower;

        // 5. Update adaptive filter (only if not double-talk)
        if (!isDoubleTalk) {
            // Calculate reference signal power
            let refPower = 0;
            for (let i = 0; i < this.filterLength; i++) {
                refPower += referenceVector[i] * referenceVector[i];
            }
            refPower += this.regularization;

            // NLMS update
            const normalizedStepSize = this.stepSize / refPower;
            for (let i = 0; i < this.filterLength; i++) {
                this.adaptiveFilter[i] += normalizedStepSize * errorSignal * referenceVector[i];
            }
        }

        // 6. Calculate ERLE (Echo Return Loss Enhancement)
        if (Math.abs(micSample) > 1e-6) {
            const erle = 20 * Math.log10(Math.abs(micSample) / Math.max(Math.abs(errorSignal), 1e-6));
            this.erleSum += erle;
            this.erleCount++;
        }

        // 7. Apply spectral suppression (simple noise gate)
        const suppressionFactor = Math.min(1.0, Math.max(0.1, Math.abs(errorSignal) / Math.max(Math.abs(micSample), 1e-6)));

        return errorSignal * suppressionFactor;
    }
}

// Register the processor
registerProcessor('echo-cancellation-processor', EchoCancellationProcessor);

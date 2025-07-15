/**
 * Echo Cancellation Demo Application
 * Main entry point for the real-time echo cancellation system
 */

import { DoubleTalkDetector } from './core/double-talk-detector.js';
import { NLMSProcessor } from './core/nlms-processor.js';
import { AudioPlayer } from './demo/audio-player.js';
import { AudioRecorder, type RecordedAudio } from './demo/audio-recorder.js';
import { ParallelRecordingSystem, type ParallelRecordingResult } from './demo/parallel-recording-system.js';
import { AudioVisualizer } from './demo/visualizer.js';
import './style.css';

export interface EchoCancellerConfig {
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

export class EchoCancellationSystem {
  private audioContext!: AudioContext;
  private microphoneSource!: MediaStreamAudioSourceNode;
  private systemAudioSource!: MediaStreamAudioSourceNode;
  
  private nlmsProcessor: NLMSProcessor;
  private doubleTalkDetector: DoubleTalkDetector;
  
  private config: EchoCancellerConfig;
  private isProcessing: boolean = false;

  constructor(config: Partial<EchoCancellerConfig> = {}) {
    this.config = {
      sampleRate: 48000,
      blockSize: 128,
      ...config
    };

    // Initialize audio processing components
    this.nlmsProcessor = new NLMSProcessor(this.config.nlmsConfig);
    this.doubleTalkDetector = new DoubleTalkDetector(this.config.doubleTalkConfig);
  }

  /**
   * Initialize the audio context and request permissions
   */
  public async initialize(): Promise<void> {
    try {
      // Create audio context
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: this.config.sampleRate,
        latencyHint: 'interactive'
      });

      // Resume context if suspended
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      console.log('Audio context initialized:', {
        sampleRate: this.audioContext.sampleRate,
        state: this.audioContext.state,
        baseLatency: this.audioContext.baseLatency
      });

    } catch (error) {
      console.error('Failed to initialize audio context:', error);
      throw error;
    }
  }

  /**
   * Start capturing microphone and system audio
   */
  public async startCapture(): Promise<void> {
    try {
      // Request microphone access
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,  // Disable browser EC
          noiseSuppression: false,  // Disable browser NS
          autoGainControl: false,   // Disable browser AGC
          sampleRate: this.config.sampleRate,
          channelCount: 1
        }
      });

      // Request system audio via screen capture
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: false,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: this.config.sampleRate
        }
      });

      // Create audio source nodes
      this.microphoneSource = this.audioContext.createMediaStreamSource(micStream);
      this.systemAudioSource = this.audioContext.createMediaStreamSource(displayStream);

      console.log('Audio streams captured successfully');
      
      // Start processing
      await this.startProcessing();

    } catch (error) {
      console.error('Failed to capture audio streams:', error);
      throw error;
    }
  }

  /**
   * Start real-time audio processing (simplified version without worklet)
   */
  private async startProcessing(): Promise<void> {
    try {
      // For now, we'll use ScriptProcessor for demo purposes
      // In production, AudioWorklet is preferred
      const scriptProcessor = this.audioContext.createScriptProcessor(this.config.blockSize, 2, 1);
      
      scriptProcessor.onaudioprocess = (event) => {
        const micInput = event.inputBuffer.getChannelData(0);
        const sysInput = event.inputBuffer.getChannelData(1);
        const output = event.outputBuffer.getChannelData(0);
        
        // Process the audio block
        const processed = this.processBlock(
          new Float32Array(micInput),
          new Float32Array(sysInput)
        );
        
        // Copy to output
        output.set(processed);
      };

      // Connect audio sources
      this.microphoneSource.connect(scriptProcessor);
      this.systemAudioSource.connect(scriptProcessor);
      scriptProcessor.connect(this.audioContext.destination);

      this.isProcessing = true;
      console.log('Real-time processing started');

    } catch (error) {
      console.error('Failed to start processing:', error);
      throw error;
    }
  }

  /**
   * Process audio block
   */
  public processBlock(
    microphoneData: Float32Array,
    systemAudioData: Float32Array
  ): Float32Array {
    // Detect double-talk condition
    const errorSignal = new Float32Array(microphoneData.length);
    const enableAdaptation = this.doubleTalkDetector.process(
      microphoneData,
      systemAudioData,
      errorSignal
    );

    // Apply NLMS echo cancellation
    const processedAudio = this.nlmsProcessor.process(
      systemAudioData,
      microphoneData,
      enableAdaptation
    );

    return processedAudio;
  }

  /**
   * Get current system metrics
   */
  public getMetrics() {
    return {
      nlms: this.nlmsProcessor.getMetrics(),
      doubleTalk: this.doubleTalkDetector.getMetrics(),
      isProcessing: this.isProcessing,
      sampleRate: this.config.sampleRate,
      blockSize: this.config.blockSize
    };
  }

  /**
   * Stop processing
   */
  public async stop(): Promise<void> {
    this.isProcessing = false;
    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close();
    }
  }
}

// Demo UI Implementation
class EchoCancellationDemo {
  private system: EchoCancellationSystem;
  private recorder: AudioRecorder;
  private player: AudioPlayer;
  private visualizer: AudioVisualizer | null = null;
  
  // Phase 2: Parallel recording system
  private parallelRecorder: ParallelRecordingSystem;
  
  // Recording states
  private beforeAudio: RecordedAudio | null = null;  // Contaminated audio
  private afterAudio: {
    cleanMicrophone: Float32Array;
    cleanSystem: Float32Array;
    sampleRate: number;
    duration: number;
  } | null = null;  // Clean separated streams
  
  // Phase 2: Parallel recording result
  private parallelRecordingResult: ParallelRecordingResult | null = null;
  
  // AFTER processing state
  private afterProcessingState: {
    isProcessing: boolean;
    cleanMicBuffer: Float32Array[];
    cleanSysBuffer: Float32Array[];
    startTime: number;
    intervalId: number | null;
  } = {
    isProcessing: false,
    cleanMicBuffer: [],
    cleanSysBuffer: [],
    startTime: 0,
    intervalId: null
  };

  constructor() {
    this.system = new EchoCancellationSystem({
      sampleRate: 48000,
      blockSize: 128,
      nlmsConfig: {
        filterLength: 512,
        stepSize: 0.1
      }
    });

    this.recorder = new AudioRecorder({
      sampleRate: 48000,
      maxDuration: 30
    });

    this.player = new AudioPlayer();

    // Initialize Phase 2: Parallel recording system
    this.parallelRecorder = new ParallelRecordingSystem({
      sampleRate: 48000,
      maxDuration: 30,
      recordingBlockSize: 4096
    });

    // Create basic UI for Phase 1 testing
    this.createPhase1TestUI();

    // Initialize Phase 1: Audio capture foundation
    this.initializePhase1().catch(error => {
      console.error('Phase 1 initialization failed:', error);
      this.showPhase1Error(error);
    });
  }

  /**
   * Phase 1: Initialize audio capture foundation with compatibility checking
   */
  private async initializePhase1(): Promise<void> {
    console.log('🎯 Phase 1: Initializing Audio Capture Foundation');
    
    try {
      // Step 1: Check browser compatibility
      const compatibility = await this.recorder.checkBrowserCompatibility();
      console.log('Browser compatibility check:', compatibility);
      
      if (!compatibility.compatible) {
        console.warn('⚠️ Browser compatibility issues detected:', compatibility.issues);
        this.showCompatibilityWarning(compatibility);
      } else {
        console.log('✅ Browser fully compatible');
      }

      // Step 2: Initialize audio recorder
      await this.recorder.initialize();
      console.log('✅ Audio recorder initialized');

      // Step 3: Get audio device information
      const deviceInfo = await this.recorder.getAudioDeviceInfo();
      console.log('Audio devices:', deviceInfo);
      
      if (deviceInfo.inputs.length === 0) {
        throw new Error('No audio input devices found');
      }

      // Step 4: Update UI with Phase 1 status
      this.updatePhase1Status('ready', 'Audio capture foundation ready');
      
      console.log('🎉 Phase 1 initialization complete!');
      
    } catch (error) {
      console.error('❌ Phase 1 initialization failed:', error);
      this.updatePhase1Status('error', `Phase 1 failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  /**
   * Update Phase 1 status in the UI
   */
  private updatePhase1Status(status: 'ready' | 'error' | 'testing', message: string): void {
    // Add status indicator to UI
    let statusElement = document.getElementById('phase1-status');
    if (!statusElement) {
      statusElement = document.createElement('div');
      statusElement.id = 'phase1-status';
      statusElement.style.cssText = `
        position: fixed;
        top: 10px;
        right: 10px;
        background: rgba(0,0,0,0.8);
        color: white;
        padding: 10px;
        border-radius: 5px;
        font-family: monospace;
        font-size: 12px;
        max-width: 300px;
        z-index: 1000;
        border-left: 4px solid ${status === 'ready' ? '#4ecdc4' : status === 'error' ? '#ff6b6b' : '#ffa726'};
      `;
      document.body.appendChild(statusElement);
    }
    
    const icon = status === 'ready' ? '✅' : status === 'error' ? '❌' : '🔄';
    statusElement.innerHTML = `${icon} <strong>Phase 1:</strong><br>${message}`;
  }

  /**
   * Show compatibility warning with recommendations
   */
  private showCompatibilityWarning(compatibility: any): void {
    const warnings = compatibility.issues.concat(compatibility.recommendations);
    console.warn('Browser compatibility issues:', warnings);
    
    // Show in UI
    const warningElement = document.createElement('div');
    warningElement.style.cssText = `
      position: fixed;
      top: 50px;
      left: 50%;
      transform: translateX(-50%);
      background: #fff3cd;
      border: 1px solid #ffeeba;
      color: #856404;
      padding: 15px;
      border-radius: 5px;
      max-width: 500px;
      z-index: 1001;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    `;
    
    warningElement.innerHTML = `
      <h4>⚠️ Browser Compatibility Notice</h4>
      <ul>
        ${warnings.map((w: string) => `<li>${w}</li>`).join('')}
      </ul>
      <button onclick="this.parentElement.remove()" style="margin-top: 10px; padding: 5px 10px;">Got it</button>
    `;
    
    document.body.appendChild(warningElement);
    
    // Auto-remove after 10 seconds
    setTimeout(() => {
      if (warningElement.parentElement) {
        warningElement.remove();
      }
    }, 10000);
  }

  /**
   * Show Phase 1 error with guidance
   */
  private showPhase1Error(error: any): void {
    console.error('Phase 1 Error:', error);
    
    const errorElement = document.createElement('div');
    errorElement.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: #f8d7da;
      border: 1px solid #f5c6cb;
      color: #721c24;
      padding: 20px;
      border-radius: 5px;
      max-width: 600px;
      z-index: 1002;
      box-shadow: 0 4px 20px rgba(0,0,0,0.2);
    `;
    
    errorElement.innerHTML = `
      <h3>❌ Phase 1 Initialization Failed</h3>
      <p><strong>Error:</strong> ${error instanceof Error ? error.message : 'Unknown error'}</p>
      <h4>Common Solutions:</h4>
      <ul>
        <li>Ensure you're using Chrome/Edge browser</li>
        <li>Check that you're on HTTPS or localhost</li>
        <li>Grant microphone permissions when prompted</li>
        <li>Refresh the page and try again</li>
      </ul>
      <button onclick="this.parentElement.remove(); location.reload()" 
              style="margin-top: 15px; padding: 8px 15px; background: #dc3545; color: white; border: none; border-radius: 3px;">
        Reload Page
      </button>
    `;
    
    document.body.appendChild(errorElement);
  }

  /**
   * Phase 1 Testing: Test enhanced audio capture
   */
  public async testPhase1AudioCapture(): Promise<void> {
    console.log('🧪 Starting Phase 1 Audio Capture Test');
    
    try {
      // Test microphone capture
      console.log('Testing microphone access...');
      const micStream = await this.recorder.requestMicrophoneAccess();
      console.log('✅ Microphone capture successful');

      // Test system audio capture
      console.log('Testing system audio access...');
      const sysStream = await this.recorder.requestSystemAudioAccess();
      console.log('✅ System audio capture initialized');

      // Validate system audio setup
      console.log('Validating system audio setup...');
      const validation = await this.recorder.validateSystemAudioSetup();
      console.log('System audio validation:', validation);

      if (validation.success) {
        console.log('🎉 Phase 1 test PASSED - All audio capture working!');
        this.updatePhase1Status('ready', 'Phase 1 test PASSED - All audio capture working!');
      } else {
        console.log('⚠️ Phase 1 test PARTIAL - System audio issues detected');
        this.updatePhase1Status('testing', `Phase 1 PARTIAL: ${validation.guidance.join(', ')}`);
        
        // Show detailed guidance
        if (validation.nextSteps.length > 0) {
          console.log('Next steps:', validation.nextSteps);
          alert(`System Audio Setup Needed:\n\n${validation.nextSteps.join('\n')}`);
        }
      }

      // Clean up test streams
      micStream.getTracks().forEach(track => track.stop());
      sysStream.getTracks().forEach(track => track.stop());

    } catch (error) {
      console.error('❌ Phase 1 test FAILED:', error);
      this.updatePhase1Status('error', `Phase 1 test FAILED: ${error instanceof Error ? error.message : 'Unknown error'}`);
      
      // Show user-friendly error guidance
      alert(`Phase 1 Test Failed:\n\n${error instanceof Error ? error.message : 'Unknown error'}\n\nPlease check:\n- Browser permissions\n- HTTPS/localhost setup\n- Chrome/Edge browser usage`);
    }
  }

  /**
   * Create Phase 1 test UI
   */
  private createPhase1TestUI(): void {
    const app = document.getElementById('app');
    if (!app) return;

    app.innerHTML = `
      <div style="max-width: 800px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif;">
        <h1 style="text-align: center; color: #333; margin-bottom: 30px;">
          🎤 Echo Cancellation Demo - Phase 1 Testing
        </h1>
        
        <div style="background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 8px; padding: 20px; margin-bottom: 20px;">
          <h2 style="color: #495057; margin-top: 0;">Phase 1: Audio Capture Foundation</h2>
          <p style="color: #6c757d; margin-bottom: 15px;">
            Testing enhanced browser audio capture with robust system audio handling and compatibility checking.
          </p>
          
          <button id="test-phase1-btn" style="
            background: #007bff; 
            color: white; 
            border: none; 
            padding: 12px 24px; 
            border-radius: 6px; 
            font-size: 16px; 
            cursor: pointer;
            margin-right: 10px;
          ">
            🧪 Test Phase 1 Audio Capture
          </button>
          
          <button id="check-compatibility-btn" style="
            background: #28a745; 
            color: white; 
            border: none; 
            padding: 12px 24px; 
            border-radius: 6px; 
            font-size: 16px; 
            cursor: pointer;
          ">
            🔍 Check Browser Compatibility
          </button>
          
          <button id="test-phase2-btn" style="
            background: #dc3545; 
            color: white; 
            border: none; 
            padding: 12px 24px; 
            border-radius: 6px; 
            font-size: 16px; 
            cursor: pointer;
            margin-top: 10px;
          ">
            🚀 Test Phase 2 Real-Time Echo Cancellation
          </button>
        </div>

        <div id="test-results" style="
          background: #fff; 
          border: 1px solid #dee2e6; 
          border-radius: 8px; 
          padding: 20px; 
          min-height: 200px;
          font-family: monospace;
          white-space: pre-wrap;
          overflow-y: auto;
          display: none;
        "></div>

        <div style="margin-top: 20px; padding: 15px; background: #e7f3ff; border-left: 4px solid #007bff; border-radius: 4px;">
          <h3 style="margin-top: 0; color: #0056b3;">📋 Testing Instructions</h3>
          <ol style="color: #004085;">
            <li><strong>Check Browser Compatibility:</strong> Verify your browser supports all required features</li>
            <li><strong>Test Audio Capture:</strong> Grant microphone permission when prompted</li>
            <li><strong>System Audio Setup:</strong> When prompted for screen sharing:
              <ul>
                <li>✅ Select a tab that's playing audio (YouTube, Spotify, etc.)</li>
                <li>✅ Check "Share tab audio" checkbox</li>
                <li>✅ Click "Share"</li>
              </ul>
            </li>
            <li><strong>Review Results:</strong> Check console and status indicators for detailed feedback</li>
          </ol>
        </div>
      </div>
    `;

    // Add event listeners
    const testPhase1Btn = document.getElementById('test-phase1-btn');
    const checkCompatibilityBtn = document.getElementById('check-compatibility-btn');
    const testPhase2Btn = document.getElementById('test-phase2-btn');

    if (testPhase1Btn) {
      testPhase1Btn.addEventListener('click', () => {
        this.runPhase1Test();
      });
    }

    if (checkCompatibilityBtn) {
      checkCompatibilityBtn.addEventListener('click', () => {
        this.runCompatibilityCheck();
      });
    }

    if (testPhase2Btn) {
      testPhase2Btn.addEventListener('click', () => {
        this.runPhase2Test();
      });
    }
  }

  /**
   * Run Phase 1 test with UI feedback
   */
  private async runPhase1Test(): Promise<void> {
    const resultsDiv = document.getElementById('test-results');
    const testBtn = document.getElementById('test-phase1-btn') as HTMLButtonElement;
    
    if (resultsDiv) {
      resultsDiv.style.display = 'block';
      resultsDiv.textContent = '🔄 Starting Phase 1 Audio Capture Test...\n\n';
    }
    
    if (testBtn) {
      testBtn.disabled = true;
      testBtn.textContent = '⏳ Testing...';
    }

    try {
      await this.testPhase1AudioCapture();
      
      if (resultsDiv) {
        resultsDiv.textContent += '✅ Phase 1 test completed! Check console for detailed results.\n';
        resultsDiv.textContent += 'Open browser developer tools (F12) to see full test output.\n';
      }
    } catch (error) {
      if (resultsDiv) {
        resultsDiv.textContent += `❌ Phase 1 test failed: ${error instanceof Error ? error.message : 'Unknown error'}\n`;
      }
    } finally {
      if (testBtn) {
        testBtn.disabled = false;
        testBtn.textContent = '🧪 Test Phase 1 Audio Capture';
      }
    }
  }

  /**
   * Run compatibility check with UI feedback
   */
  private async runCompatibilityCheck(): Promise<void> {
    const resultsDiv = document.getElementById('test-results');
    const checkBtn = document.getElementById('check-compatibility-btn') as HTMLButtonElement;
    
    if (resultsDiv) {
      resultsDiv.style.display = 'block';
      resultsDiv.textContent = '🔍 Checking browser compatibility...\n\n';
    }
    
    if (checkBtn) {
      checkBtn.disabled = true;
      checkBtn.textContent = '⏳ Checking...';
    }

    try {
      const compatibility = await this.recorder.checkBrowserCompatibility();
      const deviceInfo = await this.recorder.getAudioDeviceInfo();
      
      if (resultsDiv) {
        resultsDiv.textContent += `Browser Compatibility Report:\n`;
        resultsDiv.textContent += `Compatible: ${compatibility.compatible ? '✅ Yes' : '❌ No'}\n\n`;
        
        if (compatibility.issues.length > 0) {
          resultsDiv.textContent += `Issues Found:\n`;
          compatibility.issues.forEach(issue => {
            resultsDiv.textContent += `  ⚠️ ${issue}\n`;
          });
          resultsDiv.textContent += '\n';
        }
        
        if (compatibility.recommendations.length > 0) {
          resultsDiv.textContent += `Recommendations:\n`;
          compatibility.recommendations.forEach(rec => {
            resultsDiv.textContent += `  💡 ${rec}\n`;
          });
          resultsDiv.textContent += '\n';
        }
        
        resultsDiv.textContent += `Audio Devices:\n`;
        resultsDiv.textContent += `  Input devices: ${deviceInfo.inputs.length}\n`;
        resultsDiv.textContent += `  Output devices: ${deviceInfo.outputs.length}\n`;
        resultsDiv.textContent += `  Has permissions: ${deviceInfo.hasPermissions ? '✅ Yes' : '❌ No'}\n\n`;
        
        resultsDiv.textContent += `Capabilities:\n`;
        Object.entries(compatibility.capabilities).forEach(([key, value]) => {
          resultsDiv.textContent += `  ${key}: ${value ? '✅' : '❌'} ${value}\n`;
        });
      }
    } catch (error) {
      if (resultsDiv) {
        resultsDiv.textContent += `❌ Compatibility check failed: ${error instanceof Error ? error.message : 'Unknown error'}\n`;
      }
    } finally {
      if (checkBtn) {
        checkBtn.disabled = false;
        checkBtn.textContent = '🔍 Check Browser Compatibility';
      }
    }
  }

  /**
   * Phase 2 Testing: Test real-time echo cancellation with parallel recording
   */
  public async testPhase2RealTimeProcessing(): Promise<void> {
    console.log('🚀 Starting Phase 2 Real-Time Echo Cancellation Test');
    
    try {
      // Step 1: Initialize parallel recording system
      console.log('Initializing parallel recording system...');
      await this.parallelRecorder.initialize();
      console.log('✅ Parallel recording system initialized');

      // Step 2: Get audio streams (reuse Phase 1 methods)
      console.log('Requesting audio streams...');
      const micStream = await this.recorder.requestMicrophoneAccess();
      const sysStream = await this.recorder.requestSystemAudioAccess();
      console.log('✅ Audio streams obtained');

      // Step 3: Start parallel recording (BEFORE + AFTER simultaneously)
      console.log('Starting parallel recording - capturing BEFORE and AFTER simultaneously...');
      await this.parallelRecorder.startRecording(micStream, sysStream);

      // Step 4: Show real-time status updates
      this.showRealTimeStatus();

      // Step 5: Auto-stop after 15 seconds for demo
      setTimeout(() => {
        this.stopPhase2Test();
      }, 15000);

      console.log('🎙️ Recording started! Speak while playing audio to test echo cancellation...');
      console.log('💡 The system is simultaneously recording:');
      console.log('   📹 BEFORE: Contaminated audio (mic + echo)');
      console.log('   🎯 AFTER: Real-time echo-cancelled audio');

    } catch (error) {
      console.error('❌ Phase 2 test FAILED:', error);
      this.updatePhase1Status('error', `Phase 2 test FAILED: ${error instanceof Error ? error.message : 'Unknown error'}`);
      
      // Show user-friendly error guidance
      alert(`Phase 2 Test Failed:\n\n${error instanceof Error ? error.message : 'Unknown error'}\n\nPlease ensure:\n- Phase 1 test passed\n- Microphone and system audio working\n- Sufficient browser performance`);
    }
  }

  /**
   * Stop Phase 2 test and show results
   */
  private async stopPhase2Test(): Promise<void> {
    try {
      console.log('⏹️ Stopping Phase 2 test...');
      
      // Stop parallel recording and get results
      this.parallelRecordingResult = this.parallelRecorder.stopRecording();
      
      console.log('🎉 Phase 2 test COMPLETED!');
      console.log('Results:', {
        duration: this.parallelRecordingResult.metrics.recordingDuration.toFixed(2) + 's',
        averageERLE: this.parallelRecordingResult.metrics.averageERLE.toFixed(1) + 'dB',
        maxERLE: this.parallelRecordingResult.metrics.maxERLE.toFixed(1) + 'dB',
        doubleTalkPercentage: this.parallelRecordingResult.metrics.doubleTalkPercentage.toFixed(1) + '%',
        processingLatency: this.parallelRecordingResult.metrics.processingLatency.toFixed(1) + 'ms'
      });

      // Update UI with success
      this.updatePhase1Status('ready', 
        `Phase 2 COMPLETE! ERLE: ${this.parallelRecordingResult.metrics.averageERLE.toFixed(1)}dB`
      );

      // Create comparison interface
      this.createPhase2ComparisonInterface();

    } catch (error) {
      console.error('❌ Error stopping Phase 2 test:', error);
      this.updatePhase1Status('error', 'Phase 2 test failed to complete');
    }
  }

  /**
   * Show real-time status during Phase 2 recording
   */
  private showRealTimeStatus(): void {
    const statusInterval = setInterval(() => {
      const status = this.parallelRecorder.getRecordingStatus();
      
      if (!status.isRecording) {
        clearInterval(statusInterval);
        return;
      }

      console.log(`📊 Recording Status: ${status.recordingTime.toFixed(1)}s | ` +
                 `Raw: ${status.rawBufferSizes.mixed} blocks | ` +
                 `Processed: ${status.processedBufferSizes.cleanMicrophone} blocks | ` +
                 `Latency: ${status.processingStats.averageLatency.toFixed(1)}ms`);

    }, 2000); // Update every 2 seconds
  }

  /**
   * Create Phase 2 comparison interface
   */
  private createPhase2ComparisonInterface(): void {
    if (!this.parallelRecordingResult) return;

    const app = document.getElementById('app');
    if (!app) return;

    app.innerHTML = `
      <div style="max-width: 1000px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif;">
        <h1 style="text-align: center; color: #333; margin-bottom: 30px;">
          🎯 Phase 2 Results: Real-Time Echo Cancellation
        </h1>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 30px;">
          <!-- BEFORE Section -->
          <div style="background: #fff5f5; border: 2px solid #fed7d7; border-radius: 12px; padding: 20px;">
            <h2 style="color: #c53030; margin-top: 0; text-align: center;">
              📹 BEFORE: Contaminated Audio
            </h2>
            <p style="color: #744210; text-align: center; margin-bottom: 20px;">
              Original audio with echo contamination
            </p>
            
            <button id="play-before-mixed" style="
              width: 100%; 
              background: #e53e3e; 
              color: white; 
              border: none; 
              padding: 15px; 
              border-radius: 8px; 
              font-size: 16px; 
              cursor: pointer;
              margin-bottom: 10px;
            ">
              🔊 Play Mixed (Mic + Echo)
            </button>
            
            <button id="download-before" style="
              width: 100%; 
              background: #c53030; 
              color: white; 
              border: none; 
              padding: 12px; 
              border-radius: 8px; 
              font-size: 14px; 
              cursor: pointer;
            ">
              💾 Download BEFORE Files
            </button>
          </div>

          <!-- AFTER Section -->
          <div style="background: #f0fff4; border: 2px solid #9ae6b4; border-radius: 12px; padding: 20px;">
            <h2 style="color: #2d7d32; margin-top: 0; text-align: center;">
              🎯 AFTER: Echo Cancelled
            </h2>
            <p style="color: #2d7d32; text-align: center; margin-bottom: 20px;">
              Real-time processed clean audio
            </p>
            
            <button id="play-after-clean" style="
              width: 100%; 
              background: #38a169; 
              color: white; 
              border: none; 
              padding: 15px; 
              border-radius: 8px; 
              font-size: 16px; 
              cursor: pointer;
              margin-bottom: 10px;
            ">
              🔊 Play Clean Microphone
            </button>
            
            <button id="download-after" style="
              width: 100%; 
              background: #2d7d32; 
              color: white; 
              border: none; 
              padding: 12px; 
              border-radius: 8px; 
              font-size: 14px; 
              cursor: pointer;
            ">
              💾 Download AFTER Files
            </button>
          </div>
        </div>

        <!-- Performance Metrics -->
        <div style="background: #edf2ff; border: 2px solid #bee3f8; border-radius: 12px; padding: 20px; margin-bottom: 20px;">
          <h3 style="color: #2c5aa0; margin-top: 0; text-align: center;">📊 Performance Metrics</h3>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
            <div style="text-align: center;">
              <div style="font-size: 24px; font-weight: bold; color: #2c5aa0;">
                ${this.parallelRecordingResult.metrics.averageERLE.toFixed(1)} dB
              </div>
              <div style="color: #4a5568;">Average ERLE</div>
            </div>
            <div style="text-align: center;">
              <div style="font-size: 24px; font-weight: bold; color: #2c5aa0;">
                ${this.parallelRecordingResult.metrics.maxERLE.toFixed(1)} dB
              </div>
              <div style="color: #4a5568;">Maximum ERLE</div>
            </div>
            <div style="text-align: center;">
              <div style="font-size: 24px; font-weight: bold; color: #2c5aa0;">
                ${this.parallelRecordingResult.metrics.doubleTalkPercentage.toFixed(1)}%
              </div>
              <div style="color: #4a5568;">Double-Talk Time</div>
            </div>
            <div style="text-align: center;">
              <div style="font-size: 24px; font-weight: bold; color: #2c5aa0;">
                ${this.parallelRecordingResult.metrics.processingLatency.toFixed(1)} ms
              </div>
              <div style="color: #4a5568;">Processing Latency</div>
            </div>
          </div>
        </div>

        <!-- Controls -->
        <div style="text-align: center;">
          <button id="run-phase2-again" style="
            background: #3182ce; 
            color: white; 
            border: none; 
            padding: 15px 30px; 
            border-radius: 8px; 
            font-size: 16px; 
            cursor: pointer;
            margin-right: 15px;
          ">
            🔄 Run Phase 2 Again
          </button>
          
          <button id="download-all-files" style="
            background: #805ad5; 
            color: white; 
            border: none; 
            padding: 15px 30px; 
            border-radius: 8px; 
            font-size: 16px; 
            cursor: pointer;
          ">
            📦 Download All Files
          </button>
        </div>
      </div>
    `;

    // Add event listeners for the new interface
    this.setupPhase2EventListeners();
  }

  /**
   * Setup event listeners for Phase 2 interface
   */
  private setupPhase2EventListeners(): void {
    if (!this.parallelRecordingResult) return;

    // Play buttons
    document.getElementById('play-before-mixed')?.addEventListener('click', () => {
      this.playAudioBuffer(this.parallelRecordingResult!.before.mixed, 'BEFORE Mixed Audio');
    });

    document.getElementById('play-after-clean')?.addEventListener('click', () => {
      this.playAudioBuffer(this.parallelRecordingResult!.after.cleanMicrophone, 'AFTER Clean Audio');
    });

    // Download buttons
    document.getElementById('download-before')?.addEventListener('click', () => {
      this.downloadBeforeFiles();
    });

    document.getElementById('download-after')?.addEventListener('click', () => {
      this.downloadAfterFiles();
    });

    document.getElementById('download-all-files')?.addEventListener('click', () => {
      this.parallelRecorder.downloadRecording(this.parallelRecordingResult!);
    });

    // Control buttons
    document.getElementById('run-phase2-again')?.addEventListener('click', () => {
      this.runPhase2TestAgain();
    });
  }

  /**
   * Play audio buffer
   */
  private async playAudioBuffer(audioData: Float32Array, label: string): Promise<void> {
    try {
      console.log(`▶️ Playing ${label}...`);
      
      const audioContext = new AudioContext();
      const buffer = audioContext.createBuffer(1, audioData.length, this.parallelRecordingResult!.sampleRate);
      buffer.getChannelData(0).set(audioData);
      
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContext.destination);
      source.start();
      
      console.log(`✅ Playing ${label} (${(audioData.length / this.parallelRecordingResult!.sampleRate).toFixed(1)}s)`);
      
    } catch (error) {
      console.error(`Failed to play ${label}:`, error);
      alert(`Failed to play ${label}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Download BEFORE files
   */
  private downloadBeforeFiles(): void {
    if (!this.parallelRecordingResult) return;
    
    const files = this.parallelRecorder.createWAVFiles(this.parallelRecordingResult);
    
    [
      { name: 'BEFORE_mixed_contaminated.wav', blob: files.beforeMixed },
      { name: 'BEFORE_raw_microphone.wav', blob: files.beforeMicrophone },
      { name: 'BEFORE_raw_system_audio.wav', blob: files.beforeSystemAudio }
    ].forEach(({ name, blob }) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }

  /**
   * Download AFTER files
   */
  private downloadAfterFiles(): void {
    if (!this.parallelRecordingResult) return;
    
    const files = this.parallelRecorder.createWAVFiles(this.parallelRecordingResult);
    
    [
      { name: 'AFTER_clean_microphone.wav', blob: files.afterCleanMicrophone },
      { name: 'AFTER_clean_system_audio.wav', blob: files.afterCleanSystemAudio }
    ].forEach(({ name, blob }) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }

  /**
   * Run Phase 2 test again
   */
  private async runPhase2TestAgain(): Promise<void> {
    // Reset and return to Phase 1 interface
    this.parallelRecorder.reset();
    this.parallelRecordingResult = null;
    this.createPhase1TestUI();
  }

  /**
   * Run Phase 2 test (called by button click)
   */
  private async runPhase2Test(): Promise<void> {
    console.log('🚀 Starting Phase 2 Real-Time Echo Cancellation Test...');
    
    try {
      await this.testPhase2RealTimeProcessing();
    } catch (error) {
      console.error('❌ Phase 2 test failed:', error);
      this.showError(`Phase 2 test failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Show error message to user
   */
  private showError(message: string): void {
    alert(`❌ Error: ${message}`);
    
    // Also update status if element exists
    const statusElement = document.getElementById('phase2-status');
    if (statusElement) {
      statusElement.innerHTML = `<div style="color: red;">❌ ${message}</div>`;
    }
  }
}

// Initialize the demo when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  console.log('🎯 Initializing Echo Cancellation Demo...');
  new EchoCancellationDemo();
});

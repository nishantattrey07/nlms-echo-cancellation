/**
 * Audio Recording System
 * Records separate audio streams and creates test scenarios
 */

export interface RecordingConfig {
  sampleRate: number;
  maxDuration: number; // seconds
  outputFormat: 'wav' | 'webm';
}

export interface AudioStreams {
  microphone: MediaStream | null;
  systemAudio: MediaStream | null;
  mixed: MediaStream | null;
}

export interface RecordedAudio {
  clean_microphone: Float32Array;
  clean_system: Float32Array;
  mixed_signal: Float32Array;
  sampleRate: number;
  duration: number;
}

export class AudioRecorder {
  private config: RecordingConfig;
  private streams: AudioStreams = {
    microphone: null,
    systemAudio: null,
    mixed: null
  };
  
  private audioContext!: AudioContext;
  private isRecording: boolean = false;
  private simulatedAudioSource: OscillatorNode | null = null;
  private usingSimulatedAudio: boolean = false;
  private recordedBuffers: {
    microphone: Float32Array[];
    systemAudio: Float32Array[];
    mixed: Float32Array[];
  } = {
    microphone: [],
    systemAudio: [],
    mixed: []
  };

  constructor(config: Partial<RecordingConfig> = {}) {
    this.config = {
      sampleRate: 48000,
      maxDuration: 30, // 30 seconds max
      outputFormat: 'wav',
      ...config
    };
  }

  /**
   * Initialize audio context and request permissions
   */
  public async initialize(): Promise<void> {
    try {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: this.config.sampleRate,
        latencyHint: 'interactive'
      });

      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      console.log('Audio recorder initialized:', {
        sampleRate: this.audioContext.sampleRate,
        state: this.audioContext.state
      });

    } catch (error) {
      console.error('Failed to initialize audio recorder:', error);
      throw new Error('Audio initialization failed. Please check browser compatibility.');
    }
  }

  /**
   * Request microphone access with echo cancellation disabled and optimal settings
   */
  public async requestMicrophoneAccess(): Promise<MediaStream> {
    try {
      console.log('Requesting microphone access with echo cancellation disabled...');
      
      // Get available audio input devices first
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(d => d.kind === 'audioinput');
      
      console.log('Available audio input devices:', audioInputs.length);
      
      // Build optimal constraints
      const baseConstraints: MediaStreamConstraints = {
        audio: {
          // Device selection - prefer first available or default
          ...(audioInputs.length > 0 && audioInputs[0].deviceId ? 
            { deviceId: audioInputs[0].deviceId } : {}
          ),
          
          // CRITICAL: Disable all browser audio processing
          echoCancellation: false,  // MUST be false for echo cancellation demo
          noiseSuppression: false,  // MUST be false to preserve original signal
          autoGainControl: false,   // MUST be false for consistent levels
          
          // Audio quality settings
          sampleRate: this.config.sampleRate,
          channelCount: 1,          // Mono input
          sampleSize: 16            // 16-bit samples
        }
      };

      // Add Chrome-specific constraints if available
      const audioConstraints = baseConstraints.audio as any;
      if (navigator.userAgent.includes('Chrome')) {
        // Chrome-specific settings for more control
        audioConstraints.googEchoCancellation = false;
        audioConstraints.googNoiseSuppression = false;  
        audioConstraints.googAutoGainControl = false;
        audioConstraints.googTypingNoiseDetection = false;
        audioConstraints.googBeamforming = false;
        audioConstraints.googArrayGeometry = false;
        audioConstraints.googAudioMirroring = false;
      }

      const stream = await navigator.mediaDevices.getUserMedia(baseConstraints);
      this.streams.microphone = stream;
      
      // Verify that echo cancellation is actually disabled
      const track = stream.getAudioTracks()[0];
      const actualSettings = track.getSettings();
      const actualConstraints = track.getConstraints();
      
      console.log('Microphone access granted:', {
        tracks: stream.getAudioTracks().length,
        settings: actualSettings,
        constraints: actualConstraints,
        echoCancellationDisabled: actualSettings.echoCancellation === false
      });

      // Warn if echo cancellation couldn't be disabled
      if (actualSettings.echoCancellation !== false) {
        console.warn('⚠️ WARNING: Echo cancellation could not be disabled on this device/browser');
        console.warn('This may affect demo quality. Try a different browser or device.');
      }

      // Verify other critical settings
      if (actualSettings.noiseSuppression !== false) {
        console.warn('⚠️ WARNING: Noise suppression could not be disabled');
      }
      
      if (actualSettings.autoGainControl !== false) {
        console.warn('⚠️ WARNING: Auto gain control could not be disabled');
      }

      return stream;

    } catch (error) {
      console.error('Microphone access failed:', error);
      
      // Provide specific error guidance
      if (error instanceof Error) {
        if (error.name === 'NotAllowedError') {
          throw new Error('Microphone permission denied. Please allow microphone access and refresh the page.');
        } else if (error.name === 'NotFoundError') {
          throw new Error('No microphone found. Please connect a microphone and try again.');
        } else if (error.name === 'OverconstrainedError') {
          console.log('Constraints too strict, trying with fallback settings...');
          return this.requestMicrophoneAccessFallback();
        }
      }
      
      throw new Error('Microphone access failed. Please check permissions and device availability.');
    }
  }

  /**
   * Fallback microphone access with relaxed constraints
   */
  private async requestMicrophoneAccessFallback(): Promise<MediaStream> {
    try {
      console.log('Attempting microphone access with fallback constraints...');
      
      const fallbackConstraints: MediaStreamConstraints = {
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
          // Remove sample rate and other constraints that might be too strict
        }
      };

      const stream = await navigator.mediaDevices.getUserMedia(fallbackConstraints);
      this.streams.microphone = stream;
      
      console.log('Microphone access granted with fallback settings');
      return stream;
      
    } catch (error) {
      console.error('Fallback microphone access also failed:', error);
      throw new Error('Unable to access microphone with any settings. Please check device and permissions.');
    }
  }

  /**
   * Request system audio access via screen share with robust fallback
   */
  public async requestSystemAudioAccess(): Promise<MediaStream> {
    try {
      // Check if getDisplayMedia is supported
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error('Screen sharing not supported in this browser');
      }

      console.log('Attempting system audio capture via screen sharing...');
      
      const constraints = {
        video: true,  // MUST be true, even for audio only
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: this.config.sampleRate,
          channelCount: 2,
          sampleSize: 16,
          suppressLocalAudioPlayback: false // Important for demo
        }
      };

      const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
      
      // CRITICAL: Check if audio track exists
      const audioTracks = stream.getAudioTracks();
      const videoTracks = stream.getVideoTracks();
      
      if (audioTracks.length === 0) {
        // Clean up video track if no audio
        videoTracks.forEach(track => {
          track.stop();
          stream.removeTrack(track);
        });
        throw new Error('No audio track found. Please ensure "Share tab audio" is checked when sharing.');
      }

      // Remove video track - we only need audio
      videoTracks.forEach(track => {
        track.stop();
        stream.removeTrack(track);
      });

      this.streams.systemAudio = stream;
      this.usingSimulatedAudio = false;
      
      console.log('System audio access granted:', {
        audioTracks: audioTracks.length,
        settings: audioTracks[0]?.getSettings(),
        constraints: audioTracks[0]?.getConstraints()
      });

      return stream;

    } catch (error) {
      console.error('System audio access failed:', error);
      
      // Provide specific guidance based on error type
      if (error instanceof Error) {
        if (error.name === 'NotAllowedError') {
          console.log('User denied screen sharing permission');
          throw new Error('Screen sharing permission denied. Please allow screen sharing and check "Share tab audio".');
        } else if (error.name === 'NotSupportedError') {
          console.log('System audio capture not supported on this browser/OS');
        } else if (error.message.includes('No audio track found')) {
          throw new Error('Please select a tab with audio and check "Share tab audio" checkbox.');
        }
      }
      
      console.log('Falling back to enhanced simulated system audio for demo...');
      
      // Fallback: Create enhanced simulated system audio
      this.usingSimulatedAudio = true;
      return this.createEnhancedSimulatedSystemAudio();
    }
  }

  /**
   * Create enhanced simulated system audio for demo purposes
   * This creates a more realistic system audio simulation with multiple frequency components
   */
  private async createEnhancedSimulatedSystemAudio(): Promise<MediaStream> {
    try {
      console.log('Creating enhanced simulated system audio...');
      
      // Create multiple oscillators for realistic system audio simulation
      const oscillators: OscillatorNode[] = [];
      const gainNodes: GainNode[] = [];
      
      // Create a complex signal with multiple frequency components
      const frequencies = [220, 330, 440, 660]; // Musical harmony
      const gains = [0.15, 0.1, 0.2, 0.05]; // Different levels
      
      // Create master gain for overall volume control
      const masterGain = this.audioContext.createGain();
      masterGain.gain.setValueAtTime(0.3, this.audioContext.currentTime);
      
      // Create each frequency component
      for (let i = 0; i < frequencies.length; i++) {
        const oscillator = this.audioContext.createOscillator();
        const gainNode = this.audioContext.createGain();
        
        // Configure oscillator
        oscillator.type = i % 2 === 0 ? 'sine' : 'triangle'; // Mix of waveforms
        oscillator.frequency.setValueAtTime(frequencies[i], this.audioContext.currentTime);
        
        // Add slight frequency modulation for realism
        const lfo = this.audioContext.createOscillator();
        const lfoGain = this.audioContext.createGain();
        lfo.type = 'sine';
        lfo.frequency.setValueAtTime(0.5 + i * 0.2, this.audioContext.currentTime);
        lfoGain.gain.setValueAtTime(2, this.audioContext.currentTime);
        
        lfo.connect(lfoGain);
        lfoGain.connect(oscillator.frequency);
        lfo.start();
        
        // Configure gain
        gainNode.gain.setValueAtTime(gains[i], this.audioContext.currentTime);
        
        // Connect audio graph
        oscillator.connect(gainNode);
        gainNode.connect(masterGain);
        
        // Start oscillator
        oscillator.start();
        
        // Store references
        oscillators.push(oscillator);
        gainNodes.push(gainNode);
      }
      
      // Add some filtered noise for realism
      const noiseBuffer = this.audioContext.createBuffer(1, this.audioContext.sampleRate, this.audioContext.sampleRate);
      const noiseData = noiseBuffer.getChannelData(0);
      for (let i = 0; i < noiseData.length; i++) {
        noiseData[i] = (Math.random() - 0.5) * 0.02; // Low-level noise
      }
      
      const noiseSource = this.audioContext.createBufferSource();
      const noiseGain = this.audioContext.createGain();
      const noiseFilter = this.audioContext.createBiquadFilter();
      
      noiseSource.buffer = noiseBuffer;
      noiseSource.loop = true;
      noiseGain.gain.setValueAtTime(0.05, this.audioContext.currentTime);
      noiseFilter.type = 'lowpass';
      noiseFilter.frequency.setValueAtTime(2000, this.audioContext.currentTime);
      
      noiseSource.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(masterGain);
      noiseSource.start();
      
      // Create MediaStreamDestination to convert to MediaStream
      const destination = this.audioContext.createMediaStreamDestination();
      masterGain.connect(destination);
      
      // Store references for cleanup
      this.simulatedAudioSource = oscillators[0]; // Store primary oscillator
      this.streams.systemAudio = destination.stream;
      this.usingSimulatedAudio = true;
      
      console.log('Enhanced simulated system audio created with', frequencies.length, 'frequency components');
      
      // Provide user guidance
      this.showSystemAudioGuidance();
      
      return destination.stream;
      
    } catch (error) {
      console.error('Failed to create enhanced simulated system audio:', error);
      throw new Error('Unable to create system audio for demo. Please check audio permissions and browser compatibility.');
    }
  }

  /**
   * Show guidance for system audio setup
   */
  private showSystemAudioGuidance(): void {
    console.log(`
    📢 SYSTEM AUDIO GUIDANCE:
    
    🔴 Currently using simulated system audio for demo
    
    For REAL system audio capture:
    1. Refresh the page
    2. When prompted for screen sharing:
       ✅ Select a browser tab that's playing audio
       ✅ Check "Share tab audio" checkbox
       ✅ Click "Share"
    
    💡 Best results with:
    - Chrome/Edge browsers
    - YouTube, Spotify, or any audio-playing tab
    - Good audio levels (not too quiet)
    
    🔧 Alternative: Set up virtual audio cable for professional demo
    `);
  }

  /**
   * Start recording all streams simultaneously
   */
  public async startRecording(): Promise<void> {
    if (this.isRecording) {
      throw new Error('Recording already in progress');
    }

    if (!this.streams.microphone || !this.streams.systemAudio) {
      throw new Error('Audio streams not initialized. Call requestMicrophoneAccess() and requestSystemAudioAccess() first.');
    }

    try {
      this.isRecording = true;
      this.clearBuffers();

      // Create audio source nodes
      const micSource = this.audioContext.createMediaStreamSource(this.streams.microphone);
      const sysSource = this.audioContext.createMediaStreamSource(this.streams.systemAudio);

      // Create script processors for recording
      const blockSize = 4096; // Larger block for recording
      const micProcessor = this.audioContext.createScriptProcessor(blockSize, 1, 1);
      const sysProcessor = this.audioContext.createScriptProcessor(blockSize, 1, 1);
      const mixProcessor = this.audioContext.createScriptProcessor(blockSize, 2, 1);

      // Record microphone
      micProcessor.onaudioprocess = (event) => {
        if (this.isRecording) {
          const inputData = event.inputBuffer.getChannelData(0);
          this.recordedBuffers.microphone.push(new Float32Array(inputData));
        }
      };

      // Record system audio
      sysProcessor.onaudioprocess = (event) => {
        if (this.isRecording) {
          const inputData = event.inputBuffer.getChannelData(0);
          this.recordedBuffers.systemAudio.push(new Float32Array(inputData));
        }
      };

      // Create mixed signal (mic + system audio)
      const mixGain = this.audioContext.createGain();
      mixGain.gain.value = 0.7; // Reduce system audio level in mix

      mixProcessor.onaudioprocess = (event) => {
        if (this.isRecording) {
          const micData = event.inputBuffer.getChannelData(0);
          const sysData = event.inputBuffer.getChannelData(1);
          const mixedData = new Float32Array(micData.length);
          
          // Create realistic mixed signal
          for (let i = 0; i < micData.length; i++) {
            mixedData[i] = micData[i] + sysData[i] * 0.3; // 30% system audio bleed
          }
          
          this.recordedBuffers.mixed.push(mixedData);
        }
      };

      // Connect audio graph
      micSource.connect(micProcessor);
      micProcessor.connect(this.audioContext.destination);

      sysSource.connect(sysProcessor);
      sysProcessor.connect(this.audioContext.destination);

      // For mixed signal - combine both sources
      const merger = this.audioContext.createChannelMerger(2);
      micSource.connect(merger, 0, 0);
      mixGain.connect(merger, 0, 1);
      merger.connect(mixProcessor);
      mixProcessor.connect(this.audioContext.destination);

      console.log('Recording started successfully');

      // Auto-stop after max duration
      setTimeout(() => {
        if (this.isRecording) {
          this.stopRecording();
        }
      }, this.config.maxDuration * 1000);

    } catch (error) {
      this.isRecording = false;
      console.error('Failed to start recording:', error);
      throw error;
    }
  }

  /**
   * Stop recording and return recorded audio
   */
  public stopRecording(): RecordedAudio {
    if (!this.isRecording) {
      throw new Error('No recording in progress');
    }

    this.isRecording = false;

    // Combine all recorded buffers
    const combinedMic = this.combineBuffers(this.recordedBuffers.microphone);
    const combinedSys = this.combineBuffers(this.recordedBuffers.systemAudio);
    const combinedMix = this.combineBuffers(this.recordedBuffers.mixed);

    const duration = combinedMic.length / this.config.sampleRate;

    console.log('Recording stopped:', {
      duration: duration.toFixed(2) + 's',
      samples: combinedMic.length,
      sampleRate: this.config.sampleRate
    });

    return {
      clean_microphone: combinedMic,
      clean_system: combinedSys,
      mixed_signal: combinedMix,
      sampleRate: this.config.sampleRate,
      duration
    };
  }

  private combineBuffers(buffers: Float32Array[]): Float32Array {
    const totalLength = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
    const combined = new Float32Array(totalLength);
    
    let offset = 0;
    for (const buffer of buffers) {
      combined.set(buffer, offset);
      offset += buffer.length;
    }
    
    return combined;
  }

  private clearBuffers(): void {
    this.recordedBuffers.microphone = [];
    this.recordedBuffers.systemAudio = [];
    this.recordedBuffers.mixed = [];
  }

  /**
   * Create WAV file from recorded audio
   */
  public createWAVFile(audioData: Float32Array, sampleRate: number): Blob {
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
    
    // Convert float samples to 16-bit PCM
    let offset = 44;
    for (let i = 0; i < length; i++) {
      const sample = Math.max(-1, Math.min(1, audioData[i]));
      view.setInt16(offset, sample * 0x7FFF, true);
      offset += 2;
    }
    
    return new Blob([buffer], { type: 'audio/wav' });
  }

  /**
   * Download recorded audio as WAV files
   */
  public downloadRecording(recordedAudio: RecordedAudio): void {
    const files = [
      { name: 'clean_microphone.wav', data: recordedAudio.clean_microphone },
      { name: 'clean_system.wav', data: recordedAudio.clean_system },
      { name: 'mixed_signal.wav', data: recordedAudio.mixed_signal }
    ];

    files.forEach(file => {
      const blob = this.createWAVFile(file.data, recordedAudio.sampleRate);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }

  /**
   * Stop all streams and cleanup
   */
  public cleanup(): void {
    this.isRecording = false;
    
    // Stop simulated audio source if it exists
    if (this.simulatedAudioSource) {
      this.simulatedAudioSource.stop();
      this.simulatedAudioSource = null;
    }
    
    Object.values(this.streams).forEach((stream: MediaStream | null) => {
      if (stream) {
        stream.getTracks().forEach((track: MediaStreamTrack) => track.stop());
      }
    });

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
    }
  }

  public getRecordingStatus() {
    return {
      isRecording: this.isRecording,
      usingSimulatedAudio: this.usingSimulatedAudio,
      hasStreams: {
        microphone: !!this.streams.microphone,
        systemAudio: !!this.streams.systemAudio
      },
      bufferSizes: {
        microphone: this.recordedBuffers.microphone.length,
        systemAudio: this.recordedBuffers.systemAudio.length,
        mixed: this.recordedBuffers.mixed.length
      }
    };
  }

  public isUsingSimulatedAudio(): boolean {
    return this.usingSimulatedAudio;
  }

  /**
   * Check browser compatibility and audio capabilities
   */
  public async checkBrowserCompatibility(): Promise<{
    compatible: boolean;
    issues: string[];
    recommendations: string[];
    capabilities: {
      screenCapture: boolean;
      audioWorklet: boolean;
      mediaDevices: boolean;
      getUserMedia: boolean;
      preferredSampleRate: number;
      preferredBlockSize: number;
    };
  }> {
    const issues: string[] = [];
    const recommendations: string[] = [];
    
    // Check for required APIs
    const hasScreenCapture = !!(navigator.mediaDevices?.getDisplayMedia);
    const hasAudioWorklet = 'audioWorklet' in AudioContext.prototype;
    const hasMediaDevices = !!(navigator.mediaDevices);
    const hasGetUserMedia = !!(navigator.mediaDevices?.getUserMedia);
    
    if (!hasScreenCapture) {
      issues.push('Screen capture not supported - system audio unavailable');
      recommendations.push('Use Chrome/Edge browsers for best compatibility');
    }
    
    if (!hasAudioWorklet) {
      issues.push('AudioWorklet not supported - using legacy ScriptProcessor');
      recommendations.push('Update to a modern browser for better performance');
    }
    
    if (!hasMediaDevices || !hasGetUserMedia) {
      issues.push('MediaDevices API not supported');
      recommendations.push('Use HTTPS and a modern browser');
    }

    // Browser-specific capabilities
    let preferredSampleRate = 48000;
    let preferredBlockSize = 128;
    
    if (navigator.userAgent.includes('Chrome')) {
      preferredSampleRate = 48000;
      preferredBlockSize = 128;
      recommendations.push('Chrome detected - optimal for system audio capture');
    } else if (navigator.userAgent.includes('Firefox')) {
      preferredSampleRate = 44100;
      preferredBlockSize = 256;
      recommendations.push('Firefox detected - limited system audio support');
    } else if (navigator.userAgent.includes('Safari')) {
      preferredSampleRate = 44100;
      preferredBlockSize = 512;
      issues.push('Safari has limited audio capture capabilities');
      recommendations.push('Consider using Chrome/Edge for full functionality');
    }

    // Check HTTPS requirement
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
      issues.push('HTTPS required for audio capture');
      recommendations.push('Serve the demo over HTTPS');
    }

    const compatible = issues.length === 0 || issues.every(issue => 
      issue.includes('legacy ScriptProcessor') || issue.includes('system audio unavailable')
    );

    return {
      compatible,
      issues,
      recommendations,
      capabilities: {
        screenCapture: hasScreenCapture,
        audioWorklet: hasAudioWorklet,
        mediaDevices: hasMediaDevices,
        getUserMedia: hasGetUserMedia,
        preferredSampleRate,
        preferredBlockSize
      }
    };
  }

  /**
   * Get detailed information about available audio devices
   */
  public async getAudioDeviceInfo(): Promise<{
    inputs: MediaDeviceInfo[];
    outputs: MediaDeviceInfo[];
    hasPermissions: boolean;
    defaultInput?: MediaDeviceInfo;
    defaultOutput?: MediaDeviceInfo;
  }> {
    try {
      // First check if we have permissions
      let hasPermissions = false;
      try {
        const testStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        hasPermissions = true;
        testStream.getTracks().forEach(track => track.stop());
      } catch (error) {
        hasPermissions = false;
      }

      // Get device list
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(d => d.kind === 'audioinput');
      const outputs = devices.filter(d => d.kind === 'audiooutput');

      // Find default devices (usually the first one or one with empty deviceId)
      const defaultInput = inputs.find(d => d.deviceId === 'default') || inputs[0];
      const defaultOutput = outputs.find(d => d.deviceId === 'default') || outputs[0];

      console.log('Audio device enumeration:', {
        inputs: inputs.length,
        outputs: outputs.length,
        hasPermissions,
        inputLabels: hasPermissions ? inputs.map(d => d.label) : ['Permission required'],
        outputLabels: hasPermissions ? outputs.map(d => d.label) : ['Permission required']
      });

      return {
        inputs,
        outputs,
        hasPermissions,
        defaultInput,
        defaultOutput
      };

    } catch (error) {
      console.error('Failed to enumerate audio devices:', error);
      return {
        inputs: [],
        outputs: [],
        hasPermissions: false
      };
    }
  }

  /**
   * Validate system audio capture and provide detailed guidance
   */
  public async validateSystemAudioSetup(): Promise<{
    success: boolean;
    hasAudioTrack: boolean;
    audioTrackSettings?: MediaTrackSettings;
    guidance: string[];
    nextSteps: string[];
  }> {
    const guidance: string[] = [];
    const nextSteps: string[] = [];
    
    if (!this.streams.systemAudio) {
      return {
        success: false,
        hasAudioTrack: false,
        guidance: ['System audio not initialized'],
        nextSteps: ['Call requestSystemAudioAccess() first']
      };
    }

    const audioTracks = this.streams.systemAudio.getAudioTracks();
    const hasAudioTrack = audioTracks.length > 0;
    
    if (!hasAudioTrack) {
      guidance.push('❌ No audio track found in system audio stream');
      guidance.push('This usually means "Share tab audio" was not checked');
      
      nextSteps.push('1. Refresh the page');
      nextSteps.push('2. When prompted for screen sharing:');
      nextSteps.push('   ✅ Select a tab that is playing audio');
      nextSteps.push('   ✅ Check "Share tab audio" checkbox');
      nextSteps.push('   ✅ Click "Share"');
      nextSteps.push('3. Ensure the tab is actually playing audio');
      
      return {
        success: false,
        hasAudioTrack: false,
        guidance,
        nextSteps
      };
    }

    // Get detailed track settings
    const audioTrack = audioTracks[0];
    const settings = audioTrack.getSettings();
    
    guidance.push('✅ System audio track found');
    guidance.push(`📊 Sample Rate: ${settings.sampleRate || 'Unknown'} Hz`);
    guidance.push(`🔊 Channel Count: ${settings.channelCount || 'Unknown'}`);
    
    // Check if echo cancellation is properly disabled
    if (settings.echoCancellation === true) {
      guidance.push('⚠️ Echo cancellation is enabled on system audio');
      guidance.push('This may affect demo quality');
      nextSteps.push('Try selecting a different audio source');
    } else {
      guidance.push('✅ Echo cancellation disabled on system audio');
    }

    // Check sample rate compatibility
    if (settings.sampleRate && settings.sampleRate !== this.config.sampleRate) {
      guidance.push(`⚠️ Sample rate mismatch: ${settings.sampleRate} vs expected ${this.config.sampleRate}`);
      nextSteps.push('Audio will be resampled - may affect quality');
    }

    // Test audio level by monitoring for a short time
    const levelTest = await this.testAudioLevel();
    if (levelTest.maxLevel < 0.01) {
      guidance.push('⚠️ Very low or no audio detected');
      guidance.push('Make sure the selected tab is playing audio');
      nextSteps.push('1. Increase volume on the source tab');
      nextSteps.push('2. Ensure audio is actually playing');
      nextSteps.push('3. Try a different audio source (YouTube, Spotify, etc.)');
    } else {
      guidance.push(`✅ Audio detected - Level: ${(levelTest.maxLevel * 100).toFixed(1)}%`);
    }

    const success = hasAudioTrack && levelTest.maxLevel >= 0.01;
    
    return {
      success,
      hasAudioTrack,
      audioTrackSettings: settings,
      guidance,
      nextSteps
    };
  }

  /**
   * Test audio level of system audio stream
   */
  private async testAudioLevel(duration: number = 1000): Promise<{
    maxLevel: number;
    avgLevel: number;
    samples: number;
  }> {
    return new Promise((resolve) => {
      if (!this.streams.systemAudio) {
        resolve({ maxLevel: 0, avgLevel: 0, samples: 0 });
        return;
      }

      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(this.streams.systemAudio);
      const analyzer = audioContext.createAnalyser();
      analyzer.fftSize = 256;
      
      source.connect(analyzer);
      
      const dataArray = new Uint8Array(analyzer.frequencyBinCount);
      let maxLevel = 0;
      let totalLevel = 0;
      let samples = 0;
      
      const checkLevel = () => {
        analyzer.getByteFrequencyData(dataArray);
        
        // Calculate RMS level
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += (dataArray[i] / 255) ** 2;
        }
        const rms = Math.sqrt(sum / dataArray.length);
        
        maxLevel = Math.max(maxLevel, rms);
        totalLevel += rms;
        samples++;
      };
      
      const interval = setInterval(checkLevel, 50); // Check every 50ms
      
      setTimeout(() => {
        clearInterval(interval);
        source.disconnect();
        audioContext.close();
        
        resolve({
          maxLevel,
          avgLevel: samples > 0 ? totalLevel / samples : 0,
          samples
        });
      }, duration);
    });
  }
}

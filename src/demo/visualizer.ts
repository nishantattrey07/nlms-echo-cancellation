/**
 * Audio Visualization Component
 * Real-time waveform and spectrum visualization
 */

export interface VisualizationConfig {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  backgroundColor: string;
  waveformColor: string;
  spectrumColor: string;
  gridColor: string;
}

export class AudioVisualizer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: VisualizationConfig;
  private animationId: number | null = null;
  
  // Animation state
  private isAnimating: boolean = false;

  constructor(canvasElement: HTMLCanvasElement, config: Partial<VisualizationConfig> = {}) {
    this.canvas = canvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    
    this.config = {
      canvas: canvasElement,
      width: canvasElement.width,
      height: canvasElement.height,
      backgroundColor: '#0a0a0a',
      waveformColor: '#4ecdc4',
      spectrumColor: '#ff6b6b',
      gridColor: 'rgba(255, 255, 255, 0.1)',
      ...config
    };

    this.setupCanvas();
  }

  private setupCanvas(): void {
    this.canvas.width = this.config.width;
    this.canvas.height = this.config.height;
    this.ctx.imageSmoothingEnabled = true;
  }

  /**
   * Draw waveform visualization
   */
  public drawWaveform(audioData: Float32Array, title: string = 'Waveform'): void {
    this.clear();
    
    const { width, height } = this.config;
    const centerY = height / 2;
    const amplitude = height * 0.4;
    
    // Draw grid
    this.drawGrid();
    
    // Draw title
    this.drawTitle(title);
    
    // Draw waveform
    this.ctx.strokeStyle = this.config.waveformColor;
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    
    for (let i = 0; i < audioData.length; i++) {
      const x = (i / audioData.length) * width;
      const y = centerY - audioData[i] * amplitude;
      
      if (i === 0) {
        this.ctx.moveTo(x, y);
      } else {
        this.ctx.lineTo(x, y);
      }
    }
    
    this.ctx.stroke();
    
    // Draw zero line
    this.ctx.strokeStyle = this.config.gridColor;
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(0, centerY);
    this.ctx.lineTo(width, centerY);
    this.ctx.stroke();
  }

  /**
   * Draw spectrum visualization
   */
  public drawSpectrum(spectrumData: Float32Array, title: string = 'Spectrum', sampleRate: number = 48000): void {
    this.clear();
    
    const { width, height } = this.config;
    
    // Draw grid
    this.drawGrid();
    
    // Draw title
    this.drawTitle(title);
    
    // Draw spectrum bars
    this.ctx.fillStyle = this.config.spectrumColor;
    const barWidth = width / spectrumData.length;
    const maxHeight = height * 0.8;
    
    // Find max value for normalization
    const maxValue = Math.max(...spectrumData);
    
    for (let i = 0; i < spectrumData.length; i++) {
      const x = i * barWidth;
      const barHeight = (spectrumData[i] / maxValue) * maxHeight;
      const y = height - barHeight;
      
      this.ctx.fillRect(x, y, barWidth - 1, barHeight);
    }
    
    // Draw frequency labels
    this.drawFrequencyLabels(spectrumData.length, sampleRate);
  }

  /**
   * Draw comparison view (original vs processed)
   */
  public drawComparison(
    originalData: Float32Array, 
    processedData: Float32Array,
    metrics: { erle: number; signalPower: number; noisePower: number }
  ): void {
    this.clear();
    
    const { width, height } = this.config;
    const halfHeight = height / 2;
    
    // Draw title
    this.ctx.fillStyle = '#ffffff';
    this.ctx.font = '16px Arial';
    this.ctx.fillText('Audio Comparison', 10, 20);
    
    // Draw ERLE metric
    this.ctx.fillStyle = '#4ecdc4';
    this.ctx.font = '14px Arial';
    this.ctx.fillText(`ERLE: ${metrics.erle.toFixed(1)} dB`, width - 120, 20);
    
    // Draw original waveform (top half)
    this.ctx.strokeStyle = '#ff6b6b';
    this.ctx.lineWidth = 1.5;
    this.ctx.beginPath();
    
    const centerY1 = halfHeight / 2;
    const amplitude1 = halfHeight * 0.3;
    
    for (let i = 0; i < originalData.length; i++) {
      const x = (i / originalData.length) * width;
      const y = centerY1 - originalData[i] * amplitude1;
      
      if (i === 0) {
        this.ctx.moveTo(x, y);
      } else {
        this.ctx.lineTo(x, y);
      }
    }
    this.ctx.stroke();
    
    // Label for original
    this.ctx.fillStyle = '#ff6b6b';
    this.ctx.font = '12px Arial';
    this.ctx.fillText('Original (with echo)', 10, 40);
    
    // Draw processed waveform (bottom half)
    this.ctx.strokeStyle = '#4ecdc4';
    this.ctx.lineWidth = 1.5;
    this.ctx.beginPath();
    
    const centerY2 = halfHeight + halfHeight / 2;
    const amplitude2 = halfHeight * 0.3;
    
    for (let i = 0; i < processedData.length; i++) {
      const x = (i / processedData.length) * width;
      const y = centerY2 - processedData[i] * amplitude2;
      
      if (i === 0) {
        this.ctx.moveTo(x, y);
      } else {
        this.ctx.lineTo(x, y);
      }
    }
    this.ctx.stroke();
    
    // Label for processed
    this.ctx.fillStyle = '#4ecdc4';
    this.ctx.font = '12px Arial';
    this.ctx.fillText('Processed (echo removed)', 10, halfHeight + 20);
    
    // Draw separator line
    this.ctx.strokeStyle = this.config.gridColor;
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(0, halfHeight);
    this.ctx.lineTo(width, halfHeight);
    this.ctx.stroke();
  }

  /**
   * Start real-time visualization animation
   */
  public startAnimation(dataSource: () => Float32Array, mode: 'waveform' | 'spectrum' = 'waveform'): void {
    if (this.isAnimating) {
      this.stopAnimation();
    }
    
    this.isAnimating = true;
    
    const animate = () => {
      if (!this.isAnimating) return;
      
      const data = dataSource();
      if (data && data.length > 0) {
        if (mode === 'waveform') {
          this.drawWaveform(data, 'Real-time Audio');
        } else {
          this.drawSpectrum(data, 'Real-time Spectrum');
        }
      }
      
      this.animationId = requestAnimationFrame(animate);
    };
    
    animate();
  }

  /**
   * Stop animation
   */
  public stopAnimation(): void {
    this.isAnimating = false;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  private clear(): void {
    this.ctx.fillStyle = this.config.backgroundColor;
    this.ctx.fillRect(0, 0, this.config.width, this.config.height);
  }

  private drawGrid(): void {
    const { width, height } = this.config;
    this.ctx.strokeStyle = this.config.gridColor;
    this.ctx.lineWidth = 0.5;
    
    // Vertical lines
    const verticalLines = 10;
    for (let i = 1; i < verticalLines; i++) {
      const x = (i / verticalLines) * width;
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, height);
      this.ctx.stroke();
    }
    
    // Horizontal lines
    const horizontalLines = 6;
    for (let i = 1; i < horizontalLines; i++) {
      const y = (i / horizontalLines) * height;
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(width, y);
      this.ctx.stroke();
    }
  }

  private drawTitle(title: string): void {
    this.ctx.fillStyle = '#ffffff';
    this.ctx.font = '14px Arial';
    this.ctx.fillText(title, 10, 20);
  }

  private drawFrequencyLabels(_spectrumLength: number, sampleRate: number): void {
    const { width, height } = this.config;
    const nyquist = sampleRate / 2;
    
    this.ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    this.ctx.font = '10px Arial';
    
    // Draw frequency labels at key points
    const frequencies = [0, 1000, 2000, 4000, 8000, 16000];
    
    frequencies.forEach(freq => {
      if (freq <= nyquist) {
        const x = (freq / nyquist) * width;
        this.ctx.fillText(`${freq}Hz`, x, height - 5);
      }
    });
  }

  /**
   * Update visualization config
   */
  public updateConfig(newConfig: Partial<VisualizationConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.setupCanvas();
  }

  /**
   * Resize canvas
   */
  public resize(width: number, height: number): void {
    this.config.width = width;
    this.config.height = height;
    this.setupCanvas();
  }

  /**
   * Export current visualization as image
   */
  public exportAsImage(filename: string = 'visualization.png'): void {
    const link = document.createElement('a');
    link.download = filename;
    link.href = this.canvas.toDataURL();
    link.click();
  }

  public cleanup(): void {
    this.stopAnimation();
  }
}

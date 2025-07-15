/**
 * Circular Buffer Implementation
 * Efficient data structure for audio delay lines and buffering
 */

export class CircularBuffer {
  private buffer: Float32Array;
  private writeIndex: number = 0;
  private readIndex: number = 0;
  private size: number;
  private mask: number;

  constructor(size: number) {
    // Ensure size is power of 2 for efficient masking
    this.size = this.nextPowerOfTwo(size);
    this.mask = this.size - 1;
    this.buffer = new Float32Array(this.size);
  }

  private nextPowerOfTwo(n: number): number {
    let power = 1;
    while (power < n) {
      power *= 2;
    }
    return power;
  }

  /**
   * Write a sample to the buffer
   */
  public write(sample: number): void {
    this.buffer[this.writeIndex] = sample;
    this.writeIndex = (this.writeIndex + 1) & this.mask;
  }

  /**
   * Write multiple samples to the buffer
   */
  public writeBlock(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.write(samples[i]);
    }
  }

  /**
   * Read a sample at specified delay
   */
  public read(delay: number = 0): number {
    const index = (this.writeIndex - 1 - delay) & this.mask;
    return this.buffer[index];
  }

  /**
   * Read multiple samples into output buffer
   */
  public readBlock(output: Float32Array, delay: number = 0): void {
    for (let i = 0; i < output.length; i++) {
      output[i] = this.read(delay + i);
    }
  }

  /**
   * Get buffer contents as array (for visualization)
   */
  public getBuffer(): Float32Array {
    return new Float32Array(this.buffer);
  }

  /**
   * Clear the buffer
   */
  public clear(): void {
    this.buffer.fill(0);
    this.writeIndex = 0;
    this.readIndex = 0;
  }

  /**
   * Get available samples count
   */
  public available(): number {
    return (this.writeIndex - this.readIndex) & this.mask;
  }

  /**
   * Get buffer size
   */
  public getSize(): number {
    return this.size;
  }
}

// Cryptographic random number generator utilities
export class CryptoRNG {
  /**
   * Generate a cryptographically secure random integer between 0 (inclusive) and max (exclusive)
   */
  static getRandomInt(max: number): number {
    if (max <= 0) throw new Error('Max must be greater than 0');
    
    // Use crypto.getRandomValues for secure randomness
    const array = new Uint32Array(1);
    crypto.getRandomValues(array);
    
    // Map the random value to the desired range
    return array[0] % max;
  }

  /**
   * Generate a random float between 0 (inclusive) and 1 (exclusive)
   */
  static getRandomFloat(): number {
    const array = new Uint32Array(1);
    crypto.getRandomValues(array);
    return array[0] / (0xffffffff + 1);
  }

  /**
   * Weighted random selection from an array of items with weights
   */
  static weightedSelect<T>(items: T[], weights: number[]): T {
    if (items.length !== weights.length) {
      throw new Error('Items and weights must have the same length');
    }
    
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    let random = this.getRandomFloat() * totalWeight;
    
    for (let i = 0; i < items.length; i++) {
      random -= weights[i];
      if (random <= 0) return items[i];
    }
    
    return items[items.length - 1];
  }

  /**
   * Shuffle array using Fisher-Yates algorithm with crypto random
   */
  static shuffle<T>(array: T[]): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = this.getRandomInt(i + 1);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
}

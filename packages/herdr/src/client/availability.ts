// SPDX-License-Identifier: MIT
import { HerdrError, type Availability } from './parse.js';

export async function trackAvailability<T>(scope: Availability, work: () => Promise<T>, available?: (key: string) => void): Promise<T> {
  try {
    const value = await work();
    available?.(scope.key);
    return value;
  } catch (error) {
    if (error instanceof HerdrError && error.code === 'unavailable' && !error.availability)
      throw new HerdrError(error.code, error.message, error.details, scope);
    throw error;
  }
}

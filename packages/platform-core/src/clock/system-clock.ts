// Production clock. Returns the current wall time as a fresh Date on
// every call.

import type { Clock } from "./clock.js";

export const systemClock: Clock = Object.freeze({
  now(): Date {
    return new Date();
  },
});

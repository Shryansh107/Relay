/**
 * targetSeniorities is a constant that would never change
 * representing the decision maker seniorities to filter for.
 */
export const TARGET_SENIORITIES = ["Founder/Owner", "C-Suite", "Vice President", "Director", "Head"];

/**
 * Fallback recipient email for dry-run simulation mode.
 */
export const SIMULATION_RECIPIENT_EMAIL = "shryansh2024@gmail.com";

/**
 * Rate limit parameters for the API clients.
 */
export const RATE_LIMITS = {
  OCEAN_IO: {
    maxRequestsPerInterval: 55,
    intervalMs: 60_000, // 1 minute
  },
  PROSPEO: {
    maxRequestsPerInterval: 200,
    intervalMs: 60_000, // 1 minute
    maxAttempts: 3,
  },
  ANYMAIL_FINDER: {
    maxRequestsPerInterval: 4,
    intervalMs: 1_000, // 1 second
  },
};

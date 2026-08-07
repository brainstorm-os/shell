// Timeouts in the e2e specs are calibrated on a developer machine. GitLab's
// shared Linux runners are small (1-2 vCPU, no GPU) and run Electron under
// xvfb, where the same work takes several times longer — the beta-smoke spec's
// 30s poll for the seeded dark theme slot blew its budget there while passing
// locally in a second or two.
//
// Scale rather than raise: a bigger constant everywhere would hide a real
// regression on a dev machine, where 30s genuinely means something is wrong.
// This keeps local budgets tight and gives CI the slack its hardware needs.
//
// Apply it at any site that is waiting on real work (seeding, indexing, an
// Electron boot), not at sites asserting something should be immediate.

const SLOWDOWN = process.env.CI ? 3 : 1;

export const scaled = (ms: number): number => ms * SLOWDOWN;

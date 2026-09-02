// Every tunable number lives here (plan section 1.2).

export const CFG = {
  city: { blocksX: 12, blocksZ: 12, blockSize: 60, roadWidth: 16, sidewalkWidth: 3, laneWidth: 3.5 },
  vehicle: {
    sedan:  { accel: 12, brake: 25, maxSpeed: 40, reverseMax: 10, steerMax: 0.55, grip: 8,  mass: 1 },
    sports: { accel: 18, brake: 28, maxSpeed: 58, reverseMax: 10, steerMax: 0.6,  grip: 10, mass: 0.9 },
    pickup: { accel: 10, brake: 22, maxSpeed: 36, reverseMax: 10, steerMax: 0.5,  grip: 7,  mass: 1.3 },
    police: { accel: 16, brake: 28, maxSpeed: 52, reverseMax: 10, steerMax: 0.6,  grip: 9,  mass: 1.1 },
  },
  player: { walkSpeed: 4, runSpeed: 8, enterRadius: 3.5, health: 100 },
  traffic: { count: 40, cruiseSpeed: 14, followGap: 8, intersectionPause: 1.2 },
  peds: { count: 80, walkSpeed: 1.4, fleeSpeed: 5, fleeRadius: 10 },
  police: { maxStars: 5, decaySeconds: 15, bustSeconds: 3, spawnPerStar: [0, 1, 2, 3, 4, 5] },
  camera: { chaseDist: 8, chaseHeight: 3.2, fovBase: 60, fovAtMaxSpeed: 78, lag: 6 },
  colors: { skyTop: 0x5b3fa0, skyHorizon: 0xffa66b, fog: 0xf5b592, sun: 0xffd9a0, water: 0x2ec4b6 },
};

export type VehicleTuning = (typeof CFG.vehicle)['sedan'];

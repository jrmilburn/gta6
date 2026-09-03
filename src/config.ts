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

  /**
   * Movement feel. Times are seconds, rates are per second, angles are radians
   * unless the name says degrees. Nothing in here changes what the simulation
   * *does* -- only how quickly it gets there.
   */
  feel: {
    /** Fixed-step loop. `maxFrame` caps how much wall time one frame may sim. */
    loop: { step: 1 / 60, maxFrame: 0.05, maxSteps: 5 },

    /** Binary key state -> continuous axes (1.2). */
    input: {
      attack: 0.12,        // seconds for a held key to reach full deflection
      release: 0.08,       // seconds to fall back to zero on release
      throttleAttack: 0.3, // throttle ramps in slower than the move axes (1.4)
      steerAttack: 0.12,
      steerRelease: 0.06,  // return-to-centre beats steer-in (1.4)
    },

    /** On-foot controller (1.3). */
    foot: {
      accel: 12,            // approach rate toward the target velocity
      decel: 16,            // approach rate back to a standstill
      airAccel: 3,          // barely any authority mid-jump
      turnRateDeg: 720,     // cap on how fast the character faces a new heading
      turnSmooth: 0.09,     // easing on the way into that cap
      facingMinSpeed: 0.5,  // below this, keep the last facing
      /** Camera-follow heading chases the character this fast. */
      cameraTurnSmooth: 0.28,
      /** Crossfade between the idle / walk / run pose blends. */
      blendTime: 0.2,
      /** Metres covered per full stride cycle, per clip. Sets playback rate so
       *  the feet plant instead of sliding. */
      walkStride: 2.0,
      runStride: 2.9,
      /** Spine lean, degrees. */
      leanAccelDeg: 6,
      leanTurnDeg: 4,
      leanSmooth: 0.18,
      /** Sidewalk kerbs are blended over this rather than snapped. */
      stepUpTime: 0.1,
      /** Jump shaping. */
      jumpAnticipation: 0.1,
      hangTime: 0.1,
      hangGravity: 0.6,
      landSquashTime: 0.15,
    },

    /** Cosmetic vehicle body motion (1.4). */
    vehicle: {
      suspensionStiffness: 60,
      suspensionDamping: 8,
      /** Metres of travel per g of longitudinal / lateral acceleration. */
      heaveScale: 0.006,
      pitchScale: 0.0026,
      rollScale: 0.0055,
      /** Independent per-wheel wobble amplitude and frequency on rough ground. */
      wheelWobble: 0.022,
      wheelWobbleRate: 9,
    },

    /** How long `G` dances for before it returns you to normal control. */
    danceSeconds: 8,

    /** Camera smoothing (1.5). All values are SmoothDamp smooth-times. */
    camera: {
      chasePos: 0.18,
      chaseLook: 0.10,
      footPos: 0.22,
      footLook: 0.12,
      fov: 0.4,
      /** Chase yaw follows the velocity heading no faster than this. */
      yawRateDeg: 180,
      /** Collision pull-in is fast; letting back out is slow. */
      occludeIn: 0.08,
      occludeOut: 0.25,
      /** Enter/exit blends the whole rig over this. */
      transition: 0.6,
      shakeTime: 0.35,
      shakeFreq: 22,
    },
  },

  /**
   * Skinned-character animation. Everything about *which* clip plays and how
   * fast, for both the player and the pedestrians sharing the rig.
   *
   * DECISION: the brief's speed thresholds (walk 0.3-3.5, jog 3.5-6.5, run
   * >6.5 m/s) are not used as written, because the clips Joe supplied disagree
   * with them. Measured at build time from the hips' own root motion, they were
   * authored at walk 0.89, jog 2.86 and run 5.17 m/s -- so "walk at 3.4 m/s"
   * would need a timeScale of 3.8 and the feet would skate. The clip's own
   * authored speed is the threshold instead: the ladder below is built from
   * character/manifest.json at boot, each clip plays nearest its native rate,
   * and the numbers here only bound how far it may be pushed. The brief's own
   * "stride must match ground speed" rule is the one that survives; its
   * thresholds are the one that could not.
   */
  anim: {
    /** Below this the character is standing, and only the idle pose plays. */
    idleSpeed: 0.3,
    /** Crossfade between any two locomotion clips. */
    blend: 0.2,
    /** How far a clip's playback may be pushed off its authored rate. */
    timeScaleMin: 0.6,
    timeScaleMax: 1.6,
    /** Synthesised idle (no idle clip was supplied): breath and weight shift. */
    breathHz: 0.25,
    breathScale: 0.015,
    swayHz: 0.17,
    swayDeg: 1.4,
    /** Dance crossfades, in and out, seconds. */
    danceIn: 0.25,
    danceOut: 0.3,
    /** Beats per minute of the synthesised dance track, and its bus gain. */
    danceBpm: 132,
    danceGain: 0.4,
    /** How far from the player a pedestrian will join in, metres. */
    danceJoinRadius: 8,
    /** Spine lean applied additively after the mixer, degrees. */
    airLeanDeg: 8,
    /** Where in the run cycle the frozen airborne pose is taken from, 0..1. */
    airPhase: 0.25,
    /** Pedestrians: the N nearest the camera get their own skinned mesh. */
    skinnedPeds: 16,
    /** Hysteresis band for the skinned <-> static swap, metres. */
    skinnedIn: 45,
    skinnedOut: 55,
    /**
     * Cell size for the static pedestrian's vertex-cluster decimation, metres.
     * Beyond 45 m a pedestrian is about 40 px tall, so 6 cm of welding is
     * invisible and takes 53k triangles down to something instanceable.
     */
    staticCluster: 0.06,
  },
};

export type VehicleTuning = (typeof CFG.vehicle)['sedan'];

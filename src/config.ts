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

    /** Mouse look (integration pass 2, section 3). */
    mouse: {
      /** Radians of turn per pixel of mouse movement. */
      sensitivity: 0.0022,
      invertY: false,
      /**
       * Camera elevation limits, degrees. Positive is above the subject looking
       * down. See the DECISION on MouseLook.pitch for why the range is not
       * symmetric.
       */
      pitchMinDeg: -35,
      pitchMaxDeg: 60,
      /** Where the camera sits before the mouse has been touched. */
      restPitch: 0.18,
      /** SmoothDamp time for the look direction; shorter than the position. */
      lookSmooth: 0.06,
      /** How long the mouse must be still before the camera drifts back. */
      recentreDelay: 0.35,
      /** ...and how long the drift itself takes. */
      recentreTime: 1.2,
    },

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

    /**
     * The opening flight: a drone shot over the city, three hard cuts pushing
     * in, then one smooth blend into the live player camera.
     *
     * Angles are degrees, distances and heights metres. Every shot is measured
     * from the player, so this works wherever they spawn.
     */
    intro: {
      /** `?intro=0` turns it off for a session; the smoke suite sets that. */
      enabled: true,
      /**
       * One held pose per shot, cut hard to the next. Nothing moves within a
       * shot: the zoom is the cut. Held just long enough to read the frame and
       * no longer -- the whole point is the snap between them.
       *
       * All three are `topDown`: straight down at the ground from directly
       * overhead. For those, `dist` and `az` are a horizontal offset from what
       * the shot is centred on, `az` doubles as which compass bearing points up
       * the screen -- a straight-down view has no other way to define roll --
       * and `look` is unused.
       *
       * The first is `world`: it frames the CITY, not the player. A player can
       * spawn anywhere, and centring a seafront spawn put half the frame in open
       * water. The other two are centred on the player, closing in.
       */
      shots: [
        { dur: 1.1, world: true, topDown: true, az: 46, dist: 0, h: 600, look: 0, fov: 45 },
        { dur: 0.9, topDown: true, az: 135, dist: 0, h: 240, look: 0, fov: 46 },
        { dur: 0.8, topDown: true, az: -96, dist: 0, h: 90, look: 0, fov: 50 },
      ],
      /**
       * The last shot starts behind the player -- az 0, where the chase camera
       * already is -- and blends to whatever the rig is showing, so the handover
       * is a short move rather than a swing across the map.
       */
      handover: { dur: 1.8, dist: 26, h: 16, look: 1.2, fov: 58 },
      /**
       * Fog density multiplier at the top of the flight, eased back to 1 by the
       * handover. FogExp2 at 0.0026 leaves about 91% haze at 600 m, which is a
       * white screen rather than a city.
       */
      fogLift: 0.16,
      /**
       * A keypress skips to the handover blend rather than cutting dead, so
       * skipping still arrives in the game rather than snapping. Input inside
       * `skipGuard` seconds is ignored: the same keystroke that dismisses the
       * title would otherwise skip the flight it just started.
       */
      skipGuard: 0.4,
      /**
       * Longest step the flight will take in one frame, seconds.
       *
       * The flight is timed in wall clock, which is right: a cut should land on
       * the beat whatever the frame rate. But one long hitch -- a GC pause, an
       * alt-tab, a texture upload -- could otherwise jump clean over the final
       * blend and snap the camera into gameplay. Clamping means a bad frame
       * stretches the flight slightly instead of skipping part of it.
       */
      maxStep: 0.25,
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

  /**
   * Punching, the pistol, and what either does to a civilian or a wanted level
   * (integration pass 2, sections 6-9).
   *
   * No blood, no gore, no death anywhere in here: a civilian who is hit falls
   * over, lies still, and later gets up. That is the whole of it.
   */
  combat: {
    punch: {
      /** Crossfade in and out of the punch overlay, seconds. */
      blendIn: 0.08,
      blendOut: 0.15,
      /** Fraction of the clip's duration before another punch may start. */
      cooldownFraction: 0.7,
      /** Where in the clip the fist arrives; measured once, see combat.ts. */
      impactFraction: 0.45,
      /**
       * How long the fist stays dangerous, either side of that moment. A single
       * instant misses anyone who has taken a step since the swing began.
       */
      activeBefore: 0.06,
      activeAfter: 0.14,
      /**
       * Longest a punch may take to land. The supplied combo runs 2.2 s, and a
       * punch that connects nearly two seconds after the click reads as broken
       * however faithful it is to the clip; longer clips are sped up to fit.
       */
      maxTimeToImpact: 0.4,
      /** Hit sphere: radius, how far in front, and how high. */
      reach: 0.9,
      radius: 1.0,
      height: 1.0,
      /** Damage a punched car takes, and the shove it gets. */
      vehicleDamage: 5,
      vehicleImpulse: 1.2,
      /** The character can still walk while punching, but no faster. */
      moveSpeed: 4,
    },
    pistol: {
      drawTime: 0.3,
      holsterTime: 0.3,
      /** Minimum seconds between shots. */
      fireInterval: 0.2,
      range: 120,
      vehicleDamage: 15,
      /** Over-the-shoulder aim camera. */
      aimDistance: 2.2,
      aimHeight: 1.5,
      aimShoulder: 0.6,
      aimFov: 45,
      aimIn: 0.15,
      aimOut: 0.2,
      /**
       * Above this speed the gun stance gives way to running: the character
       * turns into its stride instead of facing the camera, and the aim overlay
       * fades to `sprintPose`. Holding a two-handed sight picture at 8 m/s
       * looks like a bug, and no game keeps it.
       */
      sprintSpeed: 5.5,
      sprintPose: 0.15,
      /**
       * Top speed while aiming, m/s.
       *
       * Matched to the clips rather than picked for feel, and re-measured when
       * the run-speed pistol set arrived. Every armed direction now has a clip
       * fast enough to carry 3.5 m/s inside the playback clamp: forward blends
       * Pistol Run (2.89) into the ladder, the strafe pair tops out at 2.31 and
       * Pistol Run Backward is 3.16. All three plant to 0% at this figure.
       *
       * It was 2 m/s when the only armed clips were a 1.34 m/s walk backward and
       * a 2.06 m/s strafe, which pinned the clamp and skated by up to 46%.
       */
      aimMoveSpeed: 3.5,
      /** Camera kick per shot, degrees of pitch, and how long it recovers over. */
      kickDeg: 0.6,
      kickRecover: 0.15,
      /** Muzzle flash and tracer lifetimes, seconds. */
      flashTime: 0.033,
      tracerTime: 0.05,
      /** How long a bullet mark stays on a wall. */
      decalSeconds: 10,
      decalRadius: 0.06,
    },
    /** Civilian knockdown (section 8). */
    knockdown: {
      /** Seconds face-down before getting up. */
      downSeconds: 60,
      /** Playback rate of the fall clip run backwards as a get-up. */
      getUpRate: 2,
      /** A downed pedestrian this far from the player is recycled instead. */
      despawnDistance: 120,
      /** Pedestrians this close to a knockdown flee. */
      witnessRadius: 20,
    },
    /** Heat, in the units the wanted meter counts (section 9). */
    heat: {
      punchKnockdown: 40,
      shotKnockdown: 100,
      gunfireNearPolice: 100,
      shootPolice: 150,
      /** Radius within which a police car notices gunfire. */
      policeHearing: 40,
      /** Heat per star, and how fast heat bleeds off with nothing happening. */
      perStar: 100,
      decayPerSecond: 100 / 15,
    },
  },
};

export type VehicleTuning = (typeof CFG.vehicle)['sedan'];

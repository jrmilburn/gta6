// Shared contracts between phases. Additive changes only (see plan section 0.3).

export type Vec2 = { x: number; z: number };
export type Zone = 'downtown' | 'midtown' | 'residential' | 'beach';

export interface AABB { minX: number; minZ: number; maxX: number; maxZ: number }

export interface BuildingDef { bounds: AABB; height: number; colorIdx: number; hasNeon: boolean }
export interface Block { ix: number; iz: number; zone: Zone; bounds: AABB; buildings: BuildingDef[] }

export interface RoadNode { id: number; pos: Vec2 }
export interface Lane {
  id: number;
  from: number;
  to: number;
  offset: number;
  points: Vec2[];
  length: number;
}

export interface RoadGraph {
  nodes: RoadNode[];
  lanes: Lane[];
  nearestLane(p: Vec2): { lane: Lane; t: number };
  path(fromLane: number, toLane: number): Lane[];
}

export interface CityData {
  blocks: Block[];
  roads: RoadGraph;
  colliders: AABB[];
  spawns: { player: Vec2; policeStation: Vec2; garages: Vec2[]; missions: Vec2[] };
  beachEdge: 'north' | 'south' | 'east' | 'west';
}

export type VehicleKind = 'sedan' | 'sports' | 'pickup' | 'police';

export interface VehicleState {
  pos: Vec2;
  y: number;
  heading: number;
  speed: number;
  steer: number;
  health: number;
  kind: VehicleKind;
  occupied: boolean;
  wrecked: boolean;
}

export interface System { update(dt: number): void }

/**
 * Something that writes its visual transform once per rendered frame.
 *
 * `alpha` is the fixed-step accumulator fraction (0..1): 0 means "the previous
 * physics state", 1 means "the current one". `dt` is the real wall time since
 * the last rendered frame, for smoothing that must be frame-rate independent.
 */
export interface Renderable { renderSync(alpha: number, dt: number): void }

export type EventName =
  | 'pedHit'
  | 'vehicleHit'
  | 'policeHit'
  | 'enteredVehicle'
  | 'exitedVehicle'
  | 'wantedChanged'
  | 'busted'
  | 'wrecked'
  | 'missionStart'
  | 'missionPassed'
  | 'missionFailed'
  | 'cashChanged';

export interface GameEvents {
  on(evt: EventName, fn: (payload?: unknown) => void): void;
  emit(evt: EventName, payload?: unknown): void;
}

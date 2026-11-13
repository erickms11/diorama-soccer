/**
 * Diorama Soccer 8x8 — World & Match Constants
 * All spatial dimensions are in meters (1.0 = 1 meter in real-world WebXR space).
 */

export const FIELD_LENGTH = 2.46; // X axis: -1.23 to +1.23
export const FIELD_WIDTH = 1.56;  // Z axis: -0.78 to +0.78
export const HALF_LENGTH = FIELD_LENGTH / 2;
export const HALF_WIDTH = FIELD_WIDTH / 2;

export const BASE_WIDTH = 3.26;
export const BASE_DEPTH = 2.34;
export const PITCH_Y = 0.06; // Height of the grass surface above the tabletop base (y = 0)

export const GOAL_WIDTH = 0.32;
export const GOAL_HEIGHT = 0.12;
export const GOAL_DEPTH = 0.095;
export const GOAL_POST_RADIUS = 0.0055;

export const PLAYER_RADIUS = 0.0185;
export const PLAYER_HEIGHT = 0.060;
export const BALL_RADIUS = 0.0135;

export const DEFAULT_DIORAMA_POS = {
  x: 0,
  y: 0.75, // Typical tabletop height above floor
  z: -0.85,
};

export const DEFAULT_DIORAMA_SCALE = 0.54;
export const MIN_DIORAMA_SCALE = 0.25;
export const MAX_DIORAMA_SCALE = 2.2;

export const MATCH_DURATION_SECONDS = 180; // 3-minute match

export const TEAM_BLUE = 0; // Human-controlled team, attacks +X
export const TEAM_RED = 1;  // AI team, attacks -X


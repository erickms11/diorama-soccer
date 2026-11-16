/**
 * Diorama Soccer 8x8 — World & Match Constants
 * All spatial dimensions are in meters (1.0 = 1 meter in real-world WebXR space).
 */

export const FIELD_LENGTH = 3.80; // X axis: -1.90 to +1.90
export const FIELD_WIDTH = 2.40;  // Z axis: -1.20 to +1.20
export const HALF_LENGTH = FIELD_LENGTH / 2;
export const HALF_WIDTH = FIELD_WIDTH / 2;

export const BASE_WIDTH = 4.60;
export const BASE_DEPTH = 3.20;
export const PITCH_Y = 0.06; // Height of the grass surface above the tabletop base (y = 0)

export const GOAL_WIDTH = 0.48;
export const GOAL_HEIGHT = 0.16;
export const GOAL_DEPTH = 0.15;
export const GOAL_POST_RADIUS = 0.009;

export const PLAYER_RADIUS = 0.0245;
export const PLAYER_HEIGHT = 0.079;
export const BALL_RADIUS = 0.0081;

export const DEFAULT_DIORAMA_POS = {
  x: 0,
  y: 0.75, // Typical tabletop height above floor
  z: -0.85,
};

export const DEFAULT_DIORAMA_SCALE = 0.46;
export const MIN_DIORAMA_SCALE = 0.15;
export const MAX_DIORAMA_SCALE = 2.0;

export const MATCH_DURATION_SECONDS = 180; // 3-minute match

export const TEAM_BLUE = 0; // Human-controlled team, attacks +X
export const TEAM_RED = 1;  // AI team, attacks -X


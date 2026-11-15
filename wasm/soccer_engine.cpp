#include <stdint.h>

extern "C" {
  __attribute__((import_module("env"), import_name("sinf"))) float sinf(float x);
  __attribute__((import_module("env"), import_name("cosf"))) float cosf(float x);
  __attribute__((import_module("env"), import_name("atan2f"))) float atan2f(float y, float x);
}

namespace {

constexpr int NUM_PLAYERS = 16;
constexpr int PLAYER_STRIDE = 12;
constexpr int BALL_BUF_LEN = 16;

constexpr int TEAM_BLUE = 0;
constexpr int TEAM_RED = 1;

constexpr int ROLE_GK = 0;
constexpr int ROLE_DEF_L = 1;
constexpr int ROLE_DEF_R = 2;
constexpr int ROLE_MID_L = 3;
constexpr int ROLE_MID_C = 4;
constexpr int ROLE_MID_R = 5;
constexpr int ROLE_FWD_L = 6;
constexpr int ROLE_FWD_R = 7;

constexpr float FIELD_LENGTH = 2.46f;
constexpr float FIELD_WIDTH = 1.56f;
constexpr float HALF_LENGTH = FIELD_LENGTH * 0.5f;
constexpr float HALF_WIDTH = FIELD_WIDTH * 0.5f;

constexpr float GOAL_WIDTH = 0.32f;
constexpr float GOAL_HEIGHT = 0.12f;
constexpr float GOAL_DEPTH = 0.095f;
constexpr float GOAL_POST_RADIUS = 0.0055f;

constexpr float PLAYER_RADIUS = 0.0185f;
constexpr float BALL_RADIUS = 0.0135f;

constexpr float GRAVITY = -3.6f;
constexpr float BALL_RESTITUTION = 0.58f;
constexpr float GRASS_FRICTION = 2.15f;
constexpr float AIR_DRAG = 0.32f;
constexpr float MAGNUS_FACTOR = 0.44f;
constexpr float PI_F = 3.14159265f;

// Player layout (12 floats per player):
// [0] posX, [1] posZ, [2] velX, [3] velZ,
// [4] homeX, [5] homeZ, [6] facing, [7] kickCooldown,
// [8] diveTimer, [9] diveDir, [10] team, [11] role
float g_players[NUM_PLAYERS * PLAYER_STRIDE];

// Ball & Wasm output layout (16 floats):
// [0] posX, [1] posY, [2] posZ,
// [3] velX, [4] velY, [5] velZ,
// [6] spinY, [7] freeTimer,
// [8] goalScoredTeam (-1 none, 0 blue, 1 red),
// [9] aiKickTriggered (0/1), [10] aiKickPower, [11] aiKickShooterIdx,
// [12] supportSpotX, [13] supportSpotZ,
// [14] aiKickAimX, [15] aiKickAimZ
float g_ball[BALL_BUF_LEN];

inline float clampf(float v, float lo, float hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

inline float lerpf(float a, float b, float t) {
  return a + (b - a) * t;
}

inline float absf(float v) {
  return __builtin_fabsf(v);
}

inline float sqrtf_fast(float v) {
  return v > 0.0f ? __builtin_sqrtf(v) : 0.0f;
}

inline float hypotf_fast(float x, float y) {
  return sqrtf_fast(x * x + y * y);
}

inline float minf(float a, float b) {
  return a < b ? a : b;
}

inline float maxf(float a, float b) {
  return a > b ? a : b;
}

inline float get_attack_dir(int team, int currentHalf) {
  const float halfSign = (currentHalf == 1) ? 1.0f : -1.0f;
  const float base = (team == TEAM_BLUE) ? 1.0f : -1.0f;
  return base * halfSign;
}

// Minimum distance from point P(px, pz) to segment AB
float point_to_segment_dist(float px, float pz, float ax, float az, float bx, float bz, float* outT) {
  const float abx = bx - ax;
  const float abz = bz - az;
  const float abLenSq = abx * abx + abz * abz;
  if (abLenSq < 1e-6f) {
    if (outT) *outT = 0.0f;
    return hypotf_fast(px - ax, pz - az);
  }
  const float t = clampf(((px - ax) * abx + (pz - az) * abz) / abLenSq, 0.0f, 1.0f);
  if (outT) *outT = t;
  const float cx = ax + abx * t;
  const float cz = az + abz * t;
  return hypotf_fast(px - cx, pz - cz);
}

void compute_attack_support_spot(int attackTeam, int excludeIdx, int currentHalf) {
  const float attackDir = get_attack_dir(attackTeam, currentHalf);
  const float oppGoalX = attackDir * HALF_LENGTH;
  const float bx = g_ball[0];
  const float bz = g_ball[2];

  float exX = bx;
  float exZ = bz;
  if (excludeIdx >= 0 && excludeIdx < NUM_PLAYERS) {
    exX = g_players[excludeIdx * PLAYER_STRIDE + 0];
    exZ = g_players[excludeIdx * PLAYER_STRIDE + 1];
  }

  float bestScore = -1e9f;
  float bestX = clampf(bx + attackDir * 0.28f, -HALF_LENGTH + 0.16f, HALF_LENGTH - 0.14f);
  float bestZ = clampf(bz > 0.0f ? bz - 0.34f : bz + 0.34f, -HALF_WIDTH + 0.12f, HALF_WIDTH - 0.12f);

  const float xOffsets[4] = {0.16f, 0.32f, 0.50f, 0.68f};
  const float zSlices[5] = {-0.54f, -0.27f, 0.0f, 0.27f, 0.54f};

  for (int ix = 0; ix < 4; ++ix) {
    const float candX = clampf(
      bx + attackDir * xOffsets[ix],
      -HALF_LENGTH + 0.16f,
      HALF_LENGTH - 0.12f
    );
    for (int iz = 0; iz < 5; ++iz) {
      const float candZ = zSlices[iz];

      const float distBall = hypotf_fast(candX - bx, candZ - bz);
      if (distBall < 0.14f) continue;

      const float distCarrier = hypotf_fast(candX - exX, candZ - exZ);
      if (distCarrier < 0.18f) continue;

      // Nearest defender clearance & pass lane interception check
      float minDefDist = 99.0f;
      float minLaneDist = 99.0f;
      for (int j = 0; j < NUM_PLAYERS; ++j) {
        const float* opp = &g_players[j * PLAYER_STRIDE];
        if ((int)opp[10] == attackTeam) continue;
        const float dSpot = hypotf_fast(opp[0] - candX, opp[1] - candZ);
        if (dSpot < minDefDist) minDefDist = dSpot;

        float segT = 0.0f;
        const float dLane = point_to_segment_dist(opp[0], opp[1], bx, bz, candX, candZ, &segT);
        if (segT > 0.08f && segT < 0.96f && dLane < minLaneDist) {
          minLaneDist = dLane;
        }
      }

      const float goalDist = hypotf_fast(oppGoalX - candX, -candZ);
      const float passSafe = minf(minLaneDist, 0.22f) * 3.8f;
      const float spaceScore = minf(minDefDist, 0.36f) * 2.4f;
      const float idealDistScore = 0.55f - absf(distBall - 0.42f) * 1.15f;
      const float shootThreat = maxf(0.0f, (1.45f - goalDist) * 0.65f);

      const float score = passSafe + spaceScore + idealDistScore + shootThreat;
      if (score > bestScore) {
        bestScore = score;
        bestX = candX;
        bestZ = candZ;
      }
    }
  }

  g_ball[12] = bestX;
  g_ball[13] = bestZ;
}

} // namespace

extern "C" {

float* wasm_get_players_ptr() {
  return g_players;
}

float* wasm_get_ball_ptr() {
  return g_ball;
}

int wasm_find_pass_target(int passerIdx, float dirX, float dirZ, int hasInput, int currentHalf) {
  if (passerIdx < 0 || passerIdx >= NUM_PLAYERS) return -1;
  const float* passer = &g_players[passerIdx * PLAYER_STRIDE];
  const int team = (int)passer[10];
  const float attackDir = get_attack_dir(team, currentHalf);
  const float minAlign = hasInput ? 0.15f : -0.10f;

  int bestInCone = -1;
  float bestScore = -1e9f;
  int closestMate = -1;
  float closestDist = 1e9f;

  for (int i = 0; i < NUM_PLAYERS; ++i) {
    if (i == passerIdx) continue;
    const float* mate = &g_players[i * PLAYER_STRIDE];
    if ((int)mate[10] != team || (int)mate[11] == ROLE_GK) continue;

    const float dx = mate[0] - passer[0];
    const float dz = mate[1] - passer[1];
    const float dist = hypotf_fast(dx, dz);
    if (dist < 0.04f) continue;

    if (dist < closestDist) {
      closestDist = dist;
      closestMate = i;
    }

    const float align = (dx * dirX + dz * dirZ) / dist;
    if (align > minAlign) {
      // Penalize teammates tightly covered by an opponent along the pass lane
      float minLaneClearance = 99.0f;
      for (int j = 0; j < NUM_PLAYERS; ++j) {
        const float* opp = &g_players[j * PLAYER_STRIDE];
        if ((int)opp[10] == team) continue;
        float t = 0.0f;
        const float laneD = point_to_segment_dist(
          opp[0], opp[1], passer[0], passer[1], mate[0], mate[1], &t
        );
        if (t > 0.08f && t < 0.95f && laneD < minLaneClearance) {
          minLaneClearance = laneD;
        }
      }
      const float lanePenalty = minLaneClearance < 0.075f ? (0.075f - minLaneClearance) * 8.0f : 0.0f;
      const float forwardGain = dx * attackDir;
      const float score = align * 0.90f - dist * 1.15f + forwardGain * 0.22f - lanePenalty;
      if (score > bestScore) {
        bestScore = score;
        bestInCone = i;
      }
    }
  }

  return bestInCone >= 0 ? bestInCone : closestMate;
}

void wasm_step_tactical_ai(
  float dt,
  int controlledIdx,
  int redPresserIdx,
  int currentHalf,
  float rand01
) {
  g_ball[9] = 0.0f;
  g_ball[10] = 0.0f;
  g_ball[11] = -1.0f;
  g_ball[14] = 0.0f;
  g_ball[15] = 0.0f;

  const float bx = g_ball[0];
  const float by = g_ball[1];
  const float bz = g_ball[2];
  const float bvx = g_ball[3];
  const float bvz = g_ball[5];

  // Calculate dynamic Support Spot for the human's attacking team
  compute_attack_support_spot(TEAM_BLUE, controlledIdx, currentHalf);
  const float spotX = g_ball[12];
  const float spotZ = g_ball[13];

  // Choose best non-GK Blue off-ball attacker closest to the Support Spot
  int blueSupporterIdx = -1;
  float bestSpotDist = 1e9f;
  for (int i = 0; i < NUM_PLAYERS; ++i) {
    if (i == controlledIdx) continue;
    const float* p = &g_players[i * PLAYER_STRIDE];
    if ((int)p[10] != TEAM_BLUE) continue;
    const int role = (int)p[11];
    if (role == ROLE_GK || role == ROLE_DEF_L || role == ROLE_DEF_R) continue;
    const float d = hypotf_fast(p[0] - spotX, p[1] - spotZ);
    if (d < bestSpotDist) {
      bestSpotDist = d;
      blueSupporterIdx = i;
    }
  }

  // Choose secondary Red interpose defender (non-GK, non-presser closest to ball/attacker lane)
  int redInterposeIdx = -1;
  float bestRedSupportDist = 1e9f;
  const float redAttackDir = get_attack_dir(TEAM_RED, currentHalf);
  const float redOwnGoalX = -redAttackDir * HALF_LENGTH;
  const float interposeX = lerpf(bx, redOwnGoalX, 0.36f);
  const float interposeZ = bz * 0.65f;
  for (int i = 0; i < NUM_PLAYERS; ++i) {
    if (i == redPresserIdx) continue;
    const float* p = &g_players[i * PLAYER_STRIDE];
    if ((int)p[10] != TEAM_RED || (int)p[11] == ROLE_GK) continue;
    const float d = hypotf_fast(p[0] - interposeX, p[1] - interposeZ);
    if (d < bestRedSupportDist) {
      bestRedSupportDist = d;
      redInterposeIdx = i;
    }
  }

  for (int i = 0; i < NUM_PLAYERS; ++i) {
    if (i == controlledIdx) continue;
    float* p = &g_players[i * PLAYER_STRIDE];

    const int team = (int)p[10];
    const int role = (int)p[11];
    const float attackDir = get_attack_dir(team, currentHalf);
    const float goalX = attackDir * HALF_LENGTH;
    const float ownGoalX = -attackDir * HALF_LENGTH;

    float targetX = p[4];
    float targetZ = p[5];
    const float distBall = hypotf_fast(bx - p[0], bz - p[1]);

    if (role == ROLE_GK) {
      const bool incomingShot = (bvx * attackDir < -0.22f) && (absf(bx - ownGoalX) < 0.68f);
      float clampedZ = clampf(bz * 0.82f, -GOAL_WIDTH * 0.36f, GOAL_WIDTH * 0.36f);

      if (incomingShot) {
        const float timeToGoal = clampf(
          absf(ownGoalX - bx) / maxf(0.25f, absf(bvx)),
          0.0f,
          0.55f
        );
        const float predictedZ = bz + bvz * timeToGoal;
        clampedZ = clampf(predictedZ, -GOAL_WIDTH * 0.42f, GOAL_WIDTH * 0.42f);

        if (p[8] <= 0.0f && p[7] <= 0.0f && absf(bx - ownGoalX) < 0.56f) {
          p[8] = 0.42f;
          const float dzDive = clampedZ - p[1];
          p[9] = absf(dzDive) > 0.02f ? (dzDive > 0.0f ? 1.0f : -1.0f) : 0.0f;
        }
      }

      targetX = ownGoalX + attackDir * 0.035f;
      targetZ = clampedZ;

      const float saveReach = PLAYER_RADIUS + BALL_RADIUS + (p[8] > 0.0f ? 0.018f : 0.012f);
      const float maxSaveHeight = p[8] > 0.0f ? GOAL_HEIGHT : 0.075f;
      if (distBall < saveReach && p[7] <= 0.0f && by < maxSaveHeight && g_ball[9] < 0.5f) {
        if (p[8] <= 0.0f) {
          p[8] = 0.32f;
          const float dzBall = bz - p[1];
          p[9] = absf(dzBall) > 0.012f ? (dzBall > 0.0f ? 1.0f : -1.0f) : 0.0f;
        }
        g_ball[9] = 1.0f;
        g_ball[10] = 0.62f;
        g_ball[11] = (float)i;
        g_ball[14] = attackDir;
        g_ball[15] = (p[1] >= 0.0f ? 1.0f : -1.0f) * 0.45f;
      }
    } else if (i == redPresserIdx && team == TEAM_RED) {
      const float toGoalX = goalX - bx;
      const float toGoalZ = -bz;
      const float toGoalLen = hypotf_fast(toGoalX, toGoalZ) > 0.0001f ? hypotf_fast(toGoalX, toGoalZ) : 1.0f;

      if ((p[0] - bx) * attackDir > 0.01f && distBall < 0.09f) {
        const float sideSign = p[1] >= bz ? 1.0f : -1.0f;
        targetX = clampf(bx - attackDir * 0.048f, -HALF_LENGTH + 0.06f, HALF_LENGTH - 0.06f);
        targetZ = clampf(bz + sideSign * 0.048f, -HALF_WIDTH + 0.05f, HALF_WIDTH - 0.05f);
      } else if (distBall < 0.06f) {
        targetX = bx + (toGoalX / toGoalLen) * 0.08f;
        targetZ = bz + (toGoalZ / toGoalLen) * 0.08f;
      } else {
        // Predictive pursuit along ball velocity
        targetX = clampf(bx + bvx * 0.14f, -HALF_LENGTH + 0.06f, HALF_LENGTH - 0.06f);
        targetZ = clampf(bz + bvz * 0.14f, -HALF_WIDTH + 0.05f, HALF_WIDTH - 0.05f);
      }

      if (distBall < PLAYER_RADIUS + BALL_RADIUS + 0.028f && p[7] <= 0.0f && by < 0.055f && g_ball[9] < 0.5f) {
        const float distToGoal = hypotf_fast(goalX - bx, -bz);
        if (distToGoal < 0.48f && absf(bx - goalX) < 0.45f) {
          // Finish toward corner away from Blue GK
          float blueGkZ = 0.0f;
          for (int k = 0; k < NUM_PLAYERS; ++k) {
            if ((int)g_players[k * PLAYER_STRIDE + 10] == TEAM_BLUE &&
                (int)g_players[k * PLAYER_STRIDE + 11] == ROLE_GK) {
              blueGkZ = g_players[k * PLAYER_STRIDE + 1];
              break;
            }
          }
          const float baseCorner = (blueGkZ >= 0.0f ? -1.0f : 1.0f) * GOAL_WIDTH * 0.24f;
          const float aimTargetZ = clampf(
            baseCorner + (rand01 - 0.5f) * GOAL_WIDTH * 0.30f,
            -GOAL_WIDTH * 0.35f,
            GOAL_WIDTH * 0.35f
          );
          const float dx = goalX - bx;
          const float dz = aimTargetZ - bz;
          const float d = hypotf_fast(dx, dz) > 0.0001f ? hypotf_fast(dx, dz) : 1.0f;
          g_ball[9] = 1.0f;
          g_ball[10] = 0.58f + rand01 * 0.16f;
          g_ball[11] = (float)i;
          g_ball[14] = dx / d;
          g_ball[15] = dz / d;
          p[7] = 0.58f;
        } else {
          const bool nearPerimeter =
            absf(bx) > HALF_LENGTH - 0.09f || absf(bz) > HALF_WIDTH - 0.09f;
          bool underPressure = false;
          for (int b = 0; b < NUM_PLAYERS; ++b) {
            if ((int)g_players[b * PLAYER_STRIDE + 10] != TEAM_BLUE) continue;
            if (hypotf_fast(g_players[b * PLAYER_STRIDE + 0] - p[0], g_players[b * PLAYER_STRIDE + 1] - p[1]) < 0.08f) {
              underPressure = true;
              break;
            }
          }
          if (nearPerimeter || underPressure || rand01 < 0.035f) {
            int bestMate = -1;
            float bestScore = -1e9f;
            for (int m = 0; m < NUM_PLAYERS; ++m) {
              if (m == i) continue;
              const float* mate = &g_players[m * PLAYER_STRIDE];
              if ((int)mate[10] != TEAM_RED || (int)mate[11] == ROLE_GK) continue;
              const float md = hypotf_fast(mate[0] - p[0], mate[1] - p[1]);
              if (md < 0.12f || md > 0.95f) continue;

              const float forwardGain = (mate[0] - p[0]) * attackDir * 2.0f;
              float oppMinD = 99.0f;
              for (int opp = 0; opp < NUM_PLAYERS; ++opp) {
                if ((int)g_players[opp * PLAYER_STRIDE + 10] != TEAM_BLUE) continue;
                const float od = hypotf_fast(
                  g_players[opp * PLAYER_STRIDE + 0] - mate[0],
                  g_players[opp * PLAYER_STRIDE + 1] - mate[1]
                );
                if (od < oppMinD) oppMinD = od;
              }
              const float score = forwardGain + minf(oppMinD, 0.25f) * 1.4f - md * 0.25f;
              if (score > bestScore) {
                bestScore = score;
                bestMate = m;
              }
            }

            if (bestMate >= 0 &&
                (((g_players[bestMate * PLAYER_STRIDE + 0] - p[0]) * attackDir > 0.04f) ||
                 nearPerimeter || underPressure)) {
              const float px = g_players[bestMate * PLAYER_STRIDE + 0] + attackDir * 0.04f - bx;
              const float pz = g_players[bestMate * PLAYER_STRIDE + 1] - bz;
              const float pd = hypotf_fast(px, pz) > 0.0001f ? hypotf_fast(px, pz) : 1.0f;
              g_ball[9] = 1.0f;
              g_ball[10] = clampf(0.38f + pd * 0.38f, 0.40f, 0.72f);
              g_ball[11] = (float)i;
              g_ball[14] = px / pd;
              g_ball[15] = pz / pd;
              p[7] = 0.48f;
            } else {
              g_ball[9] = 1.0f;
              g_ball[10] = 0.50f;
              g_ball[11] = (float)i;
              g_ball[14] = toGoalX / toGoalLen;
              g_ball[15] = toGoalZ / toGoalLen;
              p[7] = 0.48f;
            }
          }
        }
      }
    } else if (team == TEAM_BLUE) {
      if (i == blueSupporterIdx) {
        // Yuka-style Support Spot movement for open passing option
        targetX = spotX;
        targetZ = spotZ;
      } else {
        const float relHomeX = p[4] * attackDir;
        const float relBallX = bx * attackDir;
        if (role == ROLE_FWD_L || role == ROLE_FWD_R) {
          const float baseAdv = relHomeX + relBallX * 0.82f + 0.30f;
          const float rawX = relBallX > -0.15f ? maxf(baseAdv, relBallX + 0.20f) : baseAdv;
          targetX = clampf(rawX, -HALF_LENGTH + 0.20f, HALF_LENGTH - 0.12f) * attackDir;
          targetZ = clampf(p[5] * 0.88f + bz * 0.32f, -HALF_WIDTH + 0.07f, HALF_WIDTH - 0.07f);
        } else if (role == ROLE_MID_C) {
          if (relBallX < 0.0f) {
            targetX = clampf(relHomeX + relBallX * 0.45f, -HALF_LENGTH + 0.24f, -0.08f) * attackDir;
            targetZ = clampf(bz * 0.52f, -0.28f, 0.28f);
          } else {
            targetX = clampf(relHomeX + relBallX * 0.68f + 0.14f, -HALF_LENGTH + 0.24f, HALF_LENGTH * 0.45f) * attackDir;
            targetZ = clampf(bz * 0.35f, -0.26f, 0.26f);
          }
        } else if (role == ROLE_MID_L || role == ROLE_MID_R) {
          const float tuckFactor = relBallX < 0.0f ? 0.72f : 0.92f;
          const float pushBonus = relBallX > 0.0f ? 0.24f : -0.04f;
          targetX = clampf(relHomeX + relBallX * 0.72f + pushBonus, -HALF_LENGTH + 0.18f, HALF_LENGTH * 0.68f) * attackDir;
          targetZ = clampf(p[5] * tuckFactor + bz * (relBallX < 0.0f ? 0.28f : 0.35f), -HALF_WIDTH + 0.07f, HALF_WIDTH - 0.07f);
        } else {
          // Center-backs (DEF_L / DEF_R): compact central defensive block
          const float slotZ = (role == ROLE_DEF_L ? -1.0f : 1.0f) * 0.085f * attackDir;
          if (relBallX < 0.15f) {
            const float goalSideX = minf(relHomeX + relBallX * 0.38f, relBallX - 0.14f);
            targetX = clampf(goalSideX, -HALF_LENGTH + 0.13f, -0.18f) * attackDir;
            targetZ = clampf(bz * 0.52f + slotZ, -GOAL_WIDTH * 0.85f, GOAL_WIDTH * 0.85f);
          } else {
            targetX = clampf(relHomeX + relBallX * 0.35f, -HALF_LENGTH + 0.16f, -0.16f) * attackDir;
            targetZ = clampf(p[5] * 0.75f + bz * 0.25f, -GOAL_WIDTH * 1.05f, GOAL_WIDTH * 1.05f);
          }
        }
      }
    } else {
      // Red AI off-ball tactical runs & secondary Interpose shadow cover
      const float relHomeX = p[4] * attackDir;
      const float relBallX = bx * attackDir;
      if (i == redInterposeIdx && relBallX < 0.15f) {
        // Interpose between ball/attacker and own goal corridor
        targetX = clampf(lerpf(bx, ownGoalX, 0.34f), -HALF_LENGTH + 0.18f, HALF_LENGTH - 0.18f);
        targetZ = clampf(bz * 0.62f, -HALF_WIDTH + 0.08f, HALF_WIDTH - 0.08f);
      } else if (role == ROLE_FWD_L || role == ROLE_FWD_R) {
        const float pushBonus = relBallX > 0.0f ? 0.26f : 0.0f;
        const float rawX = relBallX > -0.15f
          ? maxf(relHomeX + relBallX * 0.78f + pushBonus, relBallX + 0.18f)
          : relHomeX + relBallX * 0.72f;
        targetX = clampf(rawX, -HALF_LENGTH + 0.18f, HALF_LENGTH - 0.14f) * attackDir;
        targetZ = clampf(p[5] * 0.88f + bz * 0.34f, -HALF_WIDTH + 0.06f, HALF_WIDTH - 0.06f);
      } else if (role == ROLE_MID_L || role == ROLE_MID_C || role == ROLE_MID_R) {
        const float pushBonus = relBallX > 0.0f ? 0.20f : -0.06f;
        targetX = clampf(relHomeX + relBallX * 0.70f + pushBonus, -HALF_LENGTH + 0.18f, HALF_LENGTH * 0.68f) * attackDir;
        targetZ = clampf(p[5] * 0.90f + bz * 0.36f, -HALF_WIDTH + 0.06f, HALF_WIDTH - 0.06f);
      } else {
        const float dropBonus = relBallX < 0.0f ? -0.18f : 0.10f;
        targetX = clampf(relHomeX + relBallX * 0.55f + dropBonus, -HALF_LENGTH + 0.14f, HALF_LENGTH * 0.25f) * attackDir;
        targetZ = clampf(p[5] + bz * 0.30f, -HALF_WIDTH + 0.06f, HALF_WIDTH - 0.06f);
      }
    }

    // Teammate spacing separation
    if (role != ROLE_GK && !(i == redPresserIdx && team == TEAM_RED)) {
      const float minSpace = (role == ROLE_DEF_L || role == ROLE_DEF_R) ? 0.10f : 0.18f;
      for (int m = 0; m < NUM_PLAYERS; ++m) {
        if (m == i) continue;
        const float* mate = &g_players[m * PLAYER_STRIDE];
        if ((int)mate[10] != team) continue;
        const float sx = p[0] - mate[0];
        const float sz = p[1] - mate[1];
        const float sd = hypotf_fast(sx, sz);
        if (sd > 0.001f && sd < minSpace) {
          const float push = (minSpace - sd) * 0.65f;
          targetX = clampf(targetX + (sx / sd) * push, -HALF_LENGTH + 0.08f, HALF_LENGTH - 0.08f);
          targetZ = clampf(targetZ + (sz / sd) * push, -HALF_WIDTH + 0.06f, HALF_WIDTH - 0.06f);
        }
      }
    }

    const float dx = targetX - p[0];
    const float dz = targetZ - p[1];
    const float dist = hypotf_fast(dx, dz);
    float maxSpeed = 0.21f;
    if (role == ROLE_GK) {
      if (p[8] > 0.0f) maxSpeed = (team == TEAM_BLUE) ? 0.34f : 0.29f;
      else maxSpeed = (team == TEAM_BLUE) ? 0.22f : 0.19f;
    } else if (team == TEAM_BLUE) {
      maxSpeed = 0.28f;
    } else if (i == redPresserIdx) {
      maxSpeed = 0.25f;
    }

    const float velLerp = (role == ROLE_GK && p[8] > 0.0f) ? minf(1.0f, dt * 13.0f) : minf(1.0f, dt * 7.5f);
    if (dist > 0.015f) {
      const float stepSpeed = minf(maxSpeed, dist * 3.4f);
      p[2] = lerpf(p[2], (dx / dist) * stepSpeed, velLerp);
      p[3] = lerpf(p[3], (dz / dist) * stepSpeed, velLerp);
      if (role == ROLE_GK && p[8] > 0.0f) {
        p[6] = attackDir > 0.0f ? 0.0f : PI_F;
      } else {
        p[6] = atan2f(-p[3], p[2]);
      }
    } else {
      const float stopLerp = minf(1.0f, dt * 8.5f);
      p[2] = lerpf(p[2], 0.0f, stopLerp);
      p[3] = lerpf(p[3], 0.0f, stopLerp);
      if (role == ROLE_GK && p[8] > 0.0f) {
        p[6] = attackDir > 0.0f ? 0.0f : PI_F;
      } else {
        p[6] = atan2f(-(bz - p[1]), bx - p[0]);
      }
    }

    p[0] = clampf(p[0] + p[2] * dt, -HALF_LENGTH - 0.01f, HALF_LENGTH + 0.01f);
    p[1] = clampf(p[1] + p[3] * dt, -HALF_WIDTH - 0.01f, HALF_WIDTH + 0.01f);
  }
}

void wasm_resolve_player_collisions() {
  const float minDist = PLAYER_RADIUS * 2.0f;
  const float pad = 0.01f;

  for (int i = 0; i < NUM_PLAYERS; ++i) {
    float* a = &g_players[i * PLAYER_STRIDE];
    for (int j = i + 1; j < NUM_PLAYERS; ++j) {
      float* b = &g_players[j * PLAYER_STRIDE];
      const float dx = b[0] - a[0];
      const float dz = b[1] - a[1];
      const float dist = hypotf_fast(dx, dz);
      if (dist < minDist) {
        if (dist > 0.0001f) {
          const float overlap = (minDist - dist) * 0.5f;
          const float nx = dx / dist;
          const float nz = dz / dist;
          const float slide = overlap * 0.35f;
          const float tx = -nz * slide;
          const float tz = nx * slide;
          a[0] = clampf(a[0] - nx * overlap + tx, -HALF_LENGTH - pad, HALF_LENGTH + pad);
          a[1] = clampf(a[1] - nz * overlap + tz, -HALF_WIDTH - pad, HALF_WIDTH + pad);
          b[0] = clampf(b[0] + nx * overlap - tx, -HALF_LENGTH - pad, HALF_LENGTH + pad);
          b[1] = clampf(b[1] + nz * overlap - tz, -HALF_WIDTH - pad, HALF_WIDTH + pad);
        } else {
          const float jitter = minDist * 0.5f;
          a[1] = clampf(a[1] - jitter, -HALF_WIDTH - pad, HALF_WIDTH + pad);
          b[1] = clampf(b[1] + jitter, -HALF_WIDTH - pad, HALF_WIDTH + pad);
        }
      }
    }
  }
}

void wasm_step_ball_physics(float dt, int detectGoals, int currentHalf) {
  g_ball[8] = -1.0f;

  float bx = g_ball[0];
  float by = g_ball[1];
  float bz = g_ball[2];
  float vx = g_ball[3];
  float vy = g_ball[4];
  float vz = g_ball[5];
  float spinY = g_ball[6];

  // Magnus curve acceleration perpendicular to horizontal velocity
  if (absf(spinY) > 0.01f) {
    const float hSpeed = hypotf_fast(vx, vz);
    if (hSpeed > 0.08f) {
      const float magnusAx = -spinY * vz * MAGNUS_FACTOR;
      const float magnusAz = spinY * vx * MAGNUS_FACTOR;
      vx += magnusAx * dt;
      vz += magnusAz * dt;
    }
    const float spinDecay = (by > BALL_RADIUS + 0.002f) ? maxf(0.0f, 1.0f - dt * 0.85f) : maxf(0.0f, 1.0f - dt * 2.8f);
    spinY *= spinDecay;
  } else {
    spinY = 0.0f;
  }

  vy += GRAVITY * dt;
  bx += vx * dt;
  by += vy * dt;
  bz += vz * dt;

  // Ground bounce & grass friction
  if (by <= BALL_RADIUS) {
    by = BALL_RADIUS;
    if (vy < -0.18f) {
      vy = -vy * BALL_RESTITUTION;
    } else {
      vy = 0.0f;
    }
    const float frictionFactor = maxf(0.0f, 1.0f - GRASS_FRICTION * dt);
    vx *= frictionFactor;
    vz *= frictionFactor;
  } else {
    const float airFactor = maxf(0.0f, 1.0f - AIR_DRAG * dt);
    vx *= airFactor;
    vz *= airFactor;
  }

  // Touchline cushions (north & south)
  const float maxZ = HALF_WIDTH + 0.01f - BALL_RADIUS;
  if (bz > maxZ) {
    bz = maxZ;
    vz = -absf(vz) * 0.75f;
  } else if (bz < -maxZ) {
    bz = -maxZ;
    vz = absf(vz) * 0.75f;
  }

  // Goal post collisions
  const float halfG = GOAL_WIDTH * 0.5f;
  for (int xi = -1; xi <= 1; xi += 2) {
    for (int zi = -1; zi <= 1; zi += 2) {
      const float postX = (float)xi * HALF_LENGTH;
      const float postZ = (float)zi * halfG;
      if (by < GOAL_HEIGHT + BALL_RADIUS) {
        const float dx = bx - postX;
        const float dz = bz - postZ;
        const float dist = hypotf_fast(dx, dz);
        const float minD = BALL_RADIUS + GOAL_POST_RADIUS;
        if (dist < minD && dist > 0.0001f) {
          const float nx = dx / dist;
          const float nz = dz / dist;
          bx = postX + nx * minD;
          bz = postZ + nz * minD;
          const float dot = vx * nx + vz * nz;
          if (dot < 0.0f) {
            vx -= 1.7f * dot * nx;
            vz -= 1.7f * dot * nz;
          }
        }
      }
    }
  }

  // Goal detection & endline cushions
  const bool inGoalMouthZ = absf(bz) < halfG - BALL_RADIUS * 0.3f;
  const bool underCrossbar = by < GOAL_HEIGHT;

  if (inGoalMouthZ && underCrossbar) {
    if (absf(bx) > HALF_LENGTH) {
      if (detectGoals) {
        const bool enteredPosX = bx > 0.0f;
        const int scoringTeam = (currentHalf == 1)
          ? (enteredPosX ? TEAM_BLUE : TEAM_RED)
          : (enteredPosX ? TEAM_RED : TEAM_BLUE);
        g_ball[8] = (float)scoringTeam;
      }

      const float maxNetX = HALF_LENGTH + GOAL_DEPTH - BALL_RADIUS;
      if (bx > maxNetX) {
        bx = maxNetX;
        vx *= -0.3f;
      } else if (bx < -maxNetX) {
        bx = -maxNetX;
        vx *= -0.3f;
      }
      if (absf(bz) > halfG - BALL_RADIUS) {
        bz = (bz >= 0.0f ? 1.0f : -1.0f) * (halfG - BALL_RADIUS);
        vz *= -0.35f;
      }
    }
  } else {
    const float maxX = HALF_LENGTH + 0.01f - BALL_RADIUS;
    if (bx > maxX) {
      bx = maxX;
      vx = -absf(vx) * 0.72f;
    } else if (bx < -maxX) {
      bx = -maxX;
      vx = absf(vx) * 0.72f;
    }
  }

  g_ball[0] = bx;
  g_ball[1] = by;
  g_ball[2] = bz;
  g_ball[3] = vx;
  g_ball[4] = vy;
  g_ball[5] = vz;
  g_ball[6] = spinY;
}

} // extern "C"

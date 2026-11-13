import * as THREE from 'three';
import {
  BALL_RADIUS,
  GOAL_DEPTH,
  GOAL_HEIGHT,
  GOAL_POST_RADIUS,
  GOAL_WIDTH,
  HALF_LENGTH,
  HALF_WIDTH,
  MATCH_DURATION_SECONDS,
  PLAYER_RADIUS,
  TEAM_BLUE,
  TEAM_RED,
} from './constants';

export type PlayerRole = 'GK' | 'DEF_L' | 'DEF_R' | 'FWD_L' | 'FWD_R';

export interface PlayerEntity {
  id: number;
  team: 0 | 1;
  role: PlayerRole;
  mesh: THREE.Group;
  bodyMesh: THREE.Group;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  homePos: THREE.Vector3;
  facingAngle: number;
  kickCooldown: number;
  animPhase: number;
  kickAnim: number;
}

export interface MatchInputState {
  moveX: number;      // Local field X (-1..1), already camera-relative
  moveZ: number;      // Local field Z (-1..1), already camera-relative
  sprint: boolean;
  kickHeld: boolean;
  switchPressed: boolean;
}

export interface MatchCallbacks {
  onScoreChange?: (blue: number, red: number, timeText: string, statusText: string) => void;
  onGoal?: (scoringTeam: 0 | 1) => void;
  onKick?: (power: number) => void;
}

const GRAVITY = -4.5;
const BALL_RESTITUTION = 0.65;
const GRASS_FRICTION = 2.6;
const AIR_DRAG = 0.35;

/**
 * 5v5 soccer simulation running inside `fieldRoot` (where y = 0 is the grass).
 */
export class MatchSimulation {
  public blueScore = 0;
  public redScore = 0;
  public remainingSeconds = MATCH_DURATION_SECONDS;

  private readonly fieldRoot: THREE.Group;
  private readonly callbacks: MatchCallbacks;

  private readonly players: PlayerEntity[] = [];
  private controlledIndex = 3; // Start controlling Blue FWD_L

  private readonly ballMesh: THREE.Group;
  private readonly ballPos = new THREE.Vector3(0, BALL_RADIUS, 0);
  private readonly ballVel = new THREE.Vector3(0, 0, 0);
  private readonly ballSphereMesh: THREE.Mesh;

  private readonly selectionRing: THREE.Mesh;
  private readonly selectionArrow: THREE.Mesh;
  private readonly chargeBarBg: THREE.Mesh;
  private readonly chargeBarFill: THREE.Mesh;

  private kickCharge = 0;
  private wasKickHeld = false;
  private goalResetTimer = 0;
  private statusText = '';
  private matchEnded = false;

  constructor(fieldRoot: THREE.Group, callbacks: MatchCallbacks = {}) {
    this.fieldRoot = fieldRoot;
    this.callbacks = callbacks;

    // Ball mesh (white sphere with dark pentagon-like stripes)
    this.ballMesh = new THREE.Group();
    const ballGeo = new THREE.SphereGeometry(BALL_RADIUS, 16, 12);
    const ballMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.35,
      metalness: 0.05,
    });
    this.ballSphereMesh = new THREE.Mesh(ballGeo, ballMat);
    this.ballSphereMesh.castShadow = true;
    this.ballMesh.add(this.ballSphereMesh);

    const bandMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.5 });
    const band1 = new THREE.Mesh(
      new THREE.TorusGeometry(BALL_RADIUS * 0.96, BALL_RADIUS * 0.14, 6, 16),
      bandMat
    );
    this.ballSphereMesh.add(band1);
    const band2 = band1.clone();
    band2.rotation.y = Math.PI / 2;
    this.ballSphereMesh.add(band2);

    // Subtle ground shadow disc under the ball
    const shadowDisc = new THREE.Mesh(
      new THREE.CircleGeometry(BALL_RADIUS * 1.1, 16),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 })
    );
    shadowDisc.rotation.x = -Math.PI / 2;
    shadowDisc.position.y = 0.001;
    this.fieldRoot.add(shadowDisc);
    this.ballMesh.userData.shadowDisc = shadowDisc;

    this.fieldRoot.add(this.ballMesh);

    // Selection indicator for active Blue player
    this.selectionRing = new THREE.Mesh(
      new THREE.RingGeometry(PLAYER_RADIUS * 1.15, PLAYER_RADIUS * 1.55, 24),
      new THREE.MeshBasicMaterial({
        color: 0xfacc15,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.92,
      })
    );
    this.selectionRing.rotation.x = -Math.PI / 2;
    this.selectionRing.position.y = 0.002;
    this.fieldRoot.add(this.selectionRing);

    this.selectionArrow = new THREE.Mesh(
      new THREE.ConeGeometry(0.009, 0.016, 4),
      new THREE.MeshBasicMaterial({ color: 0xfacc15 })
    );
    this.selectionArrow.rotation.x = Math.PI;
    this.fieldRoot.add(this.selectionArrow);

    // Charge power bar above controlled player
    this.chargeBarBg = new THREE.Mesh(
      new THREE.PlaneGeometry(0.036, 0.006),
      new THREE.MeshBasicMaterial({ color: 0x0f172a, side: THREE.DoubleSide })
    );
    this.chargeBarFill = new THREE.Mesh(
      new THREE.PlaneGeometry(0.032, 0.004),
      new THREE.MeshBasicMaterial({ color: 0x22c55e, side: THREE.DoubleSide })
    );
    this.chargeBarFill.position.z = 0.0005;
    this.chargeBarBg.add(this.chargeBarFill);
    this.chargeBarBg.visible = false;
    this.fieldRoot.add(this.chargeBarBg);

    this.spawnTeams();
    this.resetKickoff();
  }

  public resetMatch(): void {
    this.blueScore = 0;
    this.redScore = 0;
    this.remainingSeconds = MATCH_DURATION_SECONDS;
    this.matchEnded = false;
    this.goalResetTimer = 0;
    this.statusText = '';
    this.resetKickoff();
    this.emitScore();
  }

  public resetKickoff(): void {
    this.ballPos.set(0, BALL_RADIUS + 0.015, 0);
    this.ballVel.set(0, 0, 0);
    this.kickCharge = 0;
    this.wasKickHeld = false;

    for (const p of this.players) {
      p.pos.copy(p.homePos);
      p.vel.set(0, 0, 0);
      p.facingAngle = p.team === TEAM_BLUE ? 0 : Math.PI;
      p.kickCooldown = 0;
      p.kickAnim = 0;
      this.syncPlayerMesh(p);
    }
    this.controlledIndex = 3;
    this.syncBallMesh();
  }

  public update(dt: number, elapsedTime: number, input: MatchInputState, cameraWorldPos: THREE.Vector3): void {
    const safeDt = Math.min(dt, 0.05);

    if (this.matchEnded) {
      this.updateIndicators(elapsedTime, cameraWorldPos);
      return;
    }

    if (this.goalResetTimer > 0) {
      this.goalResetTimer -= safeDt;
      this.updateBallPhysics(safeDt, false);
      this.syncBallMesh();
      this.updateIndicators(elapsedTime, cameraWorldPos);
      if (this.goalResetTimer <= 0) {
        this.statusText = '';
        this.resetKickoff();
        this.emitScore();
      }
      return;
    }

    // Match countdown
    this.remainingSeconds = Math.max(0, this.remainingSeconds - safeDt);
    if (this.remainingSeconds <= 0) {
      this.matchEnded = true;
      if (this.blueScore > this.redScore) {
        this.statusText = 'FIM DE JOGO: AZUL VENCEU!';
      } else if (this.redScore > this.blueScore) {
        this.statusText = 'FIM DE JOGO: VERMELHO VENCEU!';
      } else {
        this.statusText = 'FIM DE JOGO: EMPATE!';
      }
      this.emitScore();
      return;
    }

    // Handle manual player switching
    if (input.switchPressed) {
      this.switchToClosestBluePlayer();
    }

    // Handle human kick charging / release
    this.handleHumanKick(safeDt, input);

    // Update all 10 players
    const closestBlueAI = this.findClosestOutfieldIndex(TEAM_BLUE, this.controlledIndex);
    const closestRedAI = this.findClosestOutfieldIndex(TEAM_RED, -1);

    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      p.kickCooldown = Math.max(0, p.kickCooldown - safeDt);
      p.kickAnim = Math.max(0, p.kickAnim - safeDt * 4);

      if (i === this.controlledIndex) {
        this.updateHumanPlayer(p, safeDt, input);
      } else {
        const isPresser = i === closestBlueAI || i === closestRedAI;
        this.updateAIPlayer(p, safeDt, isPresser);
      }
    }

    this.resolvePlayerCollisions();
    this.resolveBallPlayerInteractions();
    this.updateBallPhysics(safeDt, true);

    this.syncBallMesh();
    for (const p of this.players) {
      this.syncPlayerMesh(p);
    }
    this.updateIndicators(elapsedTime, cameraWorldPos);
    this.emitScore();
  }

  private spawnTeams(): void {
    const formations: Array<{ role: PlayerRole; x: number; z: number }> = [
      { role: 'GK', x: -HALF_LENGTH + 0.045, z: 0 },
      { role: 'DEF_L', x: -HALF_LENGTH * 0.56, z: -HALF_WIDTH * 0.36 },
      { role: 'DEF_R', x: -HALF_LENGTH * 0.56, z: HALF_WIDTH * 0.36 },
      { role: 'FWD_L', x: -HALF_LENGTH * 0.18, z: -HALF_WIDTH * 0.28 },
      { role: 'FWD_R', x: -HALF_LENGTH * 0.18, z: HALF_WIDTH * 0.28 },
    ];

    let id = 0;
    for (const team of [TEAM_BLUE, TEAM_RED] as const) {
      for (let i = 0; i < formations.length; i++) {
        const f = formations[i];
        const x = team === TEAM_BLUE ? f.x : -f.x;
        const z = team === TEAM_BLUE ? f.z : -f.z;
        const { root, body } = this.createPlayerMesh(team, f.role === 'GK');
        this.fieldRoot.add(root);

        this.players.push({
          id: id++,
          team,
          role: f.role,
          mesh: root,
          bodyMesh: body,
          pos: new THREE.Vector3(x, 0, z),
          vel: new THREE.Vector3(),
          homePos: new THREE.Vector3(x, 0, z),
          facingAngle: team === TEAM_BLUE ? 0 : Math.PI,
          kickCooldown: 0,
          animPhase: i * 1.3,
          kickAnim: 0,
        });
      }
    }
  }

  private createPlayerMesh(team: 0 | 1, isKeeper: boolean): { root: THREE.Group; body: THREE.Group } {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);

    const jerseyColor =
      team === TEAM_BLUE
        ? isKeeper ? 0x06b6d4 : 0x2563eb
        : isKeeper ? 0xf97316 : 0xdc2626;
    const shortsColor = team === TEAM_BLUE ? 0x1e3a8a : 0x7f1d1d;

    // Circular tabletop base disc
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(PLAYER_RADIUS * 0.92, PLAYER_RADIUS, 0.006, 16),
      new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.45 })
    );
    base.position.y = 0.003;
    base.castShadow = true;
    root.add(base);

    // Shorts / lower torso
    const shorts = new THREE.Mesh(
      new THREE.CylinderGeometry(0.013, 0.0155, 0.017, 12),
      new THREE.MeshStandardMaterial({ color: shortsColor, roughness: 0.6 })
    );
    shorts.position.y = 0.016;
    shorts.castShadow = true;
    body.add(shorts);

    // Jersey / upper torso
    const torso = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0145, 0.013, 0.022, 12),
      new THREE.MeshStandardMaterial({ color: jerseyColor, roughness: 0.5 })
    );
    torso.position.y = 0.035;
    torso.castShadow = true;
    body.add(torso);

    // Head
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.0115, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0xf1c27d, roughness: 0.65 })
    );
    head.position.y = 0.056;
    head.castShadow = true;
    body.add(head);

    // Small facing visor/cap detail along +X local axis so orientation is unmistakable
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.007, 0.0045, 0.012),
      new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.3 })
    );
    visor.position.set(0.011, 0.057, 0);
    body.add(visor);

    return { root, body };
  }

  private updateHumanPlayer(p: PlayerEntity, dt: number, input: MatchInputState): void {
    const len = Math.hypot(input.moveX, input.moveZ);
    const maxSpeed = input.sprint ? 0.50 : 0.36;

    if (len > 0.08) {
      const clamped = Math.min(1, len);
      const dirX = input.moveX / len;
      const dirZ = input.moveZ / len;
      const targetVx = dirX * maxSpeed * clamped;
      const targetVz = dirZ * maxSpeed * clamped;

      p.vel.x = THREE.MathUtils.lerp(p.vel.x, targetVx, Math.min(1, dt * 14));
      p.vel.z = THREE.MathUtils.lerp(p.vel.z, targetVz, Math.min(1, dt * 14));
      p.facingAngle = Math.atan2(-dirZ, dirX);
    } else {
      p.vel.x = THREE.MathUtils.lerp(p.vel.x, 0, Math.min(1, dt * 12));
      p.vel.z = THREE.MathUtils.lerp(p.vel.z, 0, Math.min(1, dt * 12));
    }

    p.pos.x += p.vel.x * dt;
    p.pos.z += p.vel.z * dt;
    this.clampPlayerToPitch(p);

    const speed = Math.hypot(p.vel.x, p.vel.z);
    p.animPhase += speed * dt * 28;
  }

  private handleHumanKick(dt: number, input: MatchInputState): void {
    const p = this.players[this.controlledIndex];
    const distToBall = Math.hypot(this.ballPos.x - p.pos.x, this.ballPos.z - p.pos.z);

    if (input.kickHeld) {
      this.kickCharge = Math.min(1, this.kickCharge + dt * 1.9);
      this.wasKickHeld = true;
    } else if (this.wasKickHeld) {
      // Released kick button
      this.wasKickHeld = false;
      const power = 0.35 + this.kickCharge * 0.65;
      this.kickCharge = 0;

      if (distToBall < PLAYER_RADIUS + BALL_RADIUS + 0.045 && this.ballPos.y < 0.07) {
        this.performKick(p, power, input.moveX, input.moveZ);
      } else {
        // If ball isn't at feet when tapping kick, switch to closest Blue player
        if (power < 0.55) {
          this.switchToClosestBluePlayer();
        }
      }
    }
  }

  private performKick(p: PlayerEntity, power: number, aimX = 0, aimZ = 0): void {
    let dirX = Math.cos(p.facingAngle);
    let dirZ = -Math.sin(p.facingAngle);

    if (Math.hypot(aimX, aimZ) > 0.2) {
      const len = Math.hypot(aimX, aimZ);
      dirX = aimX / len;
      dirZ = aimZ / len;
      p.facingAngle = Math.atan2(-dirZ, dirX);
    }

    // Gentle pass/shot assist toward teammates or goal in front of player
    if (p.team === TEAM_BLUE && power < 0.68) {
      const mate = this.findPassTarget(p, dirX, dirZ);
      if (mate) {
        const dx = mate.pos.x - p.pos.x;
        const dz = mate.pos.z - p.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        dirX = THREE.MathUtils.lerp(dirX, dx / d, 0.55);
        dirZ = THREE.MathUtils.lerp(dirZ, dz / d, 0.55);
        const norm = Math.hypot(dirX, dirZ) || 1;
        dirX /= norm;
        dirZ /= norm;
      }
    }

    const speed = 0.55 + power * 0.72;
    this.ballVel.x = dirX * speed + p.vel.x * 0.25;
    this.ballVel.z = dirZ * speed + p.vel.z * 0.25;
    this.ballVel.y = 0.12 + power * 0.48;

    p.kickCooldown = 0.28;
    p.kickAnim = 1;
    this.callbacks.onKick?.(power);
  }

  private updateAIPlayer(p: PlayerEntity, dt: number, isPresser: boolean): void {
    const attackDir = p.team === TEAM_BLUE ? 1 : -1;
    const goalX = attackDir * HALF_LENGTH;
    const ownGoalX = -attackDir * HALF_LENGTH;

    const target = new THREE.Vector3().copy(p.homePos);
    const distBall = Math.hypot(this.ballPos.x - p.pos.x, this.ballPos.z - p.pos.z);

    if (p.role === 'GK') {
      // Goalkeeper tracks ball Z inside goal width and rushes if ball is very close
      const clampedZ = THREE.MathUtils.clamp(this.ballPos.z, -GOAL_WIDTH * 0.45, GOAL_WIDTH * 0.45);
      target.set(ownGoalX + attackDir * 0.045, 0, clampedZ);
      if (Math.abs(this.ballPos.x - ownGoalX) < 0.16 && Math.abs(this.ballPos.z) < GOAL_WIDTH * 0.7) {
        target.set(this.ballPos.x, 0, this.ballPos.z);
      }
      // Clear ball immediately if within kick reach
      if (distBall < PLAYER_RADIUS + BALL_RADIUS + 0.022 && p.kickCooldown <= 0 && this.ballPos.y < 0.06) {
        const clearZ = (p.pos.z >= 0 ? 1 : -1) * 0.25;
        this.performKick(p, 0.75, attackDir, clearZ);
      }
    } else if (isPresser) {
      // Chase the ball
      target.set(this.ballPos.x, 0, this.ballPos.z);
      if (distBall < PLAYER_RADIUS + BALL_RADIUS + 0.025 && p.kickCooldown <= 0 && this.ballPos.y < 0.05) {
        const distToGoal = Math.hypot(goalX - p.pos.x, -p.pos.z);
        if (distToGoal < 0.42) {
          // Shoot toward opponent goal with slight corner offset
          const targetZ = p.pos.z > 0 ? -GOAL_WIDTH * 0.25 : GOAL_WIDTH * 0.25;
          const dx = goalX - p.pos.x;
          const dz = targetZ - p.pos.z;
          const d = Math.hypot(dx, dz) || 1;
          this.performKick(p, 0.78, dx / d, dz / d);
        } else if (Math.random() < 0.04) {
          // Occasional forward pass
          this.performKick(p, 0.55, attackDir, (Math.random() - 0.5) * 0.5);
        }
      }
    } else {
      // Shift formation dynamically with ball position
      const shiftX = this.ballPos.x * 0.42;
      const shiftZ = this.ballPos.z * 0.28;
      target.x = THREE.MathUtils.clamp(p.homePos.x + shiftX, -HALF_LENGTH + 0.08, HALF_LENGTH - 0.08);
      target.z = THREE.MathUtils.clamp(p.homePos.z + shiftZ, -HALF_WIDTH + 0.05, HALF_WIDTH - 0.05);
    }

    const dx = target.x - p.pos.x;
    const dz = target.z - p.pos.z;
    const dist = Math.hypot(dx, dz);
    const maxSpeed = p.role === 'GK' ? 0.26 : isPresser ? 0.30 : 0.25;

    if (dist > 0.015) {
      const stepSpeed = Math.min(maxSpeed, dist * 4.5);
      p.vel.x = THREE.MathUtils.lerp(p.vel.x, (dx / dist) * stepSpeed, Math.min(1, dt * 10));
      p.vel.z = THREE.MathUtils.lerp(p.vel.z, (dz / dist) * stepSpeed, Math.min(1, dt * 10));
      p.facingAngle = Math.atan2(-p.vel.z, p.vel.x);
    } else {
      p.vel.x = THREE.MathUtils.lerp(p.vel.x, 0, Math.min(1, dt * 10));
      p.vel.z = THREE.MathUtils.lerp(p.vel.z, 0, Math.min(1, dt * 10));
      // Look at the ball when idle
      p.facingAngle = Math.atan2(-(this.ballPos.z - p.pos.z), this.ballPos.x - p.pos.x);
    }

    p.pos.x += p.vel.x * dt;
    p.pos.z += p.vel.z * dt;
    this.clampPlayerToPitch(p);

    const speed = Math.hypot(p.vel.x, p.vel.z);
    p.animPhase += speed * dt * 26;
  }

  private resolvePlayerCollisions(): void {
    const minDist = PLAYER_RADIUS * 2;
    for (let i = 0; i < this.players.length; i++) {
      for (let j = i + 1; j < this.players.length; j++) {
        const a = this.players[i];
        const b = this.players[j];
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.0001 && dist < minDist) {
          const overlap = (minDist - dist) * 0.5;
          const nx = dx / dist;
          const nz = dz / dist;
          a.pos.x -= nx * overlap;
          a.pos.z -= nz * overlap;
          b.pos.x += nx * overlap;
          b.pos.z += nz * overlap;
        }
      }
    }
  }

  private resolveBallPlayerInteractions(): void {
    const contactDist = PLAYER_RADIUS + BALL_RADIUS;

    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (p.kickCooldown > 0 || this.ballPos.y > 0.055) continue;

      const dx = this.ballPos.x - p.pos.x;
      const dz = this.ballPos.z - p.pos.z;
      const dist = Math.hypot(dx, dz);

      if (dist < contactDist) {
        const nx = dist > 0.0001 ? dx / dist : Math.cos(p.facingAngle);
        const nz = dist > 0.0001 ? dz / dist : -Math.sin(p.facingAngle);

        // Push ball cleanly outside player body
        this.ballPos.x = p.pos.x + nx * (contactDist + 0.001);
        this.ballPos.z = p.pos.z + nz * (contactDist + 0.001);

        // Soft dribble forward in player's facing/movement direction
        const dribbleX = Math.cos(p.facingAngle) * 0.12 + p.vel.x * 1.18;
        const dribbleZ = -Math.sin(p.facingAngle) * 0.12 + p.vel.z * 1.18;
        this.ballVel.x = THREE.MathUtils.lerp(this.ballVel.x, dribbleX, 0.72);
        this.ballVel.z = THREE.MathUtils.lerp(this.ballVel.z, dribbleZ, 0.72);

        // Auto-switch to a Blue outfielder who takes possession
        if (p.team === TEAM_BLUE && p.role !== 'GK' && i !== this.controlledIndex) {
          this.controlledIndex = i;
        }
      }
    }
  }

  private updateBallPhysics(dt: number, detectGoals: boolean): void {
    this.ballVel.y += GRAVITY * dt;
    this.ballPos.addScaledVector(this.ballVel, dt);

    // Ground bounce & grass friction
    if (this.ballPos.y <= BALL_RADIUS) {
      this.ballPos.y = BALL_RADIUS;
      if (this.ballVel.y < -0.18) {
        this.ballVel.y = -this.ballVel.y * BALL_RESTITUTION;
      } else {
        this.ballVel.y = 0;
      }

      const frictionFactor = Math.max(0, 1 - GRASS_FRICTION * dt);
      this.ballVel.x *= frictionFactor;
      this.ballVel.z *= frictionFactor;
    } else {
      const airFactor = Math.max(0, 1 - AIR_DRAG * dt);
      this.ballVel.x *= airFactor;
      this.ballVel.z *= airFactor;
    }

    // Touchline cushions (north & south)
    const maxZ = HALF_WIDTH + 0.01 - BALL_RADIUS;
    if (this.ballPos.z > maxZ) {
      this.ballPos.z = maxZ;
      this.ballVel.z = -Math.abs(this.ballVel.z) * 0.75;
    } else if (this.ballPos.z < -maxZ) {
      this.ballPos.z = -maxZ;
      this.ballVel.z = Math.abs(this.ballVel.z) * 0.75;
    }

    // Goal post collisions
    const halfG = GOAL_WIDTH / 2;
    for (const xSign of [-1, 1]) {
      for (const zSign of [-1, 1]) {
        const postX = xSign * HALF_LENGTH;
        const postZ = zSign * halfG;
        if (this.ballPos.y < GOAL_HEIGHT + BALL_RADIUS) {
          const dx = this.ballPos.x - postX;
          const dz = this.ballPos.z - postZ;
          const dist = Math.hypot(dx, dz);
          const minD = BALL_RADIUS + GOAL_POST_RADIUS;
          if (dist < minD && dist > 0.0001) {
            const nx = dx / dist;
            const nz = dz / dist;
            this.ballPos.x = postX + nx * minD;
            this.ballPos.z = postZ + nz * minD;
            const dot = this.ballVel.x * nx + this.ballVel.z * nz;
            if (dot < 0) {
              this.ballVel.x -= 1.7 * dot * nx;
              this.ballVel.z -= 1.7 * dot * nz;
            }
          }
        }
      }
    }

    // Goal detection & endline cushions
    const inGoalMouthZ = Math.abs(this.ballPos.z) < halfG - BALL_RADIUS * 0.3;
    const underCrossbar = this.ballPos.y < GOAL_HEIGHT;

    if (Math.abs(this.ballPos.x) > HALF_LENGTH + BALL_RADIUS * 0.4 && inGoalMouthZ && underCrossbar) {
      if (detectGoals) {
        const scoringTeam: 0 | 1 = this.ballPos.x > 0 ? TEAM_BLUE : TEAM_RED;
        if (scoringTeam === TEAM_BLUE) {
          this.blueScore += 1;
          this.statusText = 'GOL DO TIME AZUL!';
        } else {
          this.redScore += 1;
          this.statusText = 'GOL DO TIME VERMELHO!';
        }
        this.goalResetTimer = 2.6;
        this.callbacks.onGoal?.(scoringTeam);
        this.emitScore();
      }

      // Keep ball inside goal net box
      const maxNetX = HALF_LENGTH + GOAL_DEPTH - BALL_RADIUS;
      if (this.ballPos.x > maxNetX) {
        this.ballPos.x = maxNetX;
        this.ballVel.x *= -0.3;
      } else if (this.ballPos.x < -maxNetX) {
        this.ballPos.x = -maxNetX;
        this.ballVel.x *= -0.3;
      }
      if (Math.abs(this.ballPos.z) > halfG - BALL_RADIUS) {
        this.ballPos.z = Math.sign(this.ballPos.z) * (halfG - BALL_RADIUS);
        this.ballVel.z *= -0.35;
      }
    } else {
      // Endline cushion outside the goal
      const maxX = HALF_LENGTH + 0.01 - BALL_RADIUS;
      if (this.ballPos.x > maxX) {
        this.ballPos.x = maxX;
        this.ballVel.x = -Math.abs(this.ballVel.x) * 0.72;
      } else if (this.ballPos.x < -maxX) {
        this.ballPos.x = -maxX;
        this.ballVel.x = Math.abs(this.ballVel.x) * 0.72;
      }
    }

    // Spin ball sphere visually from velocity
    this.ballSphereMesh.rotation.z -= (this.ballVel.x * dt) / BALL_RADIUS;
    this.ballSphereMesh.rotation.x += (this.ballVel.z * dt) / BALL_RADIUS;
  }

  private switchToClosestBluePlayer(): void {
    let bestIdx = this.controlledIndex;
    let bestDist = Infinity;
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (p.team !== TEAM_BLUE || p.role === 'GK' || i === this.controlledIndex) continue;
      const d = Math.hypot(p.pos.x - this.ballPos.x, p.pos.z - this.ballPos.z);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    this.controlledIndex = bestIdx;
  }

  private findClosestOutfieldIndex(team: 0 | 1, excludeIdx: number): number {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < this.players.length; i++) {
      if (i === excludeIdx) continue;
      const p = this.players[i];
      if (p.team !== team || p.role === 'GK') continue;
      const d = Math.hypot(p.pos.x - this.ballPos.x, p.pos.z - this.ballPos.z);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  private findPassTarget(passer: PlayerEntity, dirX: number, dirZ: number): PlayerEntity | null {
    let best: PlayerEntity | null = null;
    let bestScore = -Infinity;

    for (const mate of this.players) {
      if (mate === passer || mate.team !== passer.team || mate.role === 'GK') continue;
      const dx = mate.pos.x - passer.pos.x;
      const dz = mate.pos.z - passer.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.08 || dist > 0.75) continue;
      const align = (dx * dirX + dz * dirZ) / dist;
      if (align > 0.55) {
        const score = align - dist * 0.25;
        if (score > bestScore) {
          bestScore = score;
          best = mate;
        }
      }
    }
    return best;
  }

  private clampPlayerToPitch(p: PlayerEntity): void {
    const pad = 0.01;
    p.pos.x = THREE.MathUtils.clamp(p.pos.x, -HALF_LENGTH - pad, HALF_LENGTH + pad);
    p.pos.z = THREE.MathUtils.clamp(p.pos.z, -HALF_WIDTH - pad, HALF_WIDTH + pad);
  }

  private syncPlayerMesh(p: PlayerEntity): void {
    p.mesh.position.set(p.pos.x, 0, p.pos.z);
    p.mesh.rotation.y = p.facingAngle;

    const speed = Math.hypot(p.vel.x, p.vel.z);
    const bob = speed > 0.02 ? Math.abs(Math.sin(p.animPhase)) * 0.0035 : 0;
    p.bodyMesh.position.y = bob;
    p.bodyMesh.rotation.z = p.kickAnim > 0 ? Math.sin(p.kickAnim * Math.PI) * 0.25 : -Math.min(0.15, speed * 0.28);
  }

  private syncBallMesh(): void {
    this.ballMesh.position.copy(this.ballPos);
    const shadow = this.ballMesh.userData.shadowDisc as THREE.Mesh | undefined;
    if (shadow) {
      shadow.position.set(this.ballPos.x, 0.001, this.ballPos.z);
      const scale = Math.max(0.4, 1 - (this.ballPos.y - BALL_RADIUS) * 4);
      shadow.scale.setScalar(scale);
    }
  }

  private updateIndicators(elapsedTime: number, cameraWorldPos: THREE.Vector3): void {
    const active = this.players[this.controlledIndex];
    if (!active) return;

    const pulse = 1 + Math.sin(elapsedTime * 7) * 0.08;
    this.selectionRing.position.set(active.pos.x, 0.002, active.pos.z);
    this.selectionRing.scale.setScalar(pulse);

    this.selectionArrow.position.set(
      active.pos.x,
      0.088 + Math.sin(elapsedTime * 5) * 0.004,
      active.pos.z
    );
    this.selectionArrow.rotation.y = elapsedTime * 2;

    if (this.kickCharge > 0.02) {
      this.chargeBarBg.visible = true;
      this.chargeBarBg.position.set(active.pos.x, 0.11, active.pos.z);
      this.chargeBarBg.lookAt(cameraWorldPos);
      this.chargeBarFill.scale.x = Math.max(0.05, this.kickCharge);
      this.chargeBarFill.position.x = -0.016 * (1 - this.kickCharge);
      const fillMat = this.chargeBarFill.material as THREE.MeshBasicMaterial;
      fillMat.color.setHex(this.kickCharge > 0.75 ? 0xef4444 : this.kickCharge > 0.4 ? 0xfacc15 : 0x22c55e);
    } else {
      this.chargeBarBg.visible = false;
    }
  }

  private emitScore(): void {
    const mins = Math.floor(this.remainingSeconds / 60);
    const secs = Math.floor(this.remainingSeconds % 60);
    const timeText = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    this.callbacks.onScoreChange?.(this.blueScore, this.redScore, timeText, this.statusText);
  }
}

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

export type PlayerRole = 'GK' | 'DEF_L' | 'DEF_R' | 'MID_L' | 'MID_C' | 'MID_R' | 'FWD_L' | 'FWD_R';

export interface PlayerEntity {
  id: number;
  team: 0 | 1;
  role: PlayerRole;
  mesh: THREE.Group;
  bodyMesh: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  homePos: THREE.Vector3;
  facingAngle: number;
  kickCooldown: number;
  animPhase: number;
  kickAnim: number;
  diveTimer: number;
  diveDir: number;
  tackleTimer: number;
  tackleCooldown: number;
}

export interface MatchInputState {
  moveX: number;         // Local field X (-1..1), already camera-relative
  moveZ: number;         // Local field Z (-1..1), already camera-relative
  sprint: boolean;
  kickHeld: boolean;     // Shoot button held (Right Trigger / Space)
  passPressed: boolean;  // Dedicated short/through pass (A button / KeyE / KeyJ)
  tacklePressed: boolean; // Defensive slide tackle / lunge (B button / KeyC / KeyF)
  switchPressed: boolean; // Switch player (X button / KeyQ)
}

export interface MatchCallbacks {
  onScoreChange?: (blue: number, red: number, timeText: string, statusText: string) => void;
  onGoal?: (scoringTeam: 0 | 1) => void;
  onKick?: (power: number) => void;
}

const GRAVITY = -3.6;
const BALL_RESTITUTION = 0.58;
const GRASS_FRICTION = 2.15;
const AIR_DRAG = 0.32;

/**
 * 8v8 soccer simulation running inside `fieldRoot` (where y = 0 is the grass).
 */
export class MatchSimulation {
  public blueScore = 0;
  public redScore = 0;
  public remainingSeconds = MATCH_DURATION_SECONDS;

  private readonly fieldRoot: THREE.Group;
  private readonly callbacks: MatchCallbacks;

  private readonly players: PlayerEntity[] = [];
  private controlledIndex = 6; // Start controlling Blue FWD_L

  private readonly ballMesh: THREE.Group;
  private readonly ballPos = new THREE.Vector3(0, BALL_RADIUS, 0);
  private readonly ballVel = new THREE.Vector3(0, 0, 0);
  private readonly ballSphereMesh: THREE.Mesh;

  private readonly selectionRing: THREE.Mesh;
  private readonly selectionArrow: THREE.Mesh;
  private readonly aimGuideGroup: THREE.Group;
  private readonly aimGuideMat: THREE.MeshBasicMaterial;
  private readonly passTargetRing: THREE.Mesh;
  private readonly chargeBarBg: THREE.Mesh;
  private readonly chargeBarFill: THREE.Mesh;

  private kickCharge = 0;
  private wasKickHeld = false;
  private autoSwitchCooldown = 0;
  private ballFreeTimer = 0;
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

    // Directional aim arrow in front of ball carrier
    this.aimGuideGroup = new THREE.Group();
    this.aimGuideMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
    });
    const aimStem = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.008), this.aimGuideMat);
    aimStem.rotation.x = -Math.PI / 2;
    aimStem.position.set(PLAYER_RADIUS + 0.048, 0.0025, 0);
    this.aimGuideGroup.add(aimStem);

    const aimHead = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.024, 3), this.aimGuideMat);
    aimHead.rotation.z = -Math.PI / 2;
    aimHead.scale.set(0.08, 1, 1);
    aimHead.position.set(PLAYER_RADIUS + 0.098, 0.0025, 0);
    this.aimGuideGroup.add(aimHead);
    this.aimGuideGroup.visible = false;
    this.fieldRoot.add(this.aimGuideGroup);

    // Pass target indicator ring under intended receiver
    this.passTargetRing = new THREE.Mesh(
      new THREE.RingGeometry(PLAYER_RADIUS * 1.15, PLAYER_RADIUS * 1.48, 24),
      new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
      })
    );
    this.passTargetRing.rotation.x = -Math.PI / 2;
    this.passTargetRing.position.y = 0.0022;
    this.passTargetRing.visible = false;
    this.fieldRoot.add(this.passTargetRing);

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
    this.ballFreeTimer = 0;

    for (const p of this.players) {
      p.pos.copy(p.homePos);
      p.vel.set(0, 0, 0);
      p.facingAngle = p.team === TEAM_BLUE ? 0 : Math.PI;
      p.kickCooldown = 0;
      p.kickAnim = 0;
      p.diveTimer = 0;
      p.diveDir = 0;
      p.tackleTimer = 0;
      p.tackleCooldown = 0;
      this.syncPlayerMesh(p);
    }
    this.controlledIndex = 6;
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
        this.statusText = 'FIM DE JOGO: PRETO/BRANCO VENCEU!';
      } else if (this.redScore > this.blueScore) {
        this.statusText = 'FIM DE JOGO: VERDE/BRANCO VENCEU!';
      } else {
        this.statusText = 'FIM DE JOGO: EMPATE!';
      }
      this.emitScore();
      return;
    }

    // Handle manual player switching or auto-switch when off the ball
    this.ballFreeTimer = Math.max(0, this.ballFreeTimer - safeDt);
    this.autoSwitchCooldown = Math.max(0, this.autoSwitchCooldown - safeDt);
    if (input.switchPressed) {
      this.switchToClosestBluePlayer();
      this.autoSwitchCooldown = 0.35;
    } else if (this.autoSwitchCooldown <= 0) {
      const controlled = this.players[this.controlledIndex];
      const distControlled = Math.hypot(
        this.ballPos.x - controlled.pos.x,
        this.ballPos.z - controlled.pos.z
      );
      if (distControlled > PLAYER_RADIUS + BALL_RADIUS + 0.038) {
        const closestBlue = this.findClosestOutfieldIndex(TEAM_BLUE, -1);
        if (closestBlue !== -1 && closestBlue !== this.controlledIndex) {
          const candidate = this.players[closestBlue];
          const distCandidate = Math.hypot(
            this.ballPos.x - candidate.pos.x,
            this.ballPos.z - candidate.pos.z
          );
          if (distCandidate < distControlled - 0.035) {
            this.controlledIndex = closestBlue;
            this.autoSwitchCooldown = 0.22;
          }
        }
      }
    }

    // Handle human kick charging / release
    this.handleHumanKick(safeDt, input);

    // Update all 10 players (only Red AI presses automatically; Blue AI positions without auto-kicking)
    const closestRedAI = this.findClosestOutfieldIndex(TEAM_RED, -1);

    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      p.kickCooldown = Math.max(0, p.kickCooldown - safeDt);
      p.kickAnim = Math.max(0, p.kickAnim - safeDt * 4);
      p.diveTimer = Math.max(0, p.diveTimer - safeDt);
      p.tackleTimer = Math.max(0, p.tackleTimer - safeDt);
      p.tackleCooldown = Math.max(0, p.tackleCooldown - safeDt);

      if (i === this.controlledIndex) {
        this.updateHumanPlayer(p, safeDt, input);
      } else {
        const isPresser = i === closestRedAI;
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
      { role: 'GK', x: -HALF_LENGTH + 0.048, z: 0 },
      { role: 'DEF_L', x: -HALF_LENGTH * 0.70, z: -HALF_WIDTH * 0.20 },
      { role: 'DEF_R', x: -HALF_LENGTH * 0.70, z: HALF_WIDTH * 0.20 },
      { role: 'MID_L', x: -HALF_LENGTH * 0.36, z: -HALF_WIDTH * 0.54 },
      { role: 'MID_C', x: -HALF_LENGTH * 0.42, z: 0 },
      { role: 'MID_R', x: -HALF_LENGTH * 0.36, z: HALF_WIDTH * 0.54 },
      { role: 'FWD_L', x: -HALF_LENGTH * 0.14, z: -HALF_WIDTH * 0.28 },
      { role: 'FWD_R', x: -HALF_LENGTH * 0.14, z: HALF_WIDTH * 0.28 },
    ];

    let id = 0;
    for (const team of [TEAM_BLUE, TEAM_RED] as const) {
      for (let i = 0; i < formations.length; i++) {
        const f = formations[i];
        const x = team === TEAM_BLUE ? f.x : -f.x;
        const z = team === TEAM_BLUE ? f.z : -f.z;
        const { root, body, leftLeg, rightLeg, leftArm, rightArm } = this.createPlayerMesh(
          team,
          f.role === 'GK',
          i
        );
        this.fieldRoot.add(root);

        this.players.push({
          id: id++,
          team,
          role: f.role,
          mesh: root,
          bodyMesh: body,
          leftLeg,
          rightLeg,
          leftArm,
          rightArm,
          pos: new THREE.Vector3(x, 0, z),
          vel: new THREE.Vector3(),
          homePos: new THREE.Vector3(x, 0, z),
          facingAngle: team === TEAM_BLUE ? 0 : Math.PI,
          kickCooldown: 0,
          animPhase: i * 1.3,
          kickAnim: 0,
          diveTimer: 0,
          diveDir: 0,
          tackleTimer: 0,
          tackleCooldown: 0,
        });
      }
    }
  }

  private createNumberBadgeTexture(numStr: string, textColor: string): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, 128, 128);
    ctx.fillStyle = textColor;
    ctx.font = 'bold 82px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(numStr, 64, 68);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }

  private createPlayerMesh(
    team: 0 | 1,
    isKeeper: boolean,
    slotIndex = 0
  ): {
    root: THREE.Group;
    body: THREE.Group;
    leftLeg: THREE.Group;
    rightLeg: THREE.Group;
    leftArm: THREE.Group;
    rightArm: THREE.Group;
  } {
    const root = new THREE.Group();
    const body = new THREE.Group();
    body.scale.set(0.96, 1.22, 0.96);
    root.add(body);

    const numbers = ['1', '2', '4', '7', '8', '10', '9', '11'];
    const numStr = numbers[slotIndex % numbers.length];

    const skinPalette = [0xf5d0b5, 0xe8b896, 0xc68652, 0x8d5524, 0xf1c27d];
    const hairPalette = [0x1c1917, 0x451a03, 0x0f172a, 0x92400e, 0xd97706];
    const paletteIdx = (team * 5 + slotIndex) % 5;
    const skinColor = skinPalette[paletteIdx];
    const hairColor = hairPalette[(paletteIdx + 2) % 5];

    const jerseyColor = isKeeper
      ? team === TEAM_BLUE
        ? 0x0284c7
        : 0xd97706
      : team === TEAM_BLUE
        ? 0xffffff
        : 0x15803d;
    const shortsColor = isKeeper
      ? team === TEAM_BLUE
        ? 0x111827
        : 0x064e3b
      : team === TEAM_BLUE
        ? 0x111827
        : 0xffffff;
    const sockColor = isKeeper ? 0xf8fafc : team === TEAM_BLUE ? 0xf8fafc : 0x166534;
    const trimColor = isKeeper ? 0xfef08a : team === TEAM_BLUE ? 0x111827 : 0xffffff;
    const numTextColor = isKeeper ? '#ffffff' : team === TEAM_BLUE ? '#111827' : '#ffffff';
    const baseRingColor = team === TEAM_BLUE ? 0xe2e8f0 : 0x22c55e;

    // Low-profile tabletop base disc + subtle colored team rim ring
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(PLAYER_RADIUS * 0.85, PLAYER_RADIUS * 0.92, 0.004, 20),
      new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.45 })
    );
    base.position.y = 0.002;
    base.castShadow = true;
    root.add(base);

    const baseRing = new THREE.Mesh(
      new THREE.RingGeometry(PLAYER_RADIUS * 0.72, PLAYER_RADIUS * 0.85, 20),
      new THREE.MeshBasicMaterial({ color: baseRingColor, side: THREE.DoubleSide })
    );
    baseRing.rotation.x = -Math.PI / 2;
    baseRing.position.y = 0.0042;
    root.add(baseRing);

    const shortsMat = new THREE.MeshStandardMaterial({ color: shortsColor, roughness: 0.58 });
    const sockMat = new THREE.MeshStandardMaterial({ color: sockColor, roughness: 0.55 });
    const bootMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.35 });
    const bootAccentMat = new THREE.MeshStandardMaterial({ color: trimColor, roughness: 0.4 });
    const jerseyMat = new THREE.MeshStandardMaterial({ color: jerseyColor, roughness: 0.48 });
    const trimMat = new THREE.MeshStandardMaterial({ color: trimColor, roughness: 0.45 });
    const skinMat = new THREE.MeshStandardMaterial({ color: skinColor, roughness: 0.65 });

    // Articulated legs (pivoted at hip height)
    const createLeg = (zOffset: number): THREE.Group => {
      const legGroup = new THREE.Group();
      legGroup.position.set(0, 0.022, zOffset);

      const thigh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0048, 0.0042, 0.008, 10),
        shortsMat
      );
      thigh.position.y = -0.004;
      thigh.castShadow = true;
      legGroup.add(thigh);

      const sock = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0040, 0.0033, 0.010, 10),
        sockMat
      );
      sock.position.y = -0.012;
      sock.castShadow = true;
      legGroup.add(sock);

      const cleat = new THREE.Mesh(new THREE.BoxGeometry(0.011, 0.0042, 0.0052), bootMat);
      cleat.position.set(0.002, -0.0175, 0);
      cleat.castShadow = true;
      legGroup.add(cleat);

      const cleatStripe = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.0014, 0.0055), bootAccentMat);
      cleatStripe.position.set(0.003, -0.0168, 0);
      legGroup.add(cleatStripe);

      body.add(legGroup);
      return legGroup;
    };

    const leftLeg = createLeg(-0.0055);
    const rightLeg = createLeg(0.0055);

    // Pelvis / shorts + athletic torso + collar + back jersey number
    const pelvis = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0115, 0.0108, 0.010, 14),
      shortsMat
    );
    pelvis.position.y = 0.023;
    pelvis.castShadow = true;
    body.add(pelvis);

    const torso = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0132, 0.0112, 0.021, 14),
      jerseyMat
    );
    torso.position.y = 0.037;
    torso.castShadow = true;
    body.add(torso);

    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.0068, 0.0016, 8, 16), trimMat);
    collar.rotation.x = Math.PI / 2;
    collar.position.y = 0.0475;
    body.add(collar);

    const numBadge = new THREE.Mesh(
      new THREE.PlaneGeometry(0.013, 0.013),
      new THREE.MeshBasicMaterial({
        map: this.createNumberBadgeTexture(numStr, numTextColor),
        transparent: true,
        depthWrite: false,
      })
    );
    numBadge.position.set(-0.0134, 0.037, 0);
    numBadge.rotation.y = -Math.PI / 2;
    body.add(numBadge);

    // Articulated arms (pivoted at shoulder height)
    const gloveMat = new THREE.MeshStandardMaterial({ color: 0xfef08a, roughness: 0.4 });
    const createArm = (zOffset: number): THREE.Group => {
      const armGroup = new THREE.Group();
      armGroup.position.set(0, 0.045, zOffset);

      const sleeve = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0042, 0.0038, 0.008, 10),
        jerseyMat
      );
      sleeve.position.y = -0.0035;
      sleeve.castShadow = true;
      armGroup.add(sleeve);

      const forearm = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0035, 0.0030, 0.009, 10),
        skinMat
      );
      forearm.position.y = -0.011;
      forearm.castShadow = true;
      armGroup.add(forearm);

      if (isKeeper) {
        const glove = new THREE.Mesh(new THREE.BoxGeometry(0.0065, 0.0065, 0.0048), gloveMat);
        glove.position.y = -0.0165;
        glove.castShadow = true;
        armGroup.add(glove);
      } else {
        const hand = new THREE.Mesh(new THREE.SphereGeometry(0.0032, 8, 8), skinMat);
        hand.position.y = -0.0165;
        armGroup.add(hand);
      }

      body.add(armGroup);
      return armGroup;
    };

    const leftArm = createArm(-0.0142);
    const rightArm = createArm(0.0142);

    // Neck, head, expressive eyes & hair style
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.0045, 0.005, 0.005, 10), skinMat);
    neck.position.y = 0.049;
    body.add(neck);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.0108, 16, 14), skinMat);
    head.position.y = 0.057;
    head.castShadow = true;
    body.add(head);

    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x0f172a });
    const eyeGeo = new THREE.SphereGeometry(0.0014, 6, 6);
    const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
    leftEye.position.set(0.0098, 0.058, -0.0036);
    body.add(leftEye);
    const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
    rightEye.position.set(0.0098, 0.058, 0.0036);
    body.add(rightEye);

    const hairMat = new THREE.MeshStandardMaterial({ color: hairColor, roughness: 0.72 });
    const hairCap = new THREE.Mesh(
      new THREE.SphereGeometry(0.0113, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.58),
      hairMat
    );
    hairCap.position.set(-0.0008, 0.0575, 0);
    hairCap.rotation.z = 0.22;
    body.add(hairCap);

    if (slotIndex % 2 === 1) {
      // Sporty top crest / quiff
      const quiff = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.0045, 0.005), hairMat);
      quiff.position.set(0.003, 0.068, 0);
      quiff.rotation.z = -0.25;
      body.add(quiff);
    } else if (!isKeeper) {
      // Athletic headband for alternate players
      const headband = new THREE.Mesh(
        new THREE.TorusGeometry(0.0107, 0.0013, 6, 16),
        trimMat
      );
      headband.rotation.x = Math.PI / 2;
      headband.position.y = 0.0615;
      body.add(headband);
    }

    return { root, body, leftLeg, rightLeg, leftArm, rightArm };
  }

  private updateHumanPlayer(p: PlayerEntity, dt: number, input: MatchInputState): void {
    if (p.tackleTimer > 0) {
      const slideSpeed = 0.48 * (0.4 + (p.tackleTimer / 0.32) * 0.6);
      p.vel.x = Math.cos(p.facingAngle) * slideSpeed;
      p.vel.z = -Math.sin(p.facingAngle) * slideSpeed;
    } else {
      const len = Math.hypot(input.moveX, input.moveZ);
      const maxSpeed = input.sprint ? 0.41 : 0.30;

      if (len > 0.08) {
        const clamped = Math.min(1, len);
        const dirX = input.moveX / len;
        const dirZ = input.moveZ / len;
        const targetVx = dirX * maxSpeed * clamped;
        const targetVz = dirZ * maxSpeed * clamped;

        p.vel.x = THREE.MathUtils.lerp(p.vel.x, targetVx, Math.min(1, dt * 9.5));
        p.vel.z = THREE.MathUtils.lerp(p.vel.z, targetVz, Math.min(1, dt * 9.5));
        p.facingAngle = Math.atan2(-dirZ, dirX);
      } else {
        p.vel.x = THREE.MathUtils.lerp(p.vel.x, 0, Math.min(1, dt * 8.5));
        p.vel.z = THREE.MathUtils.lerp(p.vel.z, 0, Math.min(1, dt * 8.5));
      }
    }

    p.pos.x += p.vel.x * dt;
    p.pos.z += p.vel.z * dt;
    this.clampPlayerToPitch(p);

    const speed = Math.hypot(p.vel.x, p.vel.z);
    p.animPhase += speed * dt * 22;
  }

  private handleHumanKick(dt: number, input: MatchInputState): void {
    const p = this.players[this.controlledIndex];
    const distToBall = Math.hypot(this.ballPos.x - p.pos.x, this.ballPos.z - p.pos.z);
    const hasBall = distToBall < PLAYER_RADIUS + BALL_RADIUS + 0.048 && this.ballPos.y < 0.07;

    if (input.passPressed) {
      this.kickCharge = 0;
      this.wasKickHeld = false;
      if (hasBall) {
        this.performPass(p, input.moveX, input.moveZ);
      } else {
        this.switchToClosestBluePlayer();
        this.autoSwitchCooldown = 0.35;
      }
      return;
    }

    if (input.tacklePressed) {
      this.kickCharge = 0;
      this.wasKickHeld = false;
      if (hasBall) {
        this.performPass(p, input.moveX, input.moveZ);
      } else if (p.tackleCooldown <= 0) {
        this.performTackle(p, input.moveX, input.moveZ);
      }
      return;
    }

    if (input.kickHeld) {
      if (!hasBall && distToBall > PLAYER_RADIUS + BALL_RADIUS + 0.08 && p.tackleCooldown <= 0 && !this.wasKickHeld) {
        this.performTackle(p, input.moveX, input.moveZ);
        return;
      }
      this.kickCharge = Math.min(1, this.kickCharge + dt * 1.45);
      this.wasKickHeld = true;
    } else if (this.wasKickHeld) {
      // Released shoot button
      this.wasKickHeld = false;
      const power = 0.38 + this.kickCharge * 0.62;
      this.kickCharge = 0;

      if (hasBall) {
        this.performKick(p, power, input.moveX, input.moveZ);
      } else if (p.tackleCooldown <= 0) {
        this.performTackle(p, input.moveX, input.moveZ);
      }
    }
  }

  private performPass(p: PlayerEntity, aimX = 0, aimZ = 0): void {
    let dirX = Math.cos(p.facingAngle);
    let dirZ = -Math.sin(p.facingAngle);

    if (Math.hypot(aimX, aimZ) > 0.15) {
      const len = Math.hypot(aimX, aimZ);
      dirX = aimX / len;
      dirZ = aimZ / len;
    }

    const mate = this.findPassTarget(p, dirX, dirZ);
    let speed = 0.72;

    if (mate) {
      const targetX = mate.pos.x + mate.vel.x * 0.18;
      const targetZ = mate.pos.z + mate.vel.z * 0.18;
      const dx = targetX - this.ballPos.x;
      const dz = targetZ - this.ballPos.z;
      const d = Math.hypot(dx, dz) || 1;
      dirX = dx / d;
      dirZ = dz / d;
      speed = THREE.MathUtils.clamp(0.54 + d * 0.48, 0.58, 0.98);

      const mateIdx = this.players.indexOf(mate);
      if (mateIdx !== -1) {
        this.controlledIndex = mateIdx;
        this.autoSwitchCooldown = 0.50;
      }
    }

    this.ballVel.set(dirX * speed, 0.04, dirZ * speed);
    p.facingAngle = Math.atan2(-dirZ, dirX);
    p.kickCooldown = 0.30;
    p.kickAnim = 1;
    this.ballFreeTimer = 0.16;
    this.callbacks.onKick?.(0.45);
  }

  private performTackle(p: PlayerEntity, aimX = 0, aimZ = 0): void {
    let dirX = Math.cos(p.facingAngle);
    let dirZ = -Math.sin(p.facingAngle);

    if (Math.hypot(aimX, aimZ) > 0.15) {
      const len = Math.hypot(aimX, aimZ);
      dirX = aimX / len;
      dirZ = aimZ / len;
    } else {
      const dx = this.ballPos.x - p.pos.x;
      const dz = this.ballPos.z - p.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.001) {
        dirX = dx / d;
        dirZ = dz / d;
      }
    }

    p.facingAngle = Math.atan2(-dirZ, dirX);
    p.tackleTimer = 0.32;
    p.tackleCooldown = 0.85;
    this.callbacks.onKick?.(0.35);
  }

  private performKick(p: PlayerEntity, power: number, aimX = 0, aimZ = 0): void {
    let dirX = Math.cos(p.facingAngle);
    let dirZ = -Math.sin(p.facingAngle);
    const hasExplicitAim = Math.hypot(aimX, aimZ) > 0.2;

    if (hasExplicitAim) {
      const len = Math.hypot(aimX, aimZ);
      dirX = aimX / len;
      dirZ = aimZ / len;
      p.facingAngle = Math.atan2(-dirZ, dirX);
    }

    // Gentle shot assist toward goal mouth when shooting toward opponent goal
    if (p.team === TEAM_BLUE && dirX > 0.2) {
      const goalX = HALF_LENGTH;
      const goalZ = THREE.MathUtils.clamp(dirZ * 0.22, -GOAL_WIDTH * 0.34, GOAL_WIDTH * 0.34);
      const gx = goalX - this.ballPos.x;
      const gz = goalZ - this.ballPos.z;
      const gd = Math.hypot(gx, gz) || 1;
      dirX = THREE.MathUtils.lerp(dirX, gx / gd, 0.28);
      dirZ = THREE.MathUtils.lerp(dirZ, gz / gd, 0.28);
      const norm = Math.hypot(dirX, dirZ) || 1;
      dirX /= norm;
      dirZ /= norm;
    }

    const speed = 0.52 + power * 0.72;
    this.ballVel.x = dirX * speed + (hasExplicitAim ? 0 : p.vel.x * 0.25);
    this.ballVel.z = dirZ * speed + (hasExplicitAim ? 0 : p.vel.z * 0.25);
    this.ballVel.y = 0.06 + power * 0.20;

    p.kickCooldown = 0.32;
    p.kickAnim = 1;
    this.ballFreeTimer = 0.18;
    this.callbacks.onKick?.(power);
  }

  private updateAIPlayer(p: PlayerEntity, dt: number, isPresser: boolean): void {
    const attackDir = p.team === TEAM_BLUE ? 1 : -1;
    const goalX = attackDir * HALF_LENGTH;
    const ownGoalX = -attackDir * HALF_LENGTH;

    const target = new THREE.Vector3().copy(p.homePos);
    const distBall = Math.hypot(this.ballPos.x - p.pos.x, this.ballPos.z - p.pos.z);

    if (p.role === 'GK') {
      // Both goalkeepers anticipate incoming shots, dive laterally, and parry/clear the ball
      const incomingShot =
        this.ballVel.x * attackDir < -0.22 && Math.abs(this.ballPos.x - ownGoalX) < 0.68;
      let clampedZ = THREE.MathUtils.clamp(
        this.ballPos.z * 0.82,
        -GOAL_WIDTH * 0.36,
        GOAL_WIDTH * 0.36
      );

      if (incomingShot) {
        const timeToGoal = THREE.MathUtils.clamp(
          Math.abs(ownGoalX - this.ballPos.x) / Math.max(0.25, Math.abs(this.ballVel.x)),
          0,
          0.55
        );
        const predictedZ = this.ballPos.z + this.ballVel.z * timeToGoal;
        clampedZ = THREE.MathUtils.clamp(predictedZ, -GOAL_WIDTH * 0.42, GOAL_WIDTH * 0.42);

        if (p.diveTimer <= 0 && p.kickCooldown <= 0 && Math.abs(this.ballPos.x - ownGoalX) < 0.56) {
          p.diveTimer = 0.42;
          p.diveDir = Math.abs(clampedZ - p.pos.z) > 0.02 ? Math.sign(clampedZ - p.pos.z) : 0;
        }
      }

      target.set(ownGoalX + attackDir * 0.035, 0, clampedZ);
      const saveReach = PLAYER_RADIUS + BALL_RADIUS + (p.diveTimer > 0 ? 0.018 : 0.012);
      const maxSaveHeight = p.diveTimer > 0 ? GOAL_HEIGHT : 0.075;
      if (distBall < saveReach && p.kickCooldown <= 0 && this.ballPos.y < maxSaveHeight) {
        if (p.diveTimer <= 0) {
          p.diveTimer = 0.32;
          p.diveDir = Math.abs(this.ballPos.z - p.pos.z) > 0.012 ? Math.sign(this.ballPos.z - p.pos.z) : 0;
        }
        const clearZ = (p.pos.z >= 0 ? 1 : -1) * 0.45;
        this.performKick(p, 0.62, attackDir, clearZ);
      }
    } else if (isPresser && p.team === TEAM_RED) {
      // Red AI chases the ball, clears corners/pressure, and finishes inside the danger zone
      const toGoalX = goalX - this.ballPos.x;
      const toGoalZ = -this.ballPos.z;
      const toGoalLen = Math.hypot(toGoalX, toGoalZ) || 1;
      if (p.pos.x < this.ballPos.x - 0.01 && distBall < 0.09) {
        // Steer around the ball when caught on its goal-side so CPU never deadlocks pushing backward
        const sideSign = p.pos.z >= this.ballPos.z ? 1 : -1;
        target.set(
          THREE.MathUtils.clamp(this.ballPos.x + 0.048, -HALF_LENGTH + 0.06, HALF_LENGTH - 0.06),
          0,
          THREE.MathUtils.clamp(this.ballPos.z + sideSign * 0.048, -HALF_WIDTH + 0.05, HALF_WIDTH - 0.05)
        );
      } else if (distBall < 0.06) {
        target.set(
          this.ballPos.x + (toGoalX / toGoalLen) * 0.08,
          0,
          this.ballPos.z + (toGoalZ / toGoalLen) * 0.08
        );
      } else {
        target.set(this.ballPos.x, 0, this.ballPos.z);
      }

      if (distBall < PLAYER_RADIUS + BALL_RADIUS + 0.028 && p.kickCooldown <= 0 && this.ballPos.y < 0.055) {
        const distToGoal = Math.hypot(goalX - this.ballPos.x, -this.ballPos.z);
        if (distToGoal < 0.48 && Math.abs(this.ballPos.x - goalX) < 0.45) {
          const blueGK = this.players.find((pl) => pl.team === TEAM_BLUE && pl.role === 'GK');
          const baseCorner = blueGK
            ? (blueGK.pos.z >= 0 ? -GOAL_WIDTH * 0.22 : GOAL_WIDTH * 0.22)
            : 0;
          const targetZ = THREE.MathUtils.clamp(
            baseCorner + (Math.random() - 0.5) * GOAL_WIDTH * 0.34,
            -GOAL_WIDTH * 0.35,
            GOAL_WIDTH * 0.35
          );
          const dx = goalX - this.ballPos.x;
          const dz = targetZ - this.ballPos.z;
          const d = Math.hypot(dx, dz) || 1;
          this.performKick(p, 0.56 + Math.random() * 0.16, dx / d, dz / d);
          p.kickCooldown = 0.58;
        } else {
          const nearPerimeter =
            Math.abs(this.ballPos.x) > HALF_LENGTH - 0.09 || Math.abs(this.ballPos.z) > HALF_WIDTH - 0.09;
          const underPressure = this.players.some(
            (b) =>
              b.team === TEAM_BLUE &&
              Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z) < 0.075
          );
          if (nearPerimeter || underPressure || Math.random() < 0.035) {
            let bestMate: PlayerEntity | null = null;
            let bestScore = -Infinity;
            for (const mate of this.players) {
              if (mate === p || mate.team !== TEAM_RED || mate.role === 'GK') continue;
              const md = Math.hypot(mate.pos.x - p.pos.x, mate.pos.z - p.pos.z);
              if (md < 0.12 || md > 0.95) continue;
              const forwardGain = (p.pos.x - mate.pos.x) * 2.0;
              const oppDist = this.players.reduce((minD, opp) => {
                if (opp.team !== TEAM_BLUE) return minD;
                return Math.min(minD, Math.hypot(opp.pos.x - mate.pos.x, opp.pos.z - mate.pos.z));
              }, 99);
              const score = forwardGain + Math.min(oppDist, 0.25) * 1.4 - md * 0.25;
              if (score > bestScore) {
                bestScore = score;
                bestMate = mate;
              }
            }
            if (bestMate && (bestMate.pos.x < p.pos.x - 0.04 || nearPerimeter || underPressure)) {
              const px = bestMate.pos.x - 0.04 - this.ballPos.x;
              const pz = bestMate.pos.z - this.ballPos.z;
              const pd = Math.hypot(px, pz) || 1;
              const passPower = THREE.MathUtils.clamp(0.38 + pd * 0.38, 0.40, 0.72);
              this.performKick(p, passPower, px / pd, pz / pd);
              p.kickCooldown = 0.48;
            } else {
              this.performKick(p, 0.50, toGoalX / toGoalLen, toGoalZ / toGoalLen);
              p.kickCooldown = 0.48;
            }
          }
        }
      }
    } else if (p.team === TEAM_BLUE) {
      // Blue teammates push into attack while keeping a compact central defensive block in front of goal
      if (p.role === 'FWD_L' || p.role === 'FWD_R') {
        const baseAdv = p.homePos.x + this.ballPos.x * 0.82 + 0.30;
        const rawX = this.ballPos.x > -0.15 ? Math.max(baseAdv, this.ballPos.x + 0.20) : baseAdv;
        target.x = THREE.MathUtils.clamp(rawX, -HALF_LENGTH + 0.20, HALF_LENGTH - 0.12);
        target.z = THREE.MathUtils.clamp(
          p.homePos.z * 0.88 + this.ballPos.z * 0.32,
          -HALF_WIDTH + 0.07,
          HALF_WIDTH - 0.07
        );
      } else if (p.role === 'MID_C') {
        // Central holding midfielder screens the top of the penalty box
        if (this.ballPos.x < 0) {
          target.x = THREE.MathUtils.clamp(p.homePos.x + this.ballPos.x * 0.45, -HALF_LENGTH + 0.24, -0.08);
          target.z = THREE.MathUtils.clamp(this.ballPos.z * 0.52, -0.28, 0.28);
        } else {
          target.x = THREE.MathUtils.clamp(
            p.homePos.x + this.ballPos.x * 0.68 + 0.14,
            -HALF_LENGTH + 0.24,
            HALF_LENGTH * 0.45
          );
          target.z = THREE.MathUtils.clamp(this.ballPos.z * 0.35, -0.26, 0.26);
        }
      } else if (p.role === 'MID_L' || p.role === 'MID_R') {
        const tuckFactor = this.ballPos.x < 0 ? 0.72 : 0.92;
        const pushBonus = this.ballPos.x > 0 ? 0.24 : -0.04;
        target.x = THREE.MathUtils.clamp(
          p.homePos.x + this.ballPos.x * 0.72 + pushBonus,
          -HALF_LENGTH + 0.18,
          HALF_LENGTH * 0.68
        );
        target.z = THREE.MathUtils.clamp(
          p.homePos.z * tuckFactor + this.ballPos.z * (this.ballPos.x < 0 ? 0.28 : 0.35),
          -HALF_WIDTH + 0.07,
          HALF_WIDTH - 0.07
        );
      } else {
        // Center-backs (DEF_L / DEF_R) guard the goal corridor compactly
        const slotZ = (p.role === 'DEF_L' ? -1 : 1) * 0.085;
        if (this.ballPos.x < 0.15) {
          const goalSideX = Math.min(p.homePos.x + this.ballPos.x * 0.38, this.ballPos.x - 0.14);
          target.x = THREE.MathUtils.clamp(goalSideX, -HALF_LENGTH + 0.13, -0.18);
          target.z = THREE.MathUtils.clamp(
            this.ballPos.z * 0.52 + slotZ,
            -GOAL_WIDTH * 0.85,
            GOAL_WIDTH * 0.85
          );
        } else {
          target.x = THREE.MathUtils.clamp(
            p.homePos.x + this.ballPos.x * 0.35,
            -HALF_LENGTH + 0.16,
            -0.16
          );
          target.z = THREE.MathUtils.clamp(
            p.homePos.z * 0.75 + this.ballPos.z * 0.25,
            -GOAL_WIDTH * 1.05,
            GOAL_WIDTH * 1.05
          );
        }
      }
    } else {
      // Red AI role-based off-ball tactical shift across the pitch
      if (p.role === 'FWD_L' || p.role === 'FWD_R') {
        const pushBonus = this.ballPos.x < 0 ? -0.26 : 0;
        const rawX =
          this.ballPos.x < 0.15
            ? Math.min(p.homePos.x + this.ballPos.x * 0.78 + pushBonus, this.ballPos.x - 0.18)
            : p.homePos.x + this.ballPos.x * 0.72;
        target.x = THREE.MathUtils.clamp(rawX, -HALF_LENGTH + 0.14, HALF_LENGTH - 0.18);
        target.z = THREE.MathUtils.clamp(
          p.homePos.z * 0.88 + this.ballPos.z * 0.34,
          -HALF_WIDTH + 0.06,
          HALF_WIDTH - 0.06
        );
      } else if (p.role === 'MID_L' || p.role === 'MID_C' || p.role === 'MID_R') {
        const pushBonus = this.ballPos.x < 0 ? -0.20 : 0.06;
        target.x = THREE.MathUtils.clamp(
          p.homePos.x + this.ballPos.x * 0.70 + pushBonus,
          -HALF_LENGTH * 0.68,
          HALF_LENGTH - 0.18
        );
        target.z = THREE.MathUtils.clamp(
          p.homePos.z * 0.90 + this.ballPos.z * 0.36,
          -HALF_WIDTH + 0.06,
          HALF_WIDTH - 0.06
        );
      } else {
        const dropBonus = this.ballPos.x > 0 ? 0.18 : -0.10;
        target.x = THREE.MathUtils.clamp(
          p.homePos.x + this.ballPos.x * 0.55 + dropBonus,
          -HALF_LENGTH * 0.25,
          HALF_LENGTH - 0.14
        );
        target.z = THREE.MathUtils.clamp(
          p.homePos.z + this.ballPos.z * 0.30,
          -HALF_WIDTH + 0.06,
          HALF_WIDTH - 0.06
        );
      }
    }

    // Maintain spacing from nearby teammates while keeping center-backs compact
    if (p.role !== 'GK' && !(isPresser && p.team === TEAM_RED)) {
      const minSpace = p.role === 'DEF_L' || p.role === 'DEF_R' ? 0.10 : 0.18;
      for (const mate of this.players) {
        if (mate === p || mate.team !== p.team) continue;
        const sx = p.pos.x - mate.pos.x;
        const sz = p.pos.z - mate.pos.z;
        const sd = Math.hypot(sx, sz);
        if (sd > 0.001 && sd < minSpace) {
          const push = (minSpace - sd) * 0.65;
          target.x = THREE.MathUtils.clamp(target.x + (sx / sd) * push, -HALF_LENGTH + 0.08, HALF_LENGTH - 0.08);
          target.z = THREE.MathUtils.clamp(target.z + (sz / sd) * push, -HALF_WIDTH + 0.06, HALF_WIDTH - 0.06);
        }
      }
    }

    const dx = target.x - p.pos.x;
    const dz = target.z - p.pos.z;
    const dist = Math.hypot(dx, dz);
    const maxSpeed =
      p.role === 'GK'
        ? p.diveTimer > 0
          ? p.team === TEAM_BLUE
            ? 0.34
            : 0.29
          : p.team === TEAM_BLUE
            ? 0.22
            : 0.19
        : p.team === TEAM_BLUE
          ? 0.28
          : isPresser
            ? 0.25
            : 0.21;
    const velLerp = p.role === 'GK' && p.diveTimer > 0 ? Math.min(1, dt * 13) : Math.min(1, dt * 7.5);

    if (dist > 0.015) {
      const stepSpeed = Math.min(maxSpeed, dist * 3.4);
      p.vel.x = THREE.MathUtils.lerp(p.vel.x, (dx / dist) * stepSpeed, velLerp);
      p.vel.z = THREE.MathUtils.lerp(p.vel.z, (dz / dist) * stepSpeed, velLerp);
      if (p.role === 'GK' && p.diveTimer > 0) {
        p.facingAngle = p.team === TEAM_BLUE ? 0 : Math.PI;
      } else {
        p.facingAngle = Math.atan2(-p.vel.z, p.vel.x);
      }
    } else {
      p.vel.x = THREE.MathUtils.lerp(p.vel.x, 0, Math.min(1, dt * 8.5));
      p.vel.z = THREE.MathUtils.lerp(p.vel.z, 0, Math.min(1, dt * 8.5));
      if (p.role === 'GK' && p.diveTimer > 0) {
        p.facingAngle = p.team === TEAM_BLUE ? 0 : Math.PI;
      } else {
        // Look at the ball when idle
        p.facingAngle = Math.atan2(-(this.ballPos.z - p.pos.z), this.ballPos.x - p.pos.x);
      }
    }

    p.pos.x += p.vel.x * dt;
    p.pos.z += p.vel.z * dt;
    this.clampPlayerToPitch(p);

    const speed = Math.hypot(p.vel.x, p.vel.z);
    p.animPhase += speed * dt * 21;
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
        if (dist < minDist) {
          if (dist > 0.0001) {
            const overlap = (minDist - dist) * 0.5;
            const nx = dx / dist;
            const nz = dz / dist;
            // Apply small tangential slide so head-on collisions glide around instead of locking up
            const slide = overlap * 0.35;
            const tx = -nz * slide;
            const tz = nx * slide;
            a.pos.x += -nx * overlap + tx;
            a.pos.z += -nz * overlap + tz;
            b.pos.x += nx * overlap - tx;
            b.pos.z += nz * overlap - tz;
          } else {
            const jitter = minDist * 0.5;
            a.pos.z -= jitter;
            b.pos.z += jitter;
          }
        }
      }
    }
  }

  private resolveBallPlayerInteractions(): void {
    const contactDist = PLAYER_RADIUS + BALL_RADIUS;
    const blueCaptureDist = contactDist + 0.024;
    const leadDist = contactDist + 0.002;

    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (p.kickCooldown > 0) continue;

      const dx = this.ballPos.x - p.pos.x;
      const dz = this.ballPos.z - p.pos.z;
      const dist = Math.hypot(dx, dz);

      if (p.role === 'GK') {
        const gkReach = contactDist + (p.diveTimer > 0 ? 0.015 : 0.006);
        const gkMaxHeight = p.diveTimer > 0 ? GOAL_HEIGHT : 0.075;
        if (dist < gkReach && this.ballPos.y < gkMaxHeight) {
          if (p.diveTimer <= 0) {
            p.diveTimer = 0.32;
            p.diveDir = Math.abs(this.ballPos.z - p.pos.z) > 0.012 ? Math.sign(this.ballPos.z - p.pos.z) : 0;
          }
          const attackDir = p.team === TEAM_BLUE ? 1 : -1;
          const sideSign = this.ballPos.z >= 0 ? 1 : -1;
          this.ballPos.x = p.pos.x + attackDir * (contactDist + 0.006);
          this.ballVel.x = attackDir * 0.68;
          this.ballVel.z = sideSign * 0.30;
          this.ballVel.y = 0.14;
          this.ballFreeTimer = 0.20;
          p.kickCooldown = 0.30;
          p.kickAnim = 1;
        }
        continue;
      }

      if (this.ballPos.y > 0.055) continue;

      if (p.team === TEAM_BLUE) {
        if (this.ballFreeTimer > 0 && p.tackleTimer <= 0) continue;
        const isControlled = i === this.controlledIndex;
        const captureRadius =
          (isControlled ? blueCaptureDist : contactDist + 0.01) + (p.tackleTimer > 0 ? 0.022 : 0);
        if (dist < captureRadius) {
          if (!isControlled) {
            this.controlledIndex = i;
          }
          if (p.tackleTimer > 0) {
            for (const other of this.players) {
              if (other.team === TEAM_RED) {
                const dRed = Math.hypot(this.ballPos.x - other.pos.x, this.ballPos.z - other.pos.z);
                if (dRed < contactDist + 0.03) {
                  other.kickCooldown = 0.45;
                }
              }
            }
            this.ballPos.x = p.pos.x + Math.cos(p.facingAngle) * leadDist;
            this.ballPos.z = p.pos.z - Math.sin(p.facingAngle) * leadDist;
            this.ballVel.x = p.vel.x * 0.6;
            this.ballVel.z = p.vel.z * 0.6;
            this.ballFreeTimer = 0;
          } else {
            // Magnetize ball smoothly in front of the player's feet for firm dribbling
            const targetX = p.pos.x + Math.cos(p.facingAngle) * leadDist;
            const targetZ = p.pos.z - Math.sin(p.facingAngle) * leadDist;
            this.ballPos.x = THREE.MathUtils.lerp(this.ballPos.x, targetX, 0.55);
            this.ballPos.z = THREE.MathUtils.lerp(this.ballPos.z, targetZ, 0.55);
            this.ballVel.x = p.vel.x;
            this.ballVel.z = p.vel.z;
          }
        }
      } else if (p.team === TEAM_RED && dist < contactDist) {
        const nx = dist > 0.0001 ? dx / dist : Math.cos(p.facingAngle);
        const nz = dist > 0.0001 ? dz / dist : -Math.sin(p.facingAngle);

        // If Red contests while ANY Blue player is also in contact (50/50 contest), pop the ball free
        const contestingBlue = this.players.find(
          (b) =>
            b.team === TEAM_BLUE &&
            Math.hypot(this.ballPos.x - b.pos.x, this.ballPos.z - b.pos.z) < blueCaptureDist
        );

        if (contestingBlue) {
          this.ballFreeTimer = 0.24;
          contestingBlue.kickCooldown = 0.30;
          p.kickCooldown = 0.28;
          const sideSign = this.ballPos.z >= 0 ? -1 : 1;
          this.ballPos.x = p.pos.x + nx * (contactDist + 0.002);
          this.ballPos.z = p.pos.z + nz * (contactDist + 0.002);
          this.ballVel.x = nx * 0.22;
          this.ballVel.z = nz * 0.22 + sideSign * 0.15;
          this.ballVel.y = 0.11;
        } else {
          // Red AI dribbles toward Blue goal (-HALF_LENGTH, 0) without pushing ball backward
          const gx = -HALF_LENGTH - p.pos.x;
          const gz = -p.pos.z;
          const gd = Math.hypot(gx, gz) || 1;
          const gnx = gx / gd;
          const gnz = gz / gd;

          if (nx > 0.15) {
            // Ball ended up behind Red player (+X side); guide it laterally around toward -X
            const sideSign = nz >= 0 ? 1 : -1;
            const guideX = -0.35;
            const guideZ = sideSign * 0.94;
            this.ballPos.x = p.pos.x + guideX * (contactDist + 0.002);
            this.ballPos.z = p.pos.z + guideZ * (contactDist + 0.002);
            this.ballVel.x = THREE.MathUtils.lerp(this.ballVel.x, gnx * 0.16, 0.58);
            this.ballVel.z = THREE.MathUtils.lerp(this.ballVel.z, gnz * 0.16 + sideSign * 0.08, 0.58);
          } else {
            // Push ball cleanly outside player body toward attack path
            this.ballPos.x = p.pos.x + nx * (contactDist + 0.001);
            this.ballPos.z = p.pos.z + nz * (contactDist + 0.001);
            const dribbleX = gnx * 0.11 + p.vel.x * 1.0;
            const dribbleZ = gnz * 0.11 + p.vel.z * 1.0;
            this.ballVel.x = THREE.MathUtils.lerp(this.ballVel.x, dribbleX, 0.58);
            this.ballVel.z = THREE.MathUtils.lerp(this.ballVel.z, dribbleZ, 0.58);
          }
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

    if (inGoalMouthZ && underCrossbar) {
      if (Math.abs(this.ballPos.x) > HALF_LENGTH) {
        if (detectGoals) {
          const scoringTeam: 0 | 1 = this.ballPos.x > 0 ? TEAM_BLUE : TEAM_RED;
          if (scoringTeam === TEAM_BLUE) {
            this.blueScore += 1;
            this.statusText = 'GOL DO PRETO/BRANCO!';
          } else {
            this.redScore += 1;
            this.statusText = 'GOL DO VERDE/BRANCO!';
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
      if (dist < 0.08 || dist > 1.15) continue;
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
    if (p.diveTimer > 0) {
      const diveArc = Math.sin(THREE.MathUtils.clamp(p.diveTimer / 0.42, 0, 1) * Math.PI);
      p.bodyMesh.position.y = diveArc * 0.024;
      p.bodyMesh.rotation.x = (p.team === TEAM_BLUE ? 1 : -1) * p.diveDir * diveArc * 0.92;
      p.bodyMesh.rotation.z = 0;

      p.leftArm.rotation.z = 2.45;
      p.rightArm.rotation.z = 2.45;
      p.leftArm.rotation.x = 0.15;
      p.rightArm.rotation.x = -0.15;
      p.leftLeg.rotation.z = -0.25;
      p.rightLeg.rotation.z = -0.25;
    } else if (p.tackleTimer > 0) {
      p.bodyMesh.position.y = 0.002;
      p.bodyMesh.rotation.x = 0;
      p.bodyMesh.rotation.z = -0.82;

      p.rightLeg.rotation.z = 0.95;
      p.leftLeg.rotation.z = -0.45;
      p.leftArm.rotation.z = -0.6;
      p.rightArm.rotation.z = 0.7;
      p.leftArm.rotation.x = 0.14;
      p.rightArm.rotation.x = -0.14;
    } else {
      const bob = speed > 0.02 ? Math.abs(Math.sin(p.animPhase)) * 0.0035 : 0;
      p.bodyMesh.position.y = bob;
      p.bodyMesh.rotation.x = 0;
      p.bodyMesh.rotation.z =
        p.kickAnim > 0 ? Math.sin(p.kickAnim * Math.PI) * 0.22 : -Math.min(0.15, speed * 0.28);

      const stride = Math.min(1, speed / 0.36) * 0.75;
      const swing = Math.sin(p.animPhase) * stride;
      p.leftLeg.rotation.z = swing;
      p.rightLeg.rotation.z = p.kickAnim > 0 ? Math.sin(p.kickAnim * Math.PI) * 1.15 : -swing;
      p.leftArm.rotation.z = p.kickAnim > 0 ? -0.55 : -swing * 0.85;
      p.rightArm.rotation.z = p.kickAnim > 0 ? 0.65 : swing * 0.85;
      p.leftArm.rotation.x = 0.14;
      p.rightArm.rotation.x = -0.14;
    }
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
      0.106 + Math.sin(elapsedTime * 5) * 0.004,
      active.pos.z
    );
    this.selectionArrow.rotation.y = elapsedTime * 2;

    if (this.kickCharge > 0.02) {
      this.chargeBarBg.visible = true;
      this.chargeBarBg.position.set(active.pos.x, 0.126, active.pos.z);
      this.chargeBarBg.lookAt(cameraWorldPos);
      this.chargeBarFill.scale.x = Math.max(0.05, this.kickCharge);
      this.chargeBarFill.position.x = -0.016 * (1 - this.kickCharge);
      const fillMat = this.chargeBarFill.material as THREE.MeshBasicMaterial;
      fillMat.color.setHex(this.kickCharge > 0.75 ? 0xef4444 : this.kickCharge > 0.4 ? 0xfacc15 : 0x22c55e);
    } else {
      this.chargeBarBg.visible = false;
    }

    // Directional aim arrow & pass target ring when on the ball (or charging a shot)
    const distBall = Math.hypot(this.ballPos.x - active.pos.x, this.ballPos.z - active.pos.z);
    const showAim = !this.matchEnded && this.goalResetTimer <= 0 &&
      (distBall < PLAYER_RADIUS + BALL_RADIUS + 0.048 || this.kickCharge > 0.02);
    this.aimGuideGroup.visible = showAim;
    if (showAim) {
      this.aimGuideGroup.position.set(active.pos.x, 0, active.pos.z);
      this.aimGuideGroup.rotation.y = active.facingAngle;
      this.aimGuideMat.color.setHex(
        this.kickCharge > 0.75
          ? 0xef4444
          : this.kickCharge > 0.4
            ? 0xfacc15
            : this.kickCharge > 0.02
              ? 0x22c55e
              : 0x38bdf8
      );

      const dirX = Math.cos(active.facingAngle);
      const dirZ = -Math.sin(active.facingAngle);
      const passMate = this.findPassTarget(active, dirX, dirZ);
      if (passMate) {
        this.passTargetRing.visible = true;
        this.passTargetRing.position.set(passMate.pos.x, 0.0022, passMate.pos.z);
        this.passTargetRing.scale.setScalar(1 + Math.sin(elapsedTime * 9) * 0.07);
      } else {
        this.passTargetRing.visible = false;
      }
    } else {
      this.passTargetRing.visible = false;
    }
  }

  private emitScore(): void {
    const mins = Math.floor(this.remainingSeconds / 60);
    const secs = Math.floor(this.remainingSeconds % 60);
    const timeText = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    this.callbacks.onScoreChange?.(this.blueScore, this.redScore, timeText, this.statusText);
  }
}

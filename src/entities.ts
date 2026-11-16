import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
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
import type { WasmSoccerEngine } from './wasmEngine';

export type PlayerRole = 'GK' | 'DEF_L' | 'DEF_R' | 'MID_L' | 'MID_C' | 'MID_R' | 'FWD_L' | 'FWD_R';

export interface PlayerEntity {
  id: number;
  team: 0 | 1;
  role: PlayerRole;
  slotIndex: number;
  mesh: THREE.Group;
  bodyMesh: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  leftShin: THREE.Group;
  rightShin: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftForearm: THREE.Group;
  rightForearm: THREE.Group;
  headGroup: THREE.Group;
  glbGroup?: THREE.Group;
  mixer?: THREE.AnimationMixer;
  actions?: Record<string, THREE.AnimationAction>;
  activeActionName?: string;
  glbBones?: {
    upperLegR?: THREE.Object3D;
    lowerLegR?: THREE.Object3D;
    footR?: THREE.Object3D;
    torso?: THREE.Object3D;
    upperArmL?: THREE.Object3D;
    upperArmR?: THREE.Object3D;
  };
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  homePos: THREE.Vector3;
  baseHomePos: THREE.Vector3;
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
  kickHeld: boolean;     // Shoot button held with power gauge (X button / Space)
  passPressed: boolean;  // Short ground pass (A button / KeyE / KeyJ)
  passHeld: boolean;     // Pass button held to charge power
  throughPressed?: boolean; // PES 5 Through ball into space (Y button / KeyQ)
  lobPressed?: boolean;     // PES 5 Lob pass / Cross (B button in attack / KeyR)
  tacklePressed: boolean; // Defensive slide tackle (B button in defense / KeyC / KeyF)
  switchPressed: boolean; // Switch player (Left Grip / Left Trigger / KeyTab)
}

export interface MatchCallbacks {
  onScoreChange?: (blue: number, red: number, timeText: string, statusText: string) => void;
  onGoal?: (scoringTeam: 0 | 1) => void;
  onKick?: (power: number) => void;
  onPostHit?: () => void;
  onWhistle?: () => void;
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
  private readonly supportSpotRing: THREE.Mesh;
  private readonly chargeBarBg: THREE.Mesh;
  private readonly chargeBarFill: THREE.Mesh;

  private kickCharge = 0;
  private wasKickHeld = false;
  private passCharge = 0;
  private wasPassHeld = false;
  private autoSwitchCooldown = 0;
  private ballFreeTimer = 0;
  private ballSpinY = 0;
  private goalResetTimer = 0;
  private lastScorerTeam: 0 | 1 | null = null;
  private statusText = '';
  private kickoffTeam: 0 | 1 = TEAM_BLUE;
  public currentHalf: 1 | 2 = 1;
  public waitingSecondHalf = false;
  public matchStarted = false;
  public paused = false;
  public matchEnded = false;

  private wasmEngine: WasmSoccerEngine | null = null;
  private readonly supportSpotPos = new THREE.Vector3();
  private hasSupportSpot = false;

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

    // Tactical Support Spot ring calculated by the C++ WebAssembly AI
    this.supportSpotRing = new THREE.Mesh(
      new THREE.RingGeometry(PLAYER_RADIUS * 0.9, PLAYER_RADIUS * 1.25, 20),
      new THREE.MeshBasicMaterial({
        color: 0x34d399,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.4,
      })
    );
    this.supportSpotRing.rotation.x = -Math.PI / 2;
    this.supportSpotRing.position.y = 0.0018;
    this.supportSpotRing.visible = false;
    this.fieldRoot.add(this.supportSpotRing);

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
    this.loadGlbPlayers();
    this.currentHalf = 1;
    this.waitingSecondHalf = false;
    this.applyHalfSides();
    this.kickoffTeam = TEAM_BLUE;
    this.resetKickoff();
    this.statusText = 'AGUARDANDO INÍCIO';
    this.emitScore();
  }

  public setWasmEngine(engine: WasmSoccerEngine): void {
    this.wasmEngine = engine;
  }

  private getAttackDir(team: 0 | 1): number {
    return (team === TEAM_BLUE ? 1 : -1) * (this.currentHalf === 1 ? 1 : -1);
  }

  private applyHalfSides(): void {
    const sideSign = this.currentHalf === 1 ? 1 : -1;
    for (const p of this.players) {
      p.homePos.set(p.baseHomePos.x * sideSign, 0, p.baseHomePos.z * sideSign);
    }
  }

  public startMatch(): void {
    if (this.waitingSecondHalf) {
      this.startSecondHalf();
      return;
    }
    this.blueScore = 0;
    this.redScore = 0;
    this.currentHalf = 1;
    this.waitingSecondHalf = false;
    this.remainingSeconds = MATCH_DURATION_SECONDS;
    this.matchEnded = false;
    this.matchStarted = true;
    this.paused = false;
    this.goalResetTimer = 0;
    this.statusText = '';
    this.applyHalfSides();
    this.kickoffTeam = TEAM_BLUE;
    this.resetKickoff();
    this.callbacks.onWhistle?.();
    this.emitScore();
  }

  public startSecondHalf(): void {
    this.currentHalf = 2;
    this.waitingSecondHalf = false;
    this.matchEnded = false;
    this.matchStarted = true;
    this.paused = false;
    this.goalResetTimer = 0;
    this.remainingSeconds = MATCH_DURATION_SECONDS;
    this.statusText = '';
    this.applyHalfSides();
    this.kickoffTeam = TEAM_RED;
    this.resetKickoff();
    this.callbacks.onWhistle?.();
    this.emitScore();
  }

  public togglePause(): boolean {
    if (!this.matchStarted || this.matchEnded || this.waitingSecondHalf) return false;
    this.paused = !this.paused;
    this.statusText = this.paused ? 'JOGO PAUSADO' : '';
    this.emitScore();
    return this.paused;
  }

  public resetMatch(): void {
    this.waitingSecondHalf = false;
    this.startMatch();
  }

  public resetKickoff(): void {
    const attackDir = this.getAttackDir(this.kickoffTeam);
    this.ballPos.set(attackDir * 0.012, BALL_RADIUS, 0);
    this.ballVel.set(0, 0, 0);
    this.kickCharge = 0;
    this.wasKickHeld = false;
    this.passCharge = 0;
    this.wasPassHeld = false;
    this.ballFreeTimer = 0;
    this.ballSpinY = 0;
    this.hasSupportSpot = false;
    this.lastScorerTeam = null;

    for (const p of this.players) {
      p.pos.copy(p.homePos);
      if (p.team === this.kickoffTeam) {
        if (p.role === 'FWD_L') {
          p.pos.set(-attackDir * 0.024, 0, 0);
        } else if (p.role === 'FWD_R') {
          p.pos.set(-attackDir * 0.065, 0, 0.14);
        }
      } else if (p.role === 'FWD_L' || p.role === 'FWD_R') {
        p.pos.x = attackDir * Math.max(Math.abs(p.homePos.x), 0.24);
      }
      p.vel.set(0, 0, 0);
      p.facingAngle = this.getAttackDir(p.team) > 0 ? 0 : Math.PI;
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

    if (!this.matchStarted) {
      if (input.passPressed || input.kickHeld || input.switchPressed) {
        this.startMatch();
      } else {
        for (const p of this.players) {
          this.syncPlayerMesh(p, safeDt);
        }
        this.updateIndicators(elapsedTime, cameraWorldPos);
        return;
      }
    }

    if (this.waitingSecondHalf) {
      if (input.passPressed || input.kickHeld) {
        this.startSecondHalf();
      } else {
        for (const p of this.players) {
          this.syncPlayerMesh(p, safeDt);
        }
        this.updateIndicators(elapsedTime, cameraWorldPos);
        return;
      }
    }

    if (this.paused) {
      this.updateIndicators(elapsedTime, cameraWorldPos);
      return;
    }

    if (this.matchEnded) {
      this.updateIndicators(elapsedTime, cameraWorldPos);
      return;
    }

    if (this.goalResetTimer > 0) {
      this.goalResetTimer -= safeDt;
      this.stepBallStep(safeDt, false);
      this.syncBallMesh();
      for (const p of this.players) {
        this.syncPlayerMesh(p, safeDt);
      }
      this.updateIndicators(elapsedTime, cameraWorldPos);
      if (this.goalResetTimer <= 0) {
        this.statusText = '';
        this.lastScorerTeam = null;
        this.resetKickoff();
        this.emitScore();
      }
      return;
    }

    // Match countdown
    this.remainingSeconds = Math.max(0, this.remainingSeconds - safeDt);
    if (this.remainingSeconds <= 0) {
      if (this.currentHalf === 1) {
        this.currentHalf = 2;
        this.waitingSecondHalf = true;
        this.paused = false;
        this.remainingSeconds = MATCH_DURATION_SECONDS;
        this.applyHalfSides();
        this.kickoffTeam = TEAM_RED;
        this.resetKickoff();
        this.statusText = 'FIM DO 1º TEMPO — TROCA DE LADO!';
        this.emitScore();
        return;
      }

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

    // Update all players via WebAssembly tactical AI & collision engine when loaded, or TS fallback
    const closestRedAI = this.findClosestOutfieldIndex(TEAM_RED, -1);

    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      p.kickCooldown = Math.max(0, p.kickCooldown - safeDt);
      p.kickAnim = Math.max(0, p.kickAnim - safeDt * 4);
      p.diveTimer = Math.max(0, p.diveTimer - safeDt);
      p.tackleTimer = Math.max(0, p.tackleTimer - safeDt);
      p.tackleCooldown = Math.max(0, p.tackleCooldown - safeDt);
    }

    this.updateHumanPlayer(this.players[this.controlledIndex], safeDt, input);

    if (this.wasmEngine?.isReady) {
      this.wasmEngine.syncToWasm(
        this.players,
        this.ballPos,
        this.ballVel,
        this.ballSpinY,
        this.ballFreeTimer
      );
      const aiRes = this.wasmEngine.stepAIAndCollisions(
        safeDt,
        this.players,
        this.controlledIndex,
        closestRedAI,
        this.currentHalf,
        Math.random()
      );
      this.supportSpotPos.set(aiRes.supportSpotX, 0.0018, aiRes.supportSpotZ);
      this.hasSupportSpot = true;
      if (aiRes.aiKick) {
        const shooter = this.players[aiRes.aiKick.shooterIdx];
        if (shooter) {
          this.performKick(shooter, aiRes.aiKick.power, aiRes.aiKick.aimX, aiRes.aiKick.aimZ);
        }
      }
    } else {
      for (let i = 0; i < this.players.length; i++) {
        if (i === this.controlledIndex) continue;
        this.updateAIPlayer(this.players[i], safeDt, i === closestRedAI);
      }
      this.resolvePlayerCollisions();
    }

    this.resolveBallPlayerInteractions();
    this.stepBallStep(safeDt, true);

    this.syncBallMesh();
    for (const p of this.players) {
      this.syncPlayerMesh(p, safeDt);
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
        const {
          root,
          body,
          leftLeg,
          rightLeg,
          leftShin,
          rightShin,
          leftArm,
          rightArm,
          leftForearm,
          rightForearm,
          headGroup,
        } = this.createPlayerMesh(team, f.role === 'GK', i);
        this.fieldRoot.add(root);

        this.players.push({
          id: id++,
          team,
          role: f.role,
          slotIndex: i,
          mesh: root,
          bodyMesh: body,
          leftLeg,
          rightLeg,
          leftShin,
          rightShin,
          leftArm,
          rightArm,
          leftForearm,
          rightForearm,
          headGroup,
          pos: new THREE.Vector3(x, 0, z),
          vel: new THREE.Vector3(),
          homePos: new THREE.Vector3(x, 0, z),
          baseHomePos: new THREE.Vector3(x, 0, z),
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

  private getPlayerStyle(team: 0 | 1, isKeeper: boolean, slotIndex: number) {
    const numbers = ['1', '2', '4', '7', '8', '10', '9', '11'];
    const numStr = numbers[slotIndex % numbers.length];

    const skinPalette = [0xf5d0b5, 0xe8b896, 0xc68652, 0x8d5524, 0xf1c27d];
    const hairPalette = [0x1c1917, 0x451a03, 0x0f172a, 0x78350f, 0xd97706];
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
    const trimColor = isKeeper ? 0xfef08a : team === TEAM_BLUE ? 0x1e293b : 0xffffff;
    const numTextColor = isKeeper ? '#ffffff' : team === TEAM_BLUE ? '#111827' : '#ffffff';
    const baseRingColor = team === TEAM_BLUE ? 0xe2e8f0 : 0x22c55e;

    return {
      numStr,
      skinColor,
      hairColor,
      jerseyColor,
      shortsColor,
      sockColor,
      trimColor,
      numTextColor,
      baseRingColor,
    };
  }

  private loadGlbPlayers(): void {
    const loader = new GLTFLoader();
    loader.load(
      './models/player.glb',
      (gltf) => {
        const badgeGeo = new THREE.PlaneGeometry(0.42, 0.42);

        for (const p of this.players) {
          const isKeeper = p.role === 'GK';
          const style = this.getPlayerStyle(p.team, isKeeper, p.slotIndex);
          const clonedScene = SkeletonUtils.clone(gltf.scene) as THREE.Group;

          const glbGroup = new THREE.Group();
          const facingWrapper = new THREE.Group();
          facingWrapper.scale.setScalar(0.040);
          facingWrapper.rotation.y = Math.PI / 2;
          facingWrapper.add(clonedScene);
          glbGroup.add(facingWrapper);

          const bones: NonNullable<PlayerEntity['glbBones']> = {};

          clonedScene.traverse((obj) => {
            if ((obj as THREE.Bone).isBone) {
              if (obj.name === 'thigh_r' || obj.name === 'UpperLeg.R') bones.upperLegR = obj;
              else if (obj.name === 'calf_r' || obj.name === 'LowerLeg.R') bones.lowerLegR = obj;
              else if (obj.name === 'foot_r' || obj.name === 'Foot.R') bones.footR = obj;
              else if (obj.name === 'spine_02' || obj.name === 'spine_01' || obj.name === 'Torso') bones.torso = obj;
              else if (obj.name === 'upperarm_l' || obj.name === 'UpperArm.L') bones.upperArmL = obj;
              else if (obj.name === 'upperarm_r' || obj.name === 'UpperArm.R') bones.upperArmR = obj;
              return;
            }

            if (!(obj instanceof THREE.Mesh)) return;
            obj.castShadow = true;
            obj.receiveShadow = true;
            obj.frustumCulled = false;

            const srcMat = obj.material;
            if (!srcMat || Array.isArray(srcMat) || !(srcMat instanceof THREE.MeshStandardMaterial)) {
              return;
            }
            const mat = srcMat.clone();
            mat.metalness = 0.04;

            const matName = mat.name.toLowerCase();
            const meshName = obj.name.toLowerCase();

            if (matName.includes('shirt') || meshName.includes('shirt')) {
              mat.color.setHex(style.jerseyColor);
              mat.roughness = 0.45;
            } else if (matName.includes('collar') || matName.includes('trim') || meshName.includes('collar')) {
              mat.color.setHex(style.trimColor);
              mat.roughness = 0.45;
            } else if (matName.includes('short') || matName.includes('pant') || meshName.includes('short')) {
              mat.color.setHex(style.shortsColor);
              mat.roughness = 0.55;
            } else if (matName.includes('sock') || meshName.includes('sock')) {
              mat.color.setHex(style.sockColor);
              mat.roughness = 0.6;
            } else if (matName.includes('boot') || meshName.includes('boot')) {
              mat.color.setHex(0x111827); // Realistic cleats
              mat.roughness = 0.35;
            } else if (matName.includes('skin') || meshName.includes('body')) {
              mat.color.setHex(style.skinColor);
              mat.roughness = 0.7;
            } else if (matName.includes('eyebrow') || matName.includes('hair')) {
              mat.color.setHex(style.hairColor);
              mat.roughness = 0.8;
            }

            obj.material = mat;
          });

          if (bones.torso) {
            const numBadge = new THREE.Mesh(
              badgeGeo,
              new THREE.MeshBasicMaterial({
                map: this.createNumberBadgeTexture(style.numStr, style.numTextColor),
                transparent: true,
                depthWrite: false,
                polygonOffset: true,
                polygonOffsetFactor: -1,
              })
            );
            numBadge.position.set(0, 0.16, -0.14);
            numBadge.rotation.y = Math.PI;
            bones.torso.add(numBadge);
          }

          const mixer = new THREE.AnimationMixer(clonedScene);
          const actions: Record<string, THREE.AnimationAction> = {};
          for (const clip of gltf.animations) {
            actions[clip.name] = mixer.clipAction(clip);
          }

          const idleAction = actions.idle ?? actions.Idle ?? Object.values(actions)[0];
          if (idleAction) {
            idleAction.reset().play();
            mixer.update(p.slotIndex * 0.25);
          }

          p.glbGroup = glbGroup;
          p.mixer = mixer;
          p.actions = actions;
          p.activeActionName = idleAction ? idleAction.getClip().name : 'idle';
          p.glbBones = bones;

          p.mesh.add(glbGroup);
          p.bodyMesh.visible = false;
        }
      },
      undefined,
      (err) => {
        console.warn('[GLB] Falha ao carregar ./models/player.glb, mantendo boneco procedural.', err);
      }
    );
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
    leftShin: THREE.Group;
    rightShin: THREE.Group;
    leftArm: THREE.Group;
    rightArm: THREE.Group;
    leftForearm: THREE.Group;
    rightForearm: THREE.Group;
    headGroup: THREE.Group;
  } {
    const root = new THREE.Group();
    const body = new THREE.Group();
    body.scale.set(1.0, 1.18, 1.0);
    root.add(body);

    const {
      numStr,
      skinColor,
      hairColor,
      jerseyColor,
      shortsColor,
      sockColor,
      trimColor,
      numTextColor,
      baseRingColor,
    } = this.getPlayerStyle(team, isKeeper, slotIndex);

    // Ground contact shadow + slim team ring flush with grass so cleats stand directly on turf
    const contactShadow = new THREE.Mesh(
      new THREE.CircleGeometry(PLAYER_RADIUS * 0.7, 20),
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.34,
        depthWrite: false,
      })
    );
    contactShadow.rotation.x = -Math.PI / 2;
    contactShadow.position.y = 0.0005;
    root.add(contactShadow);

    const baseRing = new THREE.Mesh(
      new THREE.RingGeometry(PLAYER_RADIUS * 0.65, PLAYER_RADIUS * 0.74, 24),
      new THREE.MeshBasicMaterial({
        color: baseRingColor,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.72,
      })
    );
    baseRing.rotation.x = -Math.PI / 2;
    baseRing.position.y = 0.0009;
    root.add(baseRing);

    const shortsMat = new THREE.MeshStandardMaterial({ color: shortsColor, roughness: 0.62 });
    const sockMat = new THREE.MeshStandardMaterial({ color: sockColor, roughness: 0.58 });
    const bootMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.36 });
    const soleMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.5 });
    const bootAccentMat = new THREE.MeshStandardMaterial({ color: trimColor, roughness: 0.42 });
    const jerseyMat = new THREE.MeshStandardMaterial({ color: jerseyColor, roughness: 0.52 });
    const trimMat = new THREE.MeshStandardMaterial({ color: trimColor, roughness: 0.48 });
    const skinMat = new THREE.MeshStandardMaterial({ color: skinColor, roughness: 0.68 });

    // Articulated 2-segment legs: hip -> thigh/shorts -> knee pivot -> calf/sock -> sculpted cleat
    const createLeg = (zOffset: number): { legGroup: THREE.Group; shinGroup: THREE.Group } => {
      const legGroup = new THREE.Group();
      legGroup.position.set(0, 0.0296, zOffset);

      const hipJoint = new THREE.Mesh(new THREE.SphereGeometry(0.0044, 10, 10), shortsMat);
      hipJoint.scale.set(0.88, 0.9, 0.96);
      legGroup.add(hipJoint);

      const shortsLeg = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0048, 0.0043, 0.0085, 12),
        shortsMat
      );
      shortsLeg.scale.set(0.88, 1, 0.96);
      shortsLeg.position.y = -0.004;
      shortsLeg.castShadow = true;
      legGroup.add(shortsLeg);

      const shortsHem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0044, 0.0045, 0.0012, 12),
        trimMat
      );
      shortsHem.scale.set(0.88, 1, 0.96);
      shortsHem.position.y = -0.0082;
      legGroup.add(shortsHem);

      const thighSkin = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0039, 0.0033, 0.0058, 12),
        skinMat
      );
      thighSkin.position.y = -0.0108;
      thighSkin.castShadow = true;
      legGroup.add(thighSkin);

      const knee = new THREE.Mesh(new THREE.SphereGeometry(0.0032, 10, 10), skinMat);
      knee.position.y = -0.0135;
      legGroup.add(knee);

      const shinGroup = new THREE.Group();
      shinGroup.position.set(0, -0.0135, 0);
      legGroup.add(shinGroup);

      const sockBand = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0036, 0.0037, 0.0015, 12),
        trimMat
      );
      sockBand.position.y = -0.0014;
      shinGroup.add(sockBand);

      const calfSock = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0035, 0.0024, 0.0112, 12),
        sockMat
      );
      calfSock.position.y = -0.0064;
      calfSock.castShadow = true;
      shinGroup.add(calfSock);

      // Sculpted soccer boot with heel cup, toe box, laces area, stripe & sole
      const bootUpper = new THREE.Mesh(new THREE.BoxGeometry(0.0088, 0.0032, 0.0044), bootMat);
      bootUpper.position.set(0.0014, -0.0135, 0);
      bootUpper.castShadow = true;
      shinGroup.add(bootUpper);

      const toeCap = new THREE.Mesh(new THREE.SphereGeometry(0.0021, 10, 8), bootMat);
      toeCap.scale.set(1.3, 0.72, 1.02);
      toeCap.position.set(0.0058, -0.0139, 0);
      toeCap.castShadow = true;
      shinGroup.add(toeCap);

      const heelCup = new THREE.Mesh(new THREE.BoxGeometry(0.0032, 0.0038, 0.0045), bootMat);
      heelCup.position.set(-0.002, -0.0132, 0);
      shinGroup.add(heelCup);

      const cleatStripe = new THREE.Mesh(
        new THREE.BoxGeometry(0.0048, 0.0011, 0.0047),
        bootAccentMat
      );
      cleatStripe.position.set(0.0016, -0.0134, 0);
      shinGroup.add(cleatStripe);

      const outsole = new THREE.Mesh(new THREE.BoxGeometry(0.0102, 0.0009, 0.0046), soleMat);
      outsole.position.set(0.0018, -0.0152, 0);
      shinGroup.add(outsole);

      body.add(legGroup);
      return { legGroup, shinGroup };
    };

    const { legGroup: leftLeg, shinGroup: leftShin } = createLeg(-0.0054);
    const { legGroup: rightLeg, shinGroup: rightShin } = createLeg(0.0054);

    // Anatomical pelvis + tapered waist + athletic chest + sloped clavicles + collar + badge
    const pelvis = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0094, 0.0090, 0.0085, 14),
      shortsMat
    );
    pelvis.scale.set(0.68, 1, 1.12);
    pelvis.position.y = 0.0306;
    pelvis.castShadow = true;
    body.add(pelvis);

    const waist = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0091, 0.0086, 0.0082, 14),
      jerseyMat
    );
    waist.scale.set(0.65, 1, 1.04);
    waist.position.y = 0.0372;
    waist.castShadow = true;
    body.add(waist);

    const chest = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0115, 0.0090, 0.0145, 16),
      jerseyMat
    );
    chest.scale.set(0.68, 1, 1.18);
    chest.position.y = 0.0468;
    chest.castShadow = true;
    body.add(chest);

    const upperShoulders = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0058, 0.0112, 0.0040, 14),
      jerseyMat
    );
    upperShoulders.scale.set(0.64, 1, 1.16);
    upperShoulders.position.y = 0.0545;
    upperShoulders.castShadow = true;
    body.add(upperShoulders);

    // Jersey side rib stripes + front chest crest
    for (const side of [-1, 1] as const) {
      const sideStripe = new THREE.Mesh(
        new THREE.BoxGeometry(0.0022, 0.0195, 0.0012),
        trimMat
      );
      sideStripe.position.set(0, 0.0435, side * 0.0114);
      sideStripe.rotation.x = side * -0.11;
      body.add(sideStripe);
    }

    const chestCrest = new THREE.Mesh(new THREE.BoxGeometry(0.0010, 0.0032, 0.0028), trimMat);
    chestCrest.position.set(0.0074, 0.0485, 0.0042);
    chestCrest.rotation.z = 0.12;
    body.add(chestCrest);

    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.0047, 0.0011, 8, 16), trimMat);
    collar.rotation.x = Math.PI / 2;
    collar.position.set(0.0004, 0.0556, 0);
    body.add(collar);

    const numBadge = new THREE.Mesh(
      new THREE.PlaneGeometry(0.0115, 0.0115),
      new THREE.MeshBasicMaterial({
        map: this.createNumberBadgeTexture(numStr, numTextColor),
        transparent: true,
        depthWrite: false,
      })
    );
    numBadge.position.set(-0.0080, 0.0462, 0);
    numBadge.rotation.y = -Math.PI / 2;
    body.add(numBadge);

    // Articulated 2-segment arms: deltoid shoulder -> sleeve -> upper arm -> elbow -> forearm -> hand/glove
    const gloveMat = new THREE.MeshStandardMaterial({ color: 0xfef08a, roughness: 0.4 });
    const createArm = (
      zOffset: number
    ): { armGroup: THREE.Group; forearmGroup: THREE.Group } => {
      const armGroup = new THREE.Group();
      armGroup.position.set(0, 0.0518, zOffset);

      const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.0041, 10, 10), jerseyMat);
      shoulder.castShadow = true;
      armGroup.add(shoulder);

      const sleeve = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0039, 0.0034, 0.0076, 10),
        jerseyMat
      );
      sleeve.position.y = -0.0036;
      sleeve.castShadow = true;
      armGroup.add(sleeve);

      const sleeveCuff = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0035, 0.0035, 0.0010, 10),
        trimMat
      );
      sleeveCuff.position.y = -0.0072;
      armGroup.add(sleeveCuff);

      const upperArmMat = isKeeper ? jerseyMat : skinMat;
      const bicep = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0031, 0.0028, 0.0042, 10),
        upperArmMat
      );
      bicep.position.y = -0.0088;
      bicep.castShadow = true;
      armGroup.add(bicep);

      const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.0028, 8, 8), upperArmMat);
      elbow.position.y = -0.0108;
      armGroup.add(elbow);

      const forearmGroup = new THREE.Group();
      forearmGroup.position.set(0, -0.0108, 0);
      armGroup.add(forearmGroup);

      const forearmMesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0028, 0.0022, 0.0082, 10),
        upperArmMat
      );
      forearmMesh.position.y = -0.0041;
      forearmMesh.castShadow = true;
      forearmGroup.add(forearmMesh);

      const wristband = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0023, 0.0023, 0.0014, 10),
        trimMat
      );
      wristband.position.y = -0.0078;
      forearmGroup.add(wristband);

      if (isKeeper) {
        const glove = new THREE.Mesh(new THREE.BoxGeometry(0.0048, 0.0054, 0.0036), gloveMat);
        glove.position.set(0.0005, -0.0102, 0);
        glove.castShadow = true;
        forearmGroup.add(glove);
      } else {
        const palm = new THREE.Mesh(new THREE.SphereGeometry(0.0025, 8, 8), skinMat);
        palm.scale.set(0.95, 1.35, 0.65);
        palm.position.set(0.0002, -0.0098, 0);
        palm.castShadow = true;
        forearmGroup.add(palm);

        const thumb = new THREE.Mesh(new THREE.SphereGeometry(0.0011, 6, 6), skinMat);
        thumb.position.set(0.0018, -0.0088, 0);
        forearmGroup.add(thumb);
      }

      body.add(armGroup);
      return { armGroup, forearmGroup };
    };

    const { armGroup: leftArm, forearmGroup: leftForearm } = createArm(-0.0138);
    const { armGroup: rightArm, forearmGroup: rightForearm } = createArm(0.0138);

    // Articulated head group: neck -> cranium + jawline -> ears, nose, sclera+pupils, brows & hairstyles
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 0.0558, 0);
    body.add(headGroup);

    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.0036, 0.0041, 0.0052, 12), skinMat);
    neck.position.y = 0.0022;
    neck.castShadow = true;
    headGroup.add(neck);

    const cranium = new THREE.Mesh(new THREE.SphereGeometry(0.0083, 18, 16), skinMat);
    cranium.scale.set(1.02, 1.14, 0.90);
    cranium.position.y = 0.0098;
    cranium.castShadow = true;
    headGroup.add(cranium);

    const jaw = new THREE.Mesh(new THREE.SphereGeometry(0.0053, 12, 10), skinMat);
    jaw.scale.set(1.06, 0.85, 0.78);
    jaw.position.set(0.0021, 0.0056, 0);
    headGroup.add(jaw);

    const earGeo = new THREE.SphereGeometry(0.0017, 8, 8);
    for (const side of [-1, 1] as const) {
      const ear = new THREE.Mesh(earGeo, skinMat);
      ear.scale.set(0.55, 1.2, 0.45);
      ear.position.set(0.0002, 0.0094, side * 0.0075);
      headGroup.add(ear);
    }

    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.0015, 8, 8), skinMat);
    nose.scale.set(1.25, 1.1, 0.82);
    nose.position.set(0.0084, 0.0090, 0);
    headGroup.add(nose);

    const scleraMat = new THREE.MeshBasicMaterial({ color: 0xf8fafc });
    const pupilMat = new THREE.MeshBasicMaterial({ color: 0x0f172a });
    const hairMat = new THREE.MeshStandardMaterial({ color: hairColor, roughness: 0.78 });
    const scleraGeo = new THREE.SphereGeometry(0.0012, 8, 8);
    const pupilGeo = new THREE.SphereGeometry(0.00075, 6, 6);
    const browGeo = new THREE.BoxGeometry(0.0010, 0.0007, 0.0025);

    for (const side of [-1, 1] as const) {
      const sclera = new THREE.Mesh(scleraGeo, scleraMat);
      sclera.scale.set(0.65, 0.95, 1.0);
      sclera.position.set(0.0078, 0.0105, side * 0.0030);
      headGroup.add(sclera);

      const pupil = new THREE.Mesh(pupilGeo, pupilMat);
      pupil.position.set(0.0084, 0.0105, side * 0.0030);
      headGroup.add(pupil);

      const brow = new THREE.Mesh(browGeo, hairMat);
      brow.position.set(0.0080, 0.0124, side * 0.0030);
      brow.rotation.x = side * 0.12;
      headGroup.add(brow);
    }

    const mouth = new THREE.Mesh(
      new THREE.BoxGeometry(0.0007, 0.0006, 0.0026),
      new THREE.MeshBasicMaterial({ color: 0x9f5f52 })
    );
    mouth.position.set(0.0073, 0.0066, 0);
    headGroup.add(mouth);

    // Hair cap + varied human hairstyles
    const hairCap = new THREE.Mesh(
      new THREE.SphereGeometry(0.0088, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.56),
      hairMat
    );
    hairCap.scale.set(1.02, 1.12, 0.91);
    hairCap.position.set(-0.0006, 0.0104, 0);
    hairCap.rotation.z = 0.24;
    headGroup.add(hairCap);

    const hairBack = new THREE.Mesh(
      new THREE.SphereGeometry(0.0068, 12, 10),
      hairMat
    );
    hairBack.scale.set(0.65, 1.0, 0.88);
    hairBack.position.set(-0.0048, 0.0088, 0);
    headGroup.add(hairBack);

    const hairStyle = slotIndex % 4;
    if (hairStyle === 1) {
      // Sculpted forward quiff / crest
      const quiff = new THREE.Mesh(new THREE.BoxGeometry(0.0072, 0.0038, 0.0052), hairMat);
      quiff.position.set(0.0022, 0.0196, 0);
      quiff.rotation.z = -0.26;
      headGroup.add(quiff);
    } else if (hairStyle === 2) {
      // Textured curly / afro crown
      const curlOffsets: [number, number, number, number][] = [
        [0, 0.0195, 0, 0.0058],
        [0.0032, 0.0182, 0.0032, 0.0042],
        [0.0032, 0.0182, -0.0032, 0.0042],
        [-0.0034, 0.0180, 0.0030, 0.0042],
        [-0.0034, 0.0180, -0.0030, 0.0042],
      ];
      for (const [cx, cy, cz, cr] of curlOffsets) {
        const puff = new THREE.Mesh(new THREE.SphereGeometry(cr, 8, 8), hairMat);
        puff.position.set(cx, cy, cz);
        headGroup.add(puff);
      }
    } else if (hairStyle === 3) {
      // Athletic headband + back knot/bun
      const headband = new THREE.Mesh(new THREE.TorusGeometry(0.0080, 0.0010, 6, 18), trimMat);
      headband.rotation.x = Math.PI / 2;
      headband.scale.set(1.02, 0.90, 1);
      headband.position.set(-0.0002, 0.0138, 0);
      headGroup.add(headband);

      const hairKnot = new THREE.Mesh(new THREE.SphereGeometry(0.0032, 8, 8), hairMat);
      hairKnot.position.set(-0.0088, 0.0112, 0);
      headGroup.add(hairKnot);
    }

    return {
      root,
      body,
      leftLeg,
      rightLeg,
      leftShin,
      rightShin,
      leftArm,
      rightArm,
      leftForearm,
      rightForearm,
      headGroup,
    };
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
      // Button A (Quest) / E,J (PC): Start charging pass when on the ball, or steal/switch-and-steal when defending
      this.kickCharge = 0;
      this.wasKickHeld = false;
      if (hasBall) {
        this.wasPassHeld = true;
        this.passCharge = 0.08;
      } else if (distToBall < PLAYER_RADIUS + BALL_RADIUS + 0.14 && p.tackleCooldown <= 0) {
        this.wasPassHeld = false;
        this.passCharge = 0;
        this.performSteal(p, input.moveX, input.moveZ);
        return;
      } else {
        this.wasPassHeld = false;
        this.passCharge = 0;
        this.switchToClosestBluePlayer();
        this.autoSwitchCooldown = 0.35;
        const nextP = this.players[this.controlledIndex];
        if (nextP) {
          const nextDist = Math.hypot(this.ballPos.x - nextP.pos.x, this.ballPos.z - nextP.pos.z);
          if (nextDist < PLAYER_RADIUS + BALL_RADIUS + 0.16 && nextP.tackleCooldown <= 0) {
            this.performSteal(nextP, input.moveX, input.moveZ);
          }
        }
        return;
      }
    }

    if (this.wasPassHeld) {
      if (input.passHeld) {
        this.passCharge = Math.min(1, this.passCharge + dt * 1.85);
        return;
      }
      const passPower = this.passCharge;
      this.passCharge = 0;
      this.wasPassHeld = false;
      if (distToBall < PLAYER_RADIUS + BALL_RADIUS + 0.085 && this.ballPos.y < 0.075) {
        this.performPass(p, passPower, input.moveX, input.moveZ);
        return;
      }
    }

    if (input.throughPressed) {
      // Button Y (Quest) / Q,Y (PC): PES Through Ball (Passe em Profundidade)
      if (hasBall || distToBall < PLAYER_RADIUS + BALL_RADIUS + 0.085) {
        this.performThroughPass(p, input.moveX, input.moveZ);
        return;
      }
    }

    if (input.lobPressed) {
      // Button B (Quest) / R (PC): Lob Pass when having ball, or Slide Tackle when defending
      if (hasBall) {
        this.performLobPass(p, input.moveX, input.moveZ);
        return;
      } else if (p.tackleCooldown <= 0) {
        this.performTackle(p, input.moveX, input.moveZ);
        return;
      }
    }

    if (input.tacklePressed) {
      // Button B on defense (Quest) / C,F (PC): Defensive slide tackle
      this.kickCharge = 0;
      this.wasKickHeld = false;
      this.passCharge = 0;
      this.wasPassHeld = false;
      if (p.tackleCooldown <= 0) {
        this.performTackle(p, input.moveX, input.moveZ);
      }
      return;
    }

    if (input.kickHeld) {
      // Button X (Quest) / Space (PC): Charge shot on goal
      this.kickCharge = Math.min(1, this.kickCharge + dt * 1.85);
      this.wasKickHeld = true;
    } else if (this.wasKickHeld) {
      // Released shoot button
      this.wasKickHeld = false;
      const power = 0.45 + this.kickCharge * 0.55;
      this.kickCharge = 0;

      if (hasBall) {
        this.performKick(p, power, input.moveX, input.moveZ);
      } else if (distToBall < 0.10 && p.tackleCooldown <= 0) {
        this.performSteal(p, input.moveX, input.moveZ);
      }
    }
  }

  private performSteal(p: PlayerEntity, aimX = 0, aimZ = 0): void {
    let dirX = Math.cos(p.facingAngle);
    let dirZ = -Math.sin(p.facingAngle);

    const dxBall = this.ballPos.x - p.pos.x;
    const dzBall = this.ballPos.z - p.pos.z;
    const distBall = Math.hypot(dxBall, dzBall);
    if (distBall > 0.001) {
      dirX = dxBall / distBall;
      dirZ = dzBall / distBall;
    } else if (Math.hypot(aimX, aimZ) > 0.15) {
      const len = Math.hypot(aimX, aimZ);
      dirX = aimX / len;
      dirZ = aimZ / len;
    }

    p.facingAngle = Math.atan2(-dirZ, dirX);
    p.tackleTimer = 0.18;
    p.tackleCooldown = 0.48;

    const contactDist = PLAYER_RADIUS + BALL_RADIUS;
    if (distBall < contactDist + 0.085 && this.ballPos.y < 0.075) {
      for (const other of this.players) {
        if (other.team === TEAM_RED) {
          const dRed = Math.hypot(this.ballPos.x - other.pos.x, this.ballPos.z - other.pos.z);
          if (dRed < contactDist + 0.04) {
            other.kickCooldown = 0.45;
          }
        }
      }
      const leadDist = contactDist + 0.002;
      this.ballPos.x = p.pos.x + dirX * leadDist;
      this.ballPos.z = p.pos.z + dirZ * leadDist;
      this.ballVel.x = p.vel.x * 0.5;
      this.ballVel.z = p.vel.z * 0.5;
      this.ballFreeTimer = 0;
      this.callbacks.onKick?.(0.30);
    }
  }

  private performPass(p: PlayerEntity, power = 0.35, aimX = 0, aimZ = 0): void {
    let dirX = Math.cos(p.facingAngle);
    let dirZ = -Math.sin(p.facingAngle);
    const hasInput = Math.hypot(aimX, aimZ) > 0.15;

    if (hasInput) {
      const len = Math.hypot(aimX, aimZ);
      dirX = aimX / len;
      dirZ = aimZ / len;
    }

    const mate = this.findPassTarget(p, dirX, dirZ, hasInput);
    const powerBoost = 0.72 + power * 0.78;
    let speed = 0.58 * powerBoost;

    if (mate) {
      const dRaw = Math.hypot(mate.pos.x - this.ballPos.x, mate.pos.z - this.ballPos.z);
      const leadTime = THREE.MathUtils.clamp(dRaw * 0.15, 0.04, 0.16);
      const targetX = mate.pos.x + mate.vel.x * leadTime;
      const targetZ = mate.pos.z + mate.vel.z * leadTime;
      const dx = targetX - this.ballPos.x;
      const dz = targetZ - this.ballPos.z;
      const d = Math.hypot(dx, dz) || 1;
      dirX = dx / d;
      dirZ = dz / d;
      const baseSpeed = THREE.MathUtils.clamp(0.48 + d * 0.92, 0.52, 0.98);
      speed = THREE.MathUtils.clamp(baseSpeed * powerBoost, 0.48, 1.48);

      const mateIdx = this.players.indexOf(mate);
      if (mateIdx !== -1) {
        this.controlledIndex = mateIdx;
        this.autoSwitchCooldown = 0.50;
      }
    }

    const launchDist = PLAYER_RADIUS + BALL_RADIUS + 0.003;
    this.ballPos.x = p.pos.x + dirX * launchDist;
    this.ballPos.z = p.pos.z + dirZ * launchDist;
    this.ballVel.set(dirX * speed, 0.02 + power * 0.06, dirZ * speed);
    const sideCross = dirX * p.vel.z - dirZ * p.vel.x;
    this.ballSpinY = THREE.MathUtils.clamp(sideCross * 6.0, -2.0, 2.0);
    p.facingAngle = Math.atan2(-dirZ, dirX);
    p.kickCooldown = 0.30;
    p.kickAnim = 1;
    this.ballFreeTimer = 0.14;
    this.callbacks.onKick?.(0.35 + power * 0.45);
  }

  private performThroughPass(p: PlayerEntity, aimX = 0, aimZ = 0): void {
    let dirX = Math.cos(p.facingAngle);
    let dirZ = -Math.sin(p.facingAngle);
    const hasInput = Math.hypot(aimX, aimZ) > 0.15;
    if (hasInput) {
      const len = Math.hypot(aimX, aimZ);
      dirX = aimX / len;
      dirZ = aimZ / len;
    }

    const attackDir = this.getAttackDir(p.team);
    let targetX = p.pos.x + dirX * 0.42;
    let targetZ = p.pos.z + dirZ * 0.42;
    let targetMate: PlayerEntity | null = null;

    // Use WASM through pass finder if ready
    const throughTarget = this.wasmEngine?.findThroughPassTarget(
      p.id,
      dirX,
      dirZ,
      this.currentHalf
    );

    if (throughTarget && throughTarget.targetIdx >= 0) {
      targetX = throughTarget.targetX;
      targetZ = throughTarget.targetZ;
      targetMate = this.players[throughTarget.targetIdx];
    } else {
      let bestScore = -1e9;
      for (const mate of this.players) {
        if (mate.team !== p.team || mate.role === 'GK' || mate.id === p.id) continue;
        const forwardGain = (mate.pos.x - p.pos.x) * attackDir;
        if (forwardGain < -0.05) continue;
        const dx = mate.pos.x - p.pos.x;
        const dz = mate.pos.z - p.pos.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.12) continue;
        const align = (dx * dirX + dz * dirZ) / dist;
        if (align < 0.05) continue;
        const score = align * 2.0 + forwardGain * 1.5 - dist * 0.5;
        if (score > bestScore) {
          bestScore = score;
          targetMate = mate;
        }
      }
      if (targetMate) {
        const leadDist = THREE.MathUtils.clamp(
          0.12 + Math.hypot(targetMate.pos.x - p.pos.x, targetMate.pos.z - p.pos.z) * 0.22,
          0.14,
          0.38
        );
        targetX = THREE.MathUtils.clamp(
          targetMate.pos.x + attackDir * leadDist,
          -HALF_LENGTH + 0.12,
          HALF_LENGTH - 0.12
        );
        targetZ = THREE.MathUtils.clamp(
          targetMate.pos.z + targetMate.vel.z * 0.4,
          -HALF_WIDTH + 0.08,
          HALF_WIDTH - 0.08
        );
      }
    }

    const tdx = targetX - this.ballPos.x;
    const tdz = targetZ - this.ballPos.z;
    const tdist = Math.hypot(tdx, tdz) || 1;
    const passDirX = tdx / tdist;
    const passDirZ = tdz / tdist;

    const launchDist = PLAYER_RADIUS + BALL_RADIUS + 0.003;
    this.ballPos.x = p.pos.x + passDirX * launchDist;
    this.ballPos.z = p.pos.z + passDirZ * launchDist;
    const passSpeed = THREE.MathUtils.clamp(0.68 + tdist * 0.72, 0.75, 1.40);
    this.ballVel.set(passDirX * passSpeed, 0.03, passDirZ * passSpeed);
    const sideCross = passDirX * p.vel.z - passDirZ * p.vel.x;
    this.ballSpinY = THREE.MathUtils.clamp(sideCross * 4.0, -1.8, 1.8);

    p.facingAngle = Math.atan2(-passDirZ, passDirX);
    p.kickCooldown = 0.32;
    p.kickAnim = 1;
    this.ballFreeTimer = 0.16;

    if (targetMate) {
      this.controlledIndex = targetMate.id;
      this.autoSwitchCooldown = 0.55;
    }
    this.callbacks.onKick?.(0.55);
  }

  private performLobPass(p: PlayerEntity, aimX = 0, aimZ = 0): void {
    let dirX = Math.cos(p.facingAngle);
    let dirZ = -Math.sin(p.facingAngle);
    if (Math.hypot(aimX, aimZ) > 0.15) {
      const len = Math.hypot(aimX, aimZ);
      dirX = aimX / len;
      dirZ = aimZ / len;
    }

    const mate = this.findPassTarget(p, dirX, dirZ, true);
    let targetX = p.pos.x + dirX * 0.65;
    let targetZ = p.pos.z + dirZ * 0.65;
    if (mate) {
      targetX = mate.pos.x + mate.vel.x * 0.25;
      targetZ = mate.pos.z + mate.vel.z * 0.25;
      const mateIdx = this.players.indexOf(mate);
      if (mateIdx !== -1) {
        this.controlledIndex = mateIdx;
        this.autoSwitchCooldown = 0.65;
      }
    }

    const dx = targetX - this.ballPos.x;
    const dz = targetZ - this.ballPos.z;
    const dist = Math.hypot(dx, dz) || 1;
    const ndx = dx / dist;
    const ndz = dz / dist;

    const launchDist = PLAYER_RADIUS + BALL_RADIUS + 0.003;
    this.ballPos.x = p.pos.x + ndx * launchDist;
    this.ballPos.z = p.pos.z + ndz * launchDist;
    const speed = THREE.MathUtils.clamp(0.55 + dist * 0.52, 0.60, 1.20);
    this.ballVel.set(ndx * speed, 0.24 + dist * 0.08, ndz * speed);

    p.facingAngle = Math.atan2(-ndz, ndx);
    p.kickCooldown = 0.35;
    p.kickAnim = 1;
    this.ballFreeTimer = 0.22;
    this.callbacks.onKick?.(0.65);
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
    const attackDir = this.getAttackDir(p.team);
    if (p.team === TEAM_BLUE && dirX * attackDir > 0.2) {
      const goalX = attackDir * HALF_LENGTH;
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

    const launchDist = PLAYER_RADIUS + BALL_RADIUS + 0.003;
    this.ballPos.x = p.pos.x + dirX * launchDist;
    this.ballPos.z = p.pos.z + dirZ * launchDist;

    const baseSpeed = p.team === TEAM_BLUE ? 0.98 : 0.78;
    const powerScale = p.team === TEAM_BLUE ? 1.18 : 0.92;
    const speed = baseSpeed + power * powerScale;
    this.ballVel.x = dirX * speed + (hasExplicitAim ? 0 : p.vel.x * 0.25);
    this.ballVel.z = dirZ * speed + (hasExplicitAim ? 0 : p.vel.z * 0.25);
    this.ballVel.y = 0.07 + power * 0.22;
    const sideCross = dirX * p.vel.z - dirZ * p.vel.x;
    this.ballSpinY = THREE.MathUtils.clamp(sideCross * 8.5, -2.8, 2.8);

    p.kickCooldown = 0.32;
    p.kickAnim = 1;
    this.ballFreeTimer = 0.18;
    this.callbacks.onKick?.(power);
  }

  private updateAIPlayer(p: PlayerEntity, dt: number, isPresser: boolean): void {
    const attackDir = this.getAttackDir(p.team);
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
      if ((p.pos.x - this.ballPos.x) * attackDir > 0.01 && distBall < 0.09) {
        // Steer around the ball when caught on its goal-side so CPU never deadlocks pushing backward
        const sideSign = p.pos.z >= this.ballPos.z ? 1 : -1;
        target.set(
          THREE.MathUtils.clamp(this.ballPos.x - attackDir * 0.048, -HALF_LENGTH + 0.06, HALF_LENGTH - 0.06),
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
              const forwardGain = (mate.pos.x - p.pos.x) * attackDir * 2.0;
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
            if (bestMate && ((bestMate.pos.x - p.pos.x) * attackDir > 0.04 || nearPerimeter || underPressure)) {
              const px = bestMate.pos.x + attackDir * 0.04 - this.ballPos.x;
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
      const relHomeX = p.homePos.x * attackDir;
      const relBallX = this.ballPos.x * attackDir;
      if (p.role === 'FWD_L' || p.role === 'FWD_R') {
        const baseAdv = relHomeX + relBallX * 0.82 + 0.30;
        const rawX = relBallX > -0.15 ? Math.max(baseAdv, relBallX + 0.20) : baseAdv;
        target.x = THREE.MathUtils.clamp(rawX, -HALF_LENGTH + 0.20, HALF_LENGTH - 0.12) * attackDir;
        target.z = THREE.MathUtils.clamp(
          p.homePos.z * 0.88 + this.ballPos.z * 0.32,
          -HALF_WIDTH + 0.07,
          HALF_WIDTH - 0.07
        );
      } else if (p.role === 'MID_C') {
        // Central holding midfielder screens the top of the penalty box
        if (relBallX < 0) {
          target.x = THREE.MathUtils.clamp(relHomeX + relBallX * 0.45, -HALF_LENGTH + 0.24, -0.08) * attackDir;
          target.z = THREE.MathUtils.clamp(this.ballPos.z * 0.52, -0.28, 0.28);
        } else {
          target.x =
            THREE.MathUtils.clamp(relHomeX + relBallX * 0.68 + 0.14, -HALF_LENGTH + 0.24, HALF_LENGTH * 0.45) *
            attackDir;
          target.z = THREE.MathUtils.clamp(this.ballPos.z * 0.35, -0.26, 0.26);
        }
      } else if (p.role === 'MID_L' || p.role === 'MID_R') {
        const tuckFactor = relBallX < 0 ? 0.72 : 0.92;
        const pushBonus = relBallX > 0 ? 0.24 : -0.04;
        target.x =
          THREE.MathUtils.clamp(relHomeX + relBallX * 0.72 + pushBonus, -HALF_LENGTH + 0.18, HALF_LENGTH * 0.68) *
          attackDir;
        target.z = THREE.MathUtils.clamp(
          p.homePos.z * tuckFactor + this.ballPos.z * (relBallX < 0 ? 0.28 : 0.35),
          -HALF_WIDTH + 0.07,
          HALF_WIDTH - 0.07
        );
      } else {
        // Center-backs (DEF_L / DEF_R) guard the goal corridor compactly
        const slotZ = (p.role === 'DEF_L' ? -1 : 1) * 0.085 * attackDir;
        if (relBallX < 0.15) {
          const goalSideX = Math.min(relHomeX + relBallX * 0.38, relBallX - 0.14);
          target.x = THREE.MathUtils.clamp(goalSideX, -HALF_LENGTH + 0.13, -0.18) * attackDir;
          target.z = THREE.MathUtils.clamp(
            this.ballPos.z * 0.52 + slotZ,
            -GOAL_WIDTH * 0.85,
            GOAL_WIDTH * 0.85
          );
        } else {
          target.x =
            THREE.MathUtils.clamp(relHomeX + relBallX * 0.35, -HALF_LENGTH + 0.16, -0.16) * attackDir;
          target.z = THREE.MathUtils.clamp(
            p.homePos.z * 0.75 + this.ballPos.z * 0.25,
            -GOAL_WIDTH * 1.05,
            GOAL_WIDTH * 1.05
          );
        }
      }
    } else {
      // Red AI role-based off-ball tactical shift across the pitch
      const relHomeX = p.homePos.x * attackDir;
      const relBallX = this.ballPos.x * attackDir;
      if (p.role === 'FWD_L' || p.role === 'FWD_R') {
        const pushBonus = relBallX > 0 ? 0.26 : 0;
        const rawX =
          relBallX > -0.15
            ? Math.max(relHomeX + relBallX * 0.78 + pushBonus, relBallX + 0.18)
            : relHomeX + relBallX * 0.72;
        target.x = THREE.MathUtils.clamp(rawX, -HALF_LENGTH + 0.18, HALF_LENGTH - 0.14) * attackDir;
        target.z = THREE.MathUtils.clamp(
          p.homePos.z * 0.88 + this.ballPos.z * 0.34,
          -HALF_WIDTH + 0.06,
          HALF_WIDTH - 0.06
        );
      } else if (p.role === 'MID_L' || p.role === 'MID_C' || p.role === 'MID_R') {
        const pushBonus = relBallX > 0 ? 0.20 : -0.06;
        target.x =
          THREE.MathUtils.clamp(relHomeX + relBallX * 0.70 + pushBonus, -HALF_LENGTH + 0.18, HALF_LENGTH * 0.68) *
          attackDir;
        target.z = THREE.MathUtils.clamp(
          p.homePos.z * 0.90 + this.ballPos.z * 0.36,
          -HALF_WIDTH + 0.06,
          HALF_WIDTH - 0.06
        );
      } else {
        const dropBonus = relBallX < 0 ? -0.18 : 0.10;
        target.x =
          THREE.MathUtils.clamp(relHomeX + relBallX * 0.55 + dropBonus, -HALF_LENGTH + 0.14, HALF_LENGTH * 0.25) *
          attackDir;
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
        p.facingAngle = attackDir > 0 ? 0 : Math.PI;
      } else {
        p.facingAngle = Math.atan2(-p.vel.z, p.vel.x);
      }
    } else {
      p.vel.x = THREE.MathUtils.lerp(p.vel.x, 0, Math.min(1, dt * 8.5));
      p.vel.z = THREE.MathUtils.lerp(p.vel.z, 0, Math.min(1, dt * 8.5));
      if (p.role === 'GK' && p.diveTimer > 0) {
        p.facingAngle = attackDir > 0 ? 0 : Math.PI;
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
          const attackDir = this.getAttackDir(p.team);
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
          // Red AI dribbles toward target goal without pushing ball backward
          const attackDir = this.getAttackDir(p.team);
          const gx = attackDir * HALF_LENGTH - p.pos.x;
          const gz = -p.pos.z;
          const gd = Math.hypot(gx, gz) || 1;
          const gnx = gx / gd;
          const gnz = gz / gd;

          if (nx * attackDir < -0.15) {
            // Ball ended up behind Red player; guide it laterally around toward target goal
            const sideSign = nz >= 0 ? 1 : -1;
            const guideX = attackDir * 0.35;
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
          const enteredPosX = this.ballPos.x > 0;
          const scoringTeam: 0 | 1 =
            this.currentHalf === 1
              ? enteredPosX
                ? TEAM_BLUE
                : TEAM_RED
              : enteredPosX
                ? TEAM_RED
                : TEAM_BLUE;
          this.recordGoal(scoringTeam);
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

  private stepBallStep(dt: number, detectGoals: boolean): void {
    if (this.wasmEngine?.isReady) {
      this.wasmEngine.syncBallToWasm(
        this.ballPos,
        this.ballVel,
        this.ballSpinY,
        this.ballFreeTimer
      );
      const { result, ballSpinY } = this.wasmEngine.stepBallPhysics(
        dt,
        detectGoals,
        this.currentHalf,
        this.ballPos,
        this.ballVel
      );
      this.ballSpinY = ballSpinY;
      this.ballSphereMesh.rotation.z -= (this.ballVel.x * dt) / BALL_RADIUS;
      this.ballSphereMesh.rotation.x += (this.ballVel.z * dt) / BALL_RADIUS;
      if (result.postHit) {
        this.callbacks.onPostHit?.();
      }
      if (result.goalScoredTeam === 0 || result.goalScoredTeam === 1) {
        this.recordGoal(result.goalScoredTeam);
      }
      return;
    }
    this.updateBallPhysics(dt, detectGoals);
  }

  private recordGoal(scoringTeam: 0 | 1): void {
    if (scoringTeam === TEAM_BLUE) {
      this.blueScore += 1;
      this.statusText = 'GOL DO PRETO/BRANCO!';
    } else {
      this.redScore += 1;
      this.statusText = 'GOL DO VERDE/BRANCO!';
    }
    this.kickoffTeam = scoringTeam === TEAM_BLUE ? TEAM_RED : TEAM_BLUE;
    this.lastScorerTeam = scoringTeam;
    this.goalResetTimer = 2.6;
    this.callbacks.onGoal?.(scoringTeam);
    this.emitScore();
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

  private findPassTarget(
    passer: PlayerEntity,
    dirX: number,
    dirZ: number,
    hasDirectionalInput = false
  ): PlayerEntity | null {
    if (this.wasmEngine?.isReady) {
      const passerIdx = this.players.indexOf(passer);
      if (passerIdx !== -1) {
        this.wasmEngine.syncPlayersToWasm(this.players);
        const targetIdx = this.wasmEngine.findPassTarget(
          passerIdx,
          dirX,
          dirZ,
          hasDirectionalInput,
          this.currentHalf
        );
        return targetIdx >= 0 && targetIdx < this.players.length ? this.players[targetIdx] : null;
      }
    }

    let bestInCone: PlayerEntity | null = null;
    let bestScore = -Infinity;
    let closestMate: PlayerEntity | null = null;
    let closestDist = Infinity;
    const minAlign = hasDirectionalInput ? 0.15 : -0.10;

    for (const mate of this.players) {
      if (mate === passer || mate.team !== passer.team || mate.role === 'GK') continue;
      const dx = mate.pos.x - passer.pos.x;
      const dz = mate.pos.z - passer.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.04) continue;

      if (dist < closestDist) {
        closestDist = dist;
        closestMate = mate;
      }

      const align = (dx * dirX + dz * dirZ) / dist;
      if (align > minAlign) {
        const score = align * 0.85 - dist * 1.25;
        if (score > bestScore) {
          bestScore = score;
          bestInCone = mate;
        }
      }
    }
    return bestInCone ?? closestMate;
  }

  private clampPlayerToPitch(p: PlayerEntity): void {
    const pad = 0.01;
    p.pos.x = THREE.MathUtils.clamp(p.pos.x, -HALF_LENGTH - pad, HALF_LENGTH + pad);
    p.pos.z = THREE.MathUtils.clamp(p.pos.z, -HALF_WIDTH - pad, HALF_WIDTH + pad);
  }

  private syncPlayerMesh(p: PlayerEntity, dt = 0): void {
    p.mesh.position.set(p.pos.x, 0, p.pos.z);
    p.mesh.rotation.y = p.facingAngle;

    const speed = Math.hypot(p.vel.x, p.vel.z);

    if (p.mixer && p.actions && p.glbGroup) {
      let targetClip = 'idle';
      if (this.goalResetTimer > 0 && this.lastScorerTeam !== null) {
        targetClip = p.team === this.lastScorerTeam ? 'celebrate' : 'fall';
      } else if (p.diveTimer > 0) {
        targetClip = p.diveDir >= 0 ? 'diveRight' : 'diveLeft';
      } else if (p.tackleTimer > 0) {
        targetClip = 'slide';
      } else if (p.kickAnim > 0) {
        targetClip = 'shoot';
      } else if (speed > 0.22) {
        targetClip = 'sprint';
      } else if (speed > 0.08) {
        targetClip = this.controlledIndex === p.id ? 'dribble' : 'jog';
      } else if (speed > 0.015) {
        targetClip = 'jog';
      }

      if (!p.actions[targetClip]) {
        const found = Object.keys(p.actions).find((k) => k.toLowerCase() === targetClip.toLowerCase());
        if (found) {
          targetClip = found;
        } else {
          targetClip = p.actions.idle ? 'idle' : p.actions.Idle ? 'Idle' : Object.keys(p.actions)[0] ?? '';
        }
      }

      if (targetClip && p.activeActionName !== targetClip) {
        const prevAction = p.activeActionName ? p.actions[p.activeActionName] : undefined;
        const nextAction = p.actions[targetClip];
        if (nextAction) {
          nextAction.reset();
          nextAction.setEffectiveTimeScale(1);
          nextAction.setEffectiveWeight(1);
          nextAction.play();
          if (prevAction && prevAction !== nextAction) {
            prevAction.crossFadeTo(nextAction, 0.14, true);
          }
          p.activeActionName = targetClip;
        }
      }

      const activeAction = p.activeActionName ? p.actions[p.activeActionName] : undefined;
      if (activeAction) {
        const actName = (p.activeActionName ?? '').toLowerCase();
        if (actName.includes('sprint')) {
          activeAction.timeScale = THREE.MathUtils.clamp(speed / 0.28, 0.85, 1.4);
        } else if (actName.includes('jog') || actName.includes('run') || actName.includes('dribble') || actName.includes('walk')) {
          activeAction.timeScale = THREE.MathUtils.clamp(speed / 0.15, 0.8, 1.45);
        } else {
          activeAction.timeScale = 1.0;
        }
      }

      if (dt > 0) {
        p.mixer.update(dt);
      }

      p.glbGroup.position.y = 0;
      p.glbGroup.rotation.x = 0;
      p.glbGroup.rotation.z = 0;
      return;
    }

    if (p.diveTimer > 0) {
      const diveArc = Math.sin(THREE.MathUtils.clamp(p.diveTimer / 0.42, 0, 1) * Math.PI);
      p.bodyMesh.position.y = diveArc * 0.024;
      p.bodyMesh.rotation.x = this.getAttackDir(p.team) * p.diveDir * diveArc * 0.92;
      p.bodyMesh.rotation.y = 0;
      p.bodyMesh.rotation.z = 0;

      p.headGroup.rotation.y = 0;
      p.headGroup.rotation.z = 0.18;
      p.leftArm.rotation.z = 2.45;
      p.rightArm.rotation.z = 2.45;
      p.leftArm.rotation.x = 0.15;
      p.rightArm.rotation.x = -0.15;
      p.leftForearm.rotation.z = 0.22;
      p.rightForearm.rotation.z = 0.22;
      p.leftLeg.rotation.z = -0.25;
      p.rightLeg.rotation.z = -0.15;
      p.leftShin.rotation.z = -0.35;
      p.rightShin.rotation.z = -0.55;
    } else if (p.tackleTimer > 0) {
      p.bodyMesh.position.y = 0.002;
      p.bodyMesh.rotation.x = 0;
      p.bodyMesh.rotation.y = -0.18;
      p.bodyMesh.rotation.z = -0.82;

      p.headGroup.rotation.y = 0.18;
      p.headGroup.rotation.z = 0.35;
      p.rightLeg.rotation.z = 0.98;
      p.rightShin.rotation.z = -0.12;
      p.leftLeg.rotation.z = -0.35;
      p.leftShin.rotation.z = -1.05;
      p.leftArm.rotation.z = -0.55;
      p.rightArm.rotation.z = 0.65;
      p.leftArm.rotation.x = 0.14;
      p.rightArm.rotation.x = -0.14;
      p.leftForearm.rotation.z = 0.55;
      p.rightForearm.rotation.z = 0.72;
    } else {
      const runBlend = THREE.MathUtils.clamp(speed / 0.28, 0, 1);
      const bob = speed > 0.02 ? Math.abs(Math.sin(p.animPhase)) * 0.0032 : 0;
      p.bodyMesh.position.y = bob;
      p.bodyMesh.rotation.x = 0;

      const stride = Math.min(1, speed / 0.36) * 0.78;
      const swing = Math.sin(p.animPhase) * stride;
      const kickCurve = Math.sin(p.kickAnim * Math.PI);

      p.bodyMesh.rotation.z =
        p.kickAnim > 0 ? kickCurve * 0.22 : -Math.min(0.16, speed * 0.28);
      p.bodyMesh.rotation.y = p.kickAnim > 0 ? kickCurve * 0.24 : -swing * 0.16;
      p.headGroup.rotation.y = -p.bodyMesh.rotation.y * 0.85;
      p.headGroup.rotation.z = runBlend * 0.08;

      const recoveryWave = Math.sin(p.animPhase - 0.85);
      p.leftLeg.rotation.z = swing;
      p.leftShin.rotation.z = -Math.max(0.06, (0.5 - 0.5 * recoveryWave) * runBlend * 0.95);

      p.rightLeg.rotation.z = p.kickAnim > 0 ? kickCurve * 1.15 : -swing;
      p.rightShin.rotation.z =
        p.kickAnim > 0
          ? -Math.max(0.05, (1 - kickCurve) * 0.48)
          : -Math.max(0.06, (0.5 + 0.5 * recoveryWave) * runBlend * 0.95);

      p.leftArm.rotation.z = p.kickAnim > 0 ? -0.52 : -swing * 0.82;
      p.rightArm.rotation.z = p.kickAnim > 0 ? 0.62 : swing * 0.82;
      p.leftArm.rotation.x = 0.14;
      p.rightArm.rotation.x = -0.14;
      p.leftForearm.rotation.z =
        p.kickAnim > 0 ? 0.65 : 0.16 + runBlend * (0.42 + Math.max(0, -swing) * 0.45);
      p.rightForearm.rotation.z =
        p.kickAnim > 0 ? 0.45 : 0.16 + runBlend * (0.42 + Math.max(0, swing) * 0.45);
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

    const activeCharge = Math.max(this.kickCharge, this.passCharge);
    if (activeCharge > 0.02) {
      this.chargeBarBg.visible = true;
      this.chargeBarBg.position.set(active.pos.x, 0.126, active.pos.z);
      this.chargeBarBg.lookAt(cameraWorldPos);
      this.chargeBarFill.scale.x = Math.max(0.05, activeCharge);
      this.chargeBarFill.position.x = -0.016 * (1 - activeCharge);
      const fillMat = this.chargeBarFill.material as THREE.MeshBasicMaterial;
      fillMat.color.setHex(activeCharge > 0.75 ? 0xef4444 : activeCharge > 0.4 ? 0xfacc15 : 0x22c55e);
    } else {
      this.chargeBarBg.visible = false;
    }

    // Directional aim arrow & pass target ring when on the ball (or charging pass/shot)
    const distBall = Math.hypot(this.ballPos.x - active.pos.x, this.ballPos.z - active.pos.z);
    const showAim = !this.matchEnded && this.goalResetTimer <= 0 &&
      (distBall < PLAYER_RADIUS + BALL_RADIUS + 0.048 || activeCharge > 0.02);
    this.aimGuideGroup.visible = showAim;
    if (showAim) {
      this.aimGuideGroup.position.set(active.pos.x, 0, active.pos.z);
      this.aimGuideGroup.rotation.y = active.facingAngle;
      this.aimGuideMat.color.setHex(
        activeCharge > 0.75
          ? 0xef4444
          : activeCharge > 0.4
            ? 0xfacc15
            : activeCharge > 0.02
              ? 0x22c55e
              : 0x38bdf8
      );

      const dirX = Math.cos(active.facingAngle);
      const dirZ = -Math.sin(active.facingAngle);
      const passMate = this.findPassTarget(active, dirX, dirZ, false);
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

    const showSupportSpot =
      this.hasSupportSpot &&
      this.matchStarted &&
      !this.paused &&
      !this.waitingSecondHalf &&
      !this.matchEnded &&
      this.goalResetTimer <= 0;
    this.supportSpotRing.visible = showSupportSpot;
    if (showSupportSpot) {
      this.supportSpotRing.position.set(this.supportSpotPos.x, 0.0018, this.supportSpotPos.z);
      this.supportSpotRing.scale.setScalar(1 + Math.sin(elapsedTime * 5) * 0.06);
    }
  }

  private emitScore(): void {
    const mins = Math.floor(this.remainingSeconds / 60);
    const secs = Math.floor(this.remainingSeconds % 60);
    const timeText = `${this.currentHalf}ºT ${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    this.callbacks.onScoreChange?.(this.blueScore, this.redScore, timeText, this.statusText);
  }
}

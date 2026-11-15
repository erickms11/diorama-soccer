import type * as THREE from 'three';
import type { PlayerEntity, PlayerRole } from './entities';

export const WASM_NUM_PLAYERS = 16;
export const WASM_PLAYER_STRIDE = 12;

const ROLE_TO_CODE: Record<PlayerRole, number> = {
  GK: 0,
  DEF_L: 1,
  DEF_R: 2,
  MID_L: 3,
  MID_C: 4,
  MID_R: 5,
  FWD_L: 6,
  FWD_R: 7,
};

interface SoccerWasmExports {
  memory: WebAssembly.Memory;
  wasm_get_players_ptr: () => number;
  wasm_get_ball_ptr: () => number;
  wasm_find_pass_target: (
    passerIdx: number,
    dirX: number,
    dirZ: number,
    hasInput: number,
    currentHalf: number
  ) => number;
  wasm_step_tactical_ai: (
    dt: number,
    controlledIdx: number,
    redPresserIdx: number,
    currentHalf: number,
    rand01: number
  ) => void;
  wasm_resolve_player_collisions: () => void;
  wasm_step_ball_physics: (dt: number, detectGoals: number, currentHalf: number) => void;
}

export interface WasmAIKickEvent {
  shooterIdx: number;
  power: number;
  aimX: number;
  aimZ: number;
}

export interface WasmAIStepResult {
  aiKick: WasmAIKickEvent | null;
  supportSpotX: number;
  supportSpotZ: number;
}

export interface WasmBallStepResult {
  goalScoredTeam: -1 | 0 | 1;
}

/**
 * TypeScript bridge around the compiled C++ WebAssembly soccer simulation (`soccer_engine.wasm`).
 */
export class WasmSoccerEngine {
  public readonly isReady = true;

  private readonly exports: SoccerWasmExports;
  private readonly playersOffsetFloats: number;
  private readonly ballOffsetFloats: number;
  private f32View: Float32Array;

  private constructor(exports: SoccerWasmExports) {
    this.exports = exports;
    this.playersOffsetFloats = exports.wasm_get_players_ptr() >>> 2;
    this.ballOffsetFloats = exports.wasm_get_ball_ptr() >>> 2;
    this.f32View = new Float32Array(exports.memory.buffer);
  }

  public static async load(url = './soccer_engine.wasm'): Promise<WasmSoccerEngine> {
    const imports: WebAssembly.Imports = {
      env: {
        sinf: Math.sin,
        cosf: Math.cos,
        atan2f: Math.atan2,
      },
    };

    let result: WebAssembly.WebAssemblyInstantiatedSource;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Falha ao carregar ${url}: HTTP ${response.status}`);
    }

    if (typeof WebAssembly.instantiateStreaming === 'function') {
      try {
        result = await WebAssembly.instantiateStreaming(response.clone(), imports);
      } catch {
        const bytes = await response.arrayBuffer();
        result = await WebAssembly.instantiate(bytes, imports);
      }
    } else {
      const bytes = await response.arrayBuffer();
      result = await WebAssembly.instantiate(bytes, imports);
    }

    return new WasmSoccerEngine(result.instance.exports as unknown as SoccerWasmExports);
  }

  private view(): Float32Array {
    if (this.f32View.buffer !== this.exports.memory.buffer) {
      this.f32View = new Float32Array(this.exports.memory.buffer);
    }
    return this.f32View;
  }

  public syncBallToWasm(
    ballPos: THREE.Vector3,
    ballVel: THREE.Vector3,
    ballSpinY: number,
    ballFreeTimer: number
  ): void {
    const f32 = this.view();
    const b = this.ballOffsetFloats;
    f32[b + 0] = ballPos.x;
    f32[b + 1] = ballPos.y;
    f32[b + 2] = ballPos.z;
    f32[b + 3] = ballVel.x;
    f32[b + 4] = ballVel.y;
    f32[b + 5] = ballVel.z;
    f32[b + 6] = ballSpinY;
    f32[b + 7] = ballFreeTimer;
  }

  public syncPlayersToWasm(players: readonly PlayerEntity[]): void {
    const f32 = this.view();
    const count = Math.min(players.length, WASM_NUM_PLAYERS);
    for (let i = 0; i < count; i++) {
      const p = players[i];
      const base = this.playersOffsetFloats + i * WASM_PLAYER_STRIDE;
      f32[base + 0] = p.pos.x;
      f32[base + 1] = p.pos.z;
      f32[base + 2] = p.vel.x;
      f32[base + 3] = p.vel.z;
      f32[base + 4] = p.homePos.x;
      f32[base + 5] = p.homePos.z;
      f32[base + 6] = p.facingAngle;
      f32[base + 7] = p.kickCooldown;
      f32[base + 8] = p.diveTimer;
      f32[base + 9] = p.diveDir;
      f32[base + 10] = p.team;
      f32[base + 11] = ROLE_TO_CODE[p.role];
    }
  }

  public syncToWasm(
    players: readonly PlayerEntity[],
    ballPos: THREE.Vector3,
    ballVel: THREE.Vector3,
    ballSpinY: number,
    ballFreeTimer: number
  ): void {
    this.syncPlayersToWasm(players);
    this.syncBallToWasm(ballPos, ballVel, ballSpinY, ballFreeTimer);
  }

  public stepAIAndCollisions(
    dt: number,
    players: readonly PlayerEntity[],
    controlledIdx: number,
    redPresserIdx: number,
    currentHalf: 1 | 2,
    rand01: number
  ): WasmAIStepResult {
    this.exports.wasm_step_tactical_ai(dt, controlledIdx, redPresserIdx, currentHalf, rand01);
    this.exports.wasm_resolve_player_collisions();

    const f32 = this.view();
    const count = Math.min(players.length, WASM_NUM_PLAYERS);
    for (let i = 0; i < count; i++) {
      const p = players[i];
      const base = this.playersOffsetFloats + i * WASM_PLAYER_STRIDE;
      p.pos.x = f32[base + 0];
      p.pos.z = f32[base + 1];
      if (i !== controlledIdx) {
        p.vel.x = f32[base + 2];
        p.vel.z = f32[base + 3];
        p.facingAngle = f32[base + 6];
        p.kickCooldown = f32[base + 7];
        p.diveTimer = f32[base + 8];
        p.diveDir = f32[base + 9];
        const speed = Math.hypot(p.vel.x, p.vel.z);
        p.animPhase += speed * dt * 21;
      }
    }

    const b = this.ballOffsetFloats;
    let aiKick: WasmAIKickEvent | null = null;
    if (f32[b + 9] > 0.5) {
      const shooterIdx = Math.round(f32[b + 11]);
      if (shooterIdx >= 0 && shooterIdx < players.length) {
        aiKick = {
          shooterIdx,
          power: f32[b + 10],
          aimX: f32[b + 14],
          aimZ: f32[b + 15],
        };
      }
    }

    return {
      aiKick,
      supportSpotX: f32[b + 12],
      supportSpotZ: f32[b + 13],
    };
  }

  public stepBallPhysics(
    dt: number,
    detectGoals: boolean,
    currentHalf: 1 | 2,
    ballPos: THREE.Vector3,
    ballVel: THREE.Vector3
  ): { result: WasmBallStepResult; ballSpinY: number } {
    this.exports.wasm_step_ball_physics(dt, detectGoals ? 1 : 0, currentHalf);

    const f32 = this.view();
    const b = this.ballOffsetFloats;
    ballPos.set(f32[b + 0], f32[b + 1], f32[b + 2]);
    ballVel.set(f32[b + 3], f32[b + 4], f32[b + 5]);

    const rawGoal = Math.round(f32[b + 8]);
    const goalScoredTeam: -1 | 0 | 1 = rawGoal === 0 ? 0 : rawGoal === 1 ? 1 : -1;
    return {
      result: { goalScoredTeam },
      ballSpinY: f32[b + 6],
    };
  }

  public findPassTarget(
    passerIdx: number,
    dirX: number,
    dirZ: number,
    hasInput: boolean,
    currentHalf: 1 | 2
  ): number {
    return this.exports.wasm_find_pass_target(
      passerIdx,
      dirX,
      dirZ,
      hasInput ? 1 : 0,
      currentHalf
    );
  }
}

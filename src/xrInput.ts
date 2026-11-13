import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  DEFAULT_DIORAMA_POS,
  DEFAULT_DIORAMA_SCALE,
  MAX_DIORAMA_SCALE,
  MIN_DIORAMA_SCALE,
} from './constants';
import { MatchInputState } from './entities';
import { StadiumDiorama } from './stadium';

export type XRMode = 'desktop' | 'ar' | 'vr';

export interface XRStatusCallbacks {
  onModeChange?: (mode: XRMode) => void;
  onPlacementChange?: (isPlacing: boolean) => void;
  onStartRequested?: () => void;
  onResumeRequested?: () => void;
  onPauseRequested?: () => void;
  onPauseToggleRequested?: () => void;
  onResetRequested?: () => void;
  onScaleChange?: (scale: number) => void;
  onStatusMessage?: (msg: string) => void;
}

interface ControllerSlot {
  grip: THREE.Group;
  ray: THREE.Group;
  rayLine: THREE.Line;
  inputSource: XRInputSource | null;
  handedness: 'left' | 'right' | 'none';
  squeezing: boolean;
  selecting: boolean;
}

/**
 * Manages Meta Quest 3 WebXR sessions (AR Passthrough & VR), surface hit-test placement,
 * diorama grab/scale/rotate manipulation, camera-relative player movement, and desktop fallback.
 */
export class XRAndInputManager {
  public mode: XRMode = 'desktop';
  public placementMode = false;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly stadium: StadiumDiorama;
  private readonly callbacks: XRStatusCallbacks;

  private readonly orbitControls: OrbitControls;
  private readonly controllers: ControllerSlot[] = [];

  // Grab / drag state
  private activeGrabSlot: ControllerSlot | null = null;
  private grabOffset = new THREE.Vector3();
  private grabDistance = 0.85;

  public borderMenuVisible = false;

  // Edge-detection for discrete button presses
  private prevSwitchPressed = false;
  private prevPassPressed = false;
  private prevTacklePressed = false;
  private prevMenuPressed = false;
  private prevBorderClick = false;
  private waitForKickRelease = false;
  private waitForPassRelease = false;
  private suppressGameplayThisFrame = false;
  private readonly pointerNdc = new THREE.Vector2();
  private desktopPointerDownPos = { x: 0, y: 0 };

  // Desktop keyboard state
  private readonly keys = new Set<string>();
  private desktopSwitchQueued = false;
  private desktopPassQueued = false;
  private desktopTackleQueued = false;

  // Scratch math objects
  private readonly tempMatrix = new THREE.Matrix4();
  private readonly tempVecA = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    stadium: StadiumDiorama,
    callbacks: XRStatusCallbacks = {}
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.stadium = stadium;
    this.callbacks = callbacks;

    this.orbitControls = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbitControls.enableDamping = true;
    this.orbitControls.target.set(
      DEFAULT_DIORAMA_POS.x,
      DEFAULT_DIORAMA_POS.y + 0.06,
      DEFAULT_DIORAMA_POS.z
    );
    this.orbitControls.update();

    this.setupControllers();
    this.setupKeyboard();
    this.setupDesktopBorderClicks();
  }

  public setPlacementMode(active: boolean): void {
    this.placementMode = active;
    this.stadium.setPlacementMode(this.placementMode || this.borderMenuVisible);
    this.callbacks.onPlacementChange?.(active);
  }

  public setBorderMenuVisible(active: boolean): void {
    this.borderMenuVisible = active;
    this.stadium.setPlacementMode(this.placementMode || this.borderMenuVisible);
  }

  public adjustStadiumScale(factor: number): void {
    const nextScale = THREE.MathUtils.clamp(
      this.stadium.dioramaRoot.scale.x * factor,
      MIN_DIORAMA_SCALE,
      MAX_DIORAMA_SCALE
    );
    this.stadium.dioramaRoot.scale.setScalar(nextScale);
    this.callbacks.onScaleChange?.(nextScale);
  }

  private applyBorderAction(action: unknown): boolean {
    if (action === 'shrink') {
      this.adjustStadiumScale(0.88);
      this.pulseHaptics(0.3, 35);
      return true;
    }
    if (action === 'grow') {
      this.adjustStadiumScale(1.12);
      this.pulseHaptics(0.3, 35);
      return true;
    }
    if (action === 'resume') {
      if (this.callbacks.onResumeRequested) {
        this.callbacks.onResumeRequested();
      } else {
        this.callbacks.onStartRequested?.();
      }
      this.pulseHaptics(0.4, 45);
      return true;
    }
    return false;
  }

  private setupDesktopBorderClicks(): void {
    const dom = this.renderer.domElement;

    dom.addEventListener('pointerdown', (e) => {
      this.desktopPointerDownPos = { x: e.clientX, y: e.clientY };
    });

    dom.addEventListener('pointermove', (e) => {
      if (this.mode !== 'desktop' || (!this.borderMenuVisible && !this.placementMode)) {
        if (dom.style.cursor === 'pointer') {
          dom.style.cursor = '';
        }
        return;
      }
      const rect = dom.getBoundingClientRect();
      this.pointerNdc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      this.raycaster.setFromCamera(this.pointerNdc, this.camera);
      const hits = this.raycaster.intersectObjects(this.stadium.borderInteractables, false);
      dom.style.cursor = hits.length > 0 ? 'pointer' : '';
    });

    dom.addEventListener('click', (e) => {
      if (this.mode !== 'desktop' || (!this.borderMenuVisible && !this.placementMode)) return;
      const moveDist = Math.hypot(
        e.clientX - this.desktopPointerDownPos.x,
        e.clientY - this.desktopPointerDownPos.y
      );
      if (moveDist > 6) return;

      const rect = dom.getBoundingClientRect();
      this.pointerNdc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      this.raycaster.setFromCamera(this.pointerNdc, this.camera);
      const hits = this.raycaster.intersectObjects(this.stadium.borderInteractables, false);
      if (hits.length > 0) {
        this.applyBorderAction(hits[0].object.userData?.borderAction);
      }
    });
  }

  public async startSession(kind: 'ar' | 'vr'): Promise<void> {
    if (!('xr' in navigator) || !navigator.xr) {
      this.callbacks.onStatusMessage?.('WebXR não disponível neste navegador.');
      return;
    }

    const existingSession = this.renderer.xr.getSession();
    if (existingSession) {
      await existingSession.end().catch(() => {});
    }

    const sessionType: XRSessionMode = kind === 'ar' ? 'immersive-ar' : 'immersive-vr';
    const sessionInit: XRSessionInit = {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
    };

    let session: XRSession | null = null;
    try {
      session = await navigator.xr.requestSession(sessionType, sessionInit);
      const activeSession = session;

      activeSession.addEventListener('end', () => {
        this.activeGrabSlot = null;
        this.mode = 'desktop';
        this.setPlacementMode(false);
        this.orbitControls.enabled = true;
        this.renderer.setClearColor(0x0b1220, 1);
        this.scene.background = new THREE.Color(0x0b1220);
        this.callbacks.onModeChange?.('desktop');
      });

      activeSession.addEventListener('visibilitychange', () => {
        if (activeSession.visibilityState === 'visible-blurred') {
          this.callbacks.onPauseRequested?.();
        }
      });

      let tableY = DEFAULT_DIORAMA_POS.y;
      try {
        await activeSession.requestReferenceSpace('local-floor');
        this.renderer.xr.setReferenceSpaceType('local-floor');
      } catch {
        this.renderer.xr.setReferenceSpaceType('local');
        tableY = -0.35;
      }

      this.mode = kind;
      this.orbitControls.enabled = false;
      this.callbacks.onModeChange?.(kind);

      this.stadium.dioramaRoot.position.set(
        DEFAULT_DIORAMA_POS.x,
        tableY,
        DEFAULT_DIORAMA_POS.z
      );
      this.stadium.dioramaRoot.rotation.set(0, 0, 0);
      this.stadium.dioramaRoot.scale.setScalar(DEFAULT_DIORAMA_SCALE);
      this.setPlacementMode(false);

      if (kind === 'ar') {
        // Set transparent clear alpha BEFORE setSession so XRWebGLLayer composites Passthrough cleanly
        this.scene.background = null;
        this.renderer.setClearColor(0x000000, 0);
        this.callbacks.onStatusMessage?.(
          'Passthrough ativo! Clique e arraste o estádio onde quiser e aperte Iniciar.'
        );
      } else {
        this.renderer.setClearColor(0x0f172a, 1);
        this.scene.background = new THREE.Color(0x0f172a);
        this.callbacks.onStatusMessage?.(
          'Modo VR ativo! Clique e arraste o estádio onde quiser e aperte Iniciar.'
        );
      }

      await this.renderer.xr.setSession(activeSession);
    } catch (err) {
      if (session) {
        await session.end().catch(() => {});
      }
      const message = err instanceof Error ? err.message : String(err);
      this.callbacks.onStatusMessage?.(`Erro ao iniciar ${kind.toUpperCase()}: ${message}`);
    }
  }

  public pulseHaptics(intensity: number, durationMs: number): void {
    for (const slot of this.controllers) {
      const gp = slot.inputSource?.gamepad;
      if (!gp?.hapticActuators || gp.hapticActuators.length === 0) continue;
      const actuator = gp.hapticActuators[0] as GamepadHapticActuator & {
        pulse?: (value: number, duration: number) => Promise<boolean>;
      };
      if (typeof actuator.pulse === 'function') {
        actuator.pulse(THREE.MathUtils.clamp(intensity, 0, 1), durationMs).catch(() => {});
      }
    }
  }

  public getCameraWorldPosition(target: THREE.Vector3): THREE.Vector3 {
    if (this.mode !== 'desktop' && this.renderer.xr.isPresenting) {
      const xrCam = this.renderer.xr.getCamera();
      return target.setFromMatrixPosition(xrCam.matrixWorld);
    }
    return this.camera.getWorldPosition(target);
  }

  public update(dt: number, _frame?: XRFrame): MatchInputState {
    if (this.mode === 'desktop') {
      this.orbitControls.update();
      return this.readDesktopInput();
    }

    this.handleXRPlacementAndGrab(dt);
    return this.readXRGameplayInput();
  }

  private setupControllers(): void {
    for (let i = 0; i < 2; i++) {
      const ray = new THREE.Group();
      const grip = new THREE.Group();

      const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -2.5),
      ]);
      const lineMat = new THREE.LineBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.55,
      });
      const rayLine = new THREE.Line(lineGeo, lineMat);
      ray.add(rayLine);

      // Minimal controller marker sphere so user sees hand position in VR/AR
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.015, 10, 10),
        new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.4 })
      );
      grip.add(marker);

      const xrRay = this.renderer.xr.getController(i);
      const xrGrip = this.renderer.xr.getControllerGrip(i);
      xrRay.add(ray);
      xrGrip.add(grip);
      this.scene.add(xrRay);
      this.scene.add(xrGrip);

      const slot: ControllerSlot = {
        grip: xrGrip,
        ray: xrRay,
        rayLine,
        inputSource: null,
        handedness: 'none',
        squeezing: false,
        selecting: false,
      };

      xrRay.addEventListener('connected', (e: THREE.Event & { data?: XRInputSource }) => {
        if (e.data) {
          slot.inputSource = e.data;
          slot.handedness = e.data.handedness;
        }
      });
      xrRay.addEventListener('disconnected', () => {
        slot.inputSource = null;
        slot.handedness = 'none';
        slot.squeezing = false;
        slot.selecting = false;
      });
      xrRay.addEventListener('squeezestart', () => {
        slot.squeezing = true;
        this.beginGrab(slot);
      });
      xrRay.addEventListener('squeezeend', () => {
        slot.squeezing = false;
        if (this.activeGrabSlot === slot) {
          this.activeGrabSlot = null;
        }
      });
      xrRay.addEventListener('selectstart', () => {
        slot.selecting = true;
      });
      xrRay.addEventListener('selectend', () => {
        slot.selecting = false;
      });

      this.controllers.push(slot);
    }
  }

  private setupKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'KeyQ' && !e.repeat) {
        this.desktopSwitchQueued = true;
      }
      if ((e.code === 'KeyE' || e.code === 'KeyJ') && !e.repeat) {
        this.desktopPassQueued = true;
      }
      if ((e.code === 'KeyC' || e.code === 'KeyF') && !e.repeat) {
        this.desktopTackleQueued = true;
      }
      if (e.code === 'Enter' && !e.repeat) {
        this.callbacks.onStartRequested?.();
      }
      if (e.code === 'KeyP' && !e.repeat) {
        this.callbacks.onPauseToggleRequested?.();
      }
      if (e.code === 'KeyR' && !e.repeat) {
        this.callbacks.onResetRequested?.();
      }
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });
  }

  private getControllerRay(slot: ControllerSlot): void {
    this.tempMatrix.identity().extractRotation(slot.ray.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(slot.ray.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tempMatrix).normalize();
  }

  private getGamepad(hand: 'left' | 'right'): Gamepad | undefined {
    const slot = this.findController(hand);
    if (slot?.inputSource?.gamepad) {
      return slot.inputSource.gamepad;
    }
    const session = this.renderer.xr.getSession();
    if (session) {
      for (const source of session.inputSources) {
        if (source.handedness === hand && source.gamepad) {
          return source.gamepad;
        }
      }
    }
    return undefined;
  }

  private beginGrab(slot: ControllerSlot, hitDistance?: number): void {
    this.activeGrabSlot = slot;
    this.getControllerRay(slot);
    this.grabDistance =
      hitDistance !== undefined
        ? THREE.MathUtils.clamp(hitDistance, 0.25, 3.5)
        : THREE.MathUtils.clamp(
            this.raycaster.ray.origin.distanceTo(this.stadium.dioramaRoot.position),
            0.25,
            3.5
          );
    this.tempVecA
      .copy(this.raycaster.ray.origin)
      .addScaledVector(this.raycaster.ray.direction, this.grabDistance);
    this.grabOffset.copy(this.stadium.dioramaRoot.position).sub(this.tempVecA);
  }

  private handleXRPlacementAndGrab(dt: number): void {
    this.suppressGameplayThisFrame = false;

    const rightSlot = this.findController('right') ?? this.controllers[0];
    const leftSlot = this.findController('left') ?? this.controllers[1];
    const leftGp = this.getGamepad('left');
    const rightGp = this.getGamepad('right');

    // Toggle Pause Menu with Left Menu (2/6/7), Y (5), or Left Stick Click L3 (3)
    const menuPressed = Boolean(
      leftGp?.buttons[6]?.pressed ||
        leftGp?.buttons[2]?.pressed ||
        leftGp?.buttons[7]?.pressed ||
        leftGp?.buttons[5]?.pressed ||
        leftGp?.buttons[3]?.pressed
    );
    if (menuPressed && !this.prevMenuPressed) {
      if (this.placementMode) {
        this.setPlacementMode(false);
      } else {
        this.callbacks.onPauseToggleRequested?.();
      }
      this.suppressGameplayThisFrame = true;
    }
    this.prevMenuPressed = menuPressed;

    // Show ray lines during placement mode, Start/Pause border menu, or while dragging
    const showRay =
      this.placementMode || this.borderMenuVisible || this.activeGrabSlot !== null;
    for (const c of this.controllers) {
      c.rayLine.visible = showRay;
    }

    // Grab & drag diorama with Trigger or Grip until released
    if (this.activeGrabSlot) {
      const grabGp =
        this.activeGrabSlot.inputSource?.gamepad ??
        (this.activeGrabSlot.handedness === 'left' || this.activeGrabSlot.handedness === 'right'
          ? this.getGamepad(this.activeGrabSlot.handedness)
          : undefined);
      const stillHolding = Boolean(
        this.activeGrabSlot.squeezing ||
          this.activeGrabSlot.selecting ||
          grabGp?.buttons[0]?.pressed ||
          grabGp?.buttons[1]?.pressed
      );
      if (!stillHolding) {
        this.activeGrabSlot = null;
        this.prevBorderClick = false;
        return;
      }

      const stickGp =
        grabGp && grabGp.axes.length >= 2 ? grabGp : (rightGp ?? leftGp);
      if (stickGp) {
        let rx = 0;
        let ry = 0;
        if (stickGp.axes.length >= 4) {
          rx = Math.abs(stickGp.axes[2]) > 0.15 ? stickGp.axes[2] : 0;
          ry = Math.abs(stickGp.axes[3]) > 0.15 ? stickGp.axes[3] : 0;
        } else if (stickGp.axes.length >= 2) {
          rx = Math.abs(stickGp.axes[0]) > 0.15 ? stickGp.axes[0] : 0;
          ry = Math.abs(stickGp.axes[1]) > 0.15 ? stickGp.axes[1] : 0;
        }
        if (ry !== 0) {
          this.grabDistance = THREE.MathUtils.clamp(
            this.grabDistance - ry * dt * 0.85,
            0.25,
            3.5
          );
        }
        if (rx !== 0) {
          this.stadium.dioramaRoot.rotation.y -= rx * dt * 1.6;
        }
      }

      this.getControllerRay(this.activeGrabSlot);
      this.tempVecA
        .copy(this.raycaster.ray.origin)
        .addScaledVector(this.raycaster.ray.direction, this.grabDistance);
      this.stadium.dioramaRoot.position.copy(this.tempVecA).add(this.grabOffset);
      return;
    }

    // Click border buttons or click directly on stadium to drag when Start/Pause/Placement is visible
    const rightTriggerNow = Boolean(rightSlot?.selecting || rightGp?.buttons[0]?.pressed);
    const rightANow = Boolean(rightGp?.buttons[4]?.pressed);
    const leftTriggerNow = Boolean(leftSlot?.selecting || leftGp?.buttons[0]?.pressed);
    const borderClickNow = rightTriggerNow || rightANow || leftTriggerNow;
    const clickTriggerOnly = rightTriggerNow || leftTriggerNow;
    const clickSlot =
      leftTriggerNow && !rightTriggerNow && !rightANow ? leftSlot : rightSlot;

    if ((this.borderMenuVisible || this.placementMode) && clickSlot) {
      if (borderClickNow && !this.prevBorderClick) {
        this.getControllerRay(clickSlot);
        const borderHits = this.raycaster.intersectObjects(
          this.stadium.borderInteractables,
          false
        );
        if (
          borderHits.length > 0 &&
          this.applyBorderAction(borderHits[0].object.userData?.borderAction)
        ) {
          this.suppressGameplayThisFrame = true;
        } else if (clickTriggerOnly) {
          const stadiumHits = this.raycaster.intersectObject(
            this.stadium.dioramaRoot,
            true
          );
          if (stadiumHits.length > 0) {
            this.beginGrab(clickSlot, stadiumHits[0].distance);
            this.suppressGameplayThisFrame = true;
          }
        }
      }
      this.prevBorderClick = borderClickNow;
      return;
    }
    this.prevBorderClick = borderClickNow;
  }

  private readXRGameplayInput(): MatchInputState {
    const leftSlot = this.findController('left');
    const rightSlot = this.findController('right');
    const leftGp = this.getGamepad('left');
    const rightGp = this.getGamepad('right');

    const passNow = Boolean(rightGp?.buttons[4]?.pressed);
    const rawKickHeld = Boolean(rightGp?.buttons[5]?.pressed);
    const tackleNow = Boolean(leftGp?.buttons[4]?.pressed);
    const switchNow = Boolean(leftGp?.buttons[0]?.pressed || leftSlot?.selecting);

    if (
      this.placementMode ||
      this.borderMenuVisible ||
      this.activeGrabSlot ||
      this.suppressGameplayThisFrame
    ) {
      this.prevPassPressed = passNow;
      this.prevTacklePressed = tackleNow;
      this.prevSwitchPressed = switchNow;
      if (rawKickHeld) {
        this.waitForKickRelease = true;
      }
      if (passNow) {
        this.waitForPassRelease = true;
      }
      return {
        moveX: 0,
        moveZ: 0,
        sprint: false,
        kickHeld: false,
        passPressed: false,
        passHeld: false,
        tacklePressed: false,
        switchPressed: false,
      };
    }

    // Left thumbstick (Quest Touch Plus maps thumbstick to axes[2], axes[3])
    let rawX = 0;
    let rawY = 0;
    if (leftGp && leftGp.axes.length >= 4) {
      rawX = leftGp.axes[2];
      rawY = leftGp.axes[3];
    } else if (leftGp && leftGp.axes.length >= 2) {
      rawX = leftGp.axes[0];
      rawY = leftGp.axes[1];
    }

    if (Math.hypot(rawX, rawY) < 0.12) {
      rawX = 0;
      rawY = 0;
    }

    const { moveX, moveZ } = this.projectStickToFieldSpace(rawX, rawY);

    // Roubar a bola / Tocar: A Button on Right Controller (4) (segurar carrega força do passe)
    if (this.waitForPassRelease && !passNow) {
      this.waitForPassRelease = false;
    }
    const passHeld = this.waitForPassRelease ? false : passNow;
    const passPressed = passHeld && !this.prevPassPressed;
    this.prevPassPressed = passNow;

    // Chute no Gol: B Button on Right Controller (5)
    if (this.waitForKickRelease && !rawKickHeld) {
      this.waitForKickRelease = false;
    }
    const kickHeld = this.waitForKickRelease ? false : rawKickHeld;

    // Correr (Sprint): Right Trigger (0)
    const sprint = Boolean(rightGp?.buttons[0]?.pressed || rightSlot?.selecting);

    // Trocar de jogador: Left Trigger (0)
    const switchPressed = switchNow && !this.prevSwitchPressed;
    this.prevSwitchPressed = switchNow;

    // Carrinho: X Button on Left Controller (4)
    const tacklePressed = tackleNow && !this.prevTacklePressed;
    this.prevTacklePressed = tackleNow;

    return {
      moveX,
      moveZ,
      sprint,
      kickHeld,
      passPressed,
      passHeld,
      tacklePressed,
      switchPressed,
    };
  }

  private readDesktopInput(): MatchInputState {
    let rawX = 0;
    let rawY = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) rawX -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) rawX += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) rawY -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) rawY += 1;

    const len = Math.hypot(rawX, rawY);
    if (len > 1) {
      rawX /= len;
      rawY /= len;
    }

    const { moveX, moveZ } = this.projectStickToFieldSpace(rawX, rawY);
    const switchPressed = this.desktopSwitchQueued;
    const passPressed = this.desktopPassQueued;
    const tacklePressed = this.desktopTackleQueued;
    this.desktopSwitchQueued = false;
    this.desktopPassQueued = false;
    this.desktopTackleQueued = false;

    return {
      moveX,
      moveZ,
      sprint: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'),
      kickHeld: this.keys.has('Space'),
      passPressed,
      passHeld: this.keys.has('KeyE') || this.keys.has('KeyJ'),
      tacklePressed,
      switchPressed,
    };
  }

  /**
   * Maps stick input relative to the viewer-to-stadium direction (ignoring head rotation)
   * and transforms into `fieldRoot` local XZ so rotated/inverted stadiums never invert controls.
   */
  private projectStickToFieldSpace(rawX: number, rawY: number): { moveX: number; moveZ: number } {
    if (rawX === 0 && rawY === 0) return { moveX: 0, moveZ: 0 };

    const camPos = this.getCameraWorldPosition(this.tempVecA);
    const stadiumPos = this.stadium.dioramaRoot.position;
    let fx = stadiumPos.x - camPos.x;
    let fz = stadiumPos.z - camPos.z;
    const fLen = Math.hypot(fx, fz);
    if (fLen < 0.12) {
      fx = 0;
      fz = -1;
    } else {
      fx /= fLen;
      fz /= fLen;
    }

    // Viewer-right vector in horizontal XZ plane
    const rx = -fz;
    const rz = fx;

    const wx = fx * -rawY + rx * rawX;
    const wz = fz * -rawY + rz * rawX;

    // Transform world movement vector into stadium local XZ space
    const yaw = this.stadium.dioramaRoot.rotation.y;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    return {
      moveX: wx * cos - wz * sin,
      moveZ: wx * sin + wz * cos,
    };
  }

  private findController(hand: 'left' | 'right'): ControllerSlot | undefined {
    return this.controllers.find((c) => c.handedness === hand);
  }
}


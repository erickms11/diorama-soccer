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
  onPauseToggleRequested?: () => void;
  onResetRequested?: () => void;
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
  private readonly reticle: THREE.Mesh;

  private hitTestSource: XRHitTestSource | null = null;
  private hitTestRequested = false;

  // Grab / drag state
  private activeGrabSlot: ControllerSlot | null = null;
  private grabOffset = new THREE.Vector3();
  private grabStartYaw = 0;
  private grabStartControllerYaw = 0;

  // Edge-detection for discrete button presses
  private prevSwitchPressed = false;
  private prevPassPressed = false;
  private prevTacklePressed = false;
  private prevYPressed = false;
  private prevTriggerPlace = false;
  private waitForKickRelease = false;

  // Desktop keyboard state
  private readonly keys = new Set<string>();
  private desktopSwitchQueued = false;
  private desktopPassQueued = false;
  private desktopTackleQueued = false;

  // Scratch math objects
  private readonly tempMatrix = new THREE.Matrix4();
  private readonly tempVecA = new THREE.Vector3();
  private readonly tempVecB = new THREE.Vector3();
  private readonly tempQuat = new THREE.Quaternion();
  private readonly raycaster = new THREE.Raycaster();
  private readonly fallbackPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -DEFAULT_DIORAMA_POS.y);

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

    // Surface placement reticle
    this.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.06, 0.085, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x34d399, side: THREE.DoubleSide })
    );
    this.reticle.matrixAutoUpdate = false;
    this.reticle.visible = false;
    this.scene.add(this.reticle);

    this.setupControllers();
    this.setupKeyboard();
  }

  public setPlacementMode(active: boolean): void {
    this.placementMode = active;
    this.stadium.setPlacementMode(active);
    this.reticle.visible = active && this.mode === 'ar';
    this.callbacks.onPlacementChange?.(active);
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
    const sessionInit: XRSessionInit =
      kind === 'ar'
        ? {
            optionalFeatures: [
              'local-floor',
              'bounded-floor',
              'hit-test',
              'hand-tracking',
              'anchors',
            ],
          }
        : {
            optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
          };

    let session: XRSession | null = null;
    try {
      session = await navigator.xr.requestSession(sessionType, sessionInit);
      this.hitTestRequested = false;
      this.hitTestSource = null;

      session.addEventListener('end', () => {
        this.hitTestRequested = false;
        this.hitTestSource = null;
        this.activeGrabSlot = null;
        this.mode = 'desktop';
        this.setPlacementMode(false);
        this.orbitControls.enabled = true;
        this.renderer.setClearColor(0x0b1220, 1);
        this.scene.background = new THREE.Color(0x0b1220);
        this.callbacks.onModeChange?.('desktop');
      });

      let tableY = DEFAULT_DIORAMA_POS.y;
      try {
        await session.requestReferenceSpace('local-floor');
        this.renderer.xr.setReferenceSpaceType('local-floor');
      } catch {
        this.renderer.xr.setReferenceSpaceType('local');
        tableY = -0.35;
      }

      this.mode = kind;
      this.orbitControls.enabled = false;
      this.callbacks.onModeChange?.(kind);

      if (kind === 'ar') {
        // Set transparent clear alpha BEFORE setSession so XRWebGLLayer composites Passthrough cleanly
        this.scene.background = null;
        this.renderer.setClearColor(0x000000, 0);
        this.stadium.dioramaRoot.position.y = tableY;
        this.stadium.dioramaRoot.scale.setScalar(DEFAULT_DIORAMA_SCALE);
        this.setPlacementMode(true);
        this.callbacks.onStatusMessage?.(
          'Passthrough ativo! Aponte na mesa e aperte o Gatilho Direito para posicionar.'
        );
      } else {
        this.renderer.setClearColor(0x0f172a, 1);
        this.scene.background = new THREE.Color(0x0f172a);
        this.stadium.dioramaRoot.position.set(
          DEFAULT_DIORAMA_POS.x,
          tableY,
          DEFAULT_DIORAMA_POS.z
        );
        this.stadium.dioramaRoot.rotation.set(0, 0, 0);
        this.stadium.dioramaRoot.scale.setScalar(DEFAULT_DIORAMA_SCALE);
        this.setPlacementMode(false);
        this.callbacks.onStatusMessage?.('Modo VR ativo! Use os analógicos para jogar.');
      }

      await this.renderer.xr.setSession(session);
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

  public update(dt: number, frame?: XRFrame): MatchInputState {
    if (this.mode === 'desktop') {
      this.orbitControls.update();
      return this.readDesktopInput();
    }

    this.handleXRPlacementAndGrab(dt, frame);
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

  private beginGrab(slot: ControllerSlot): void {
    this.activeGrabSlot = slot;
    slot.grip.getWorldPosition(this.tempVecA);
    this.grabOffset.copy(this.stadium.dioramaRoot.position).sub(this.tempVecA);
    this.grabStartYaw = this.stadium.dioramaRoot.rotation.y;
    slot.grip.getWorldQuaternion(this.tempQuat);
    const euler = new THREE.Euler().setFromQuaternion(this.tempQuat, 'YXZ');
    this.grabStartControllerYaw = euler.y;
  }

  private handleXRPlacementAndGrab(dt: number, frame?: XRFrame): void {
    const rightSlot = this.findController('right') ?? this.controllers[0];
    const leftSlot = this.findController('left') ?? this.controllers[1];

    // Toggle placement mode with Y button (left controller index 5)
    const leftGp = leftSlot?.inputSource?.gamepad;
    const yPressed = Boolean(leftGp?.buttons[5]?.pressed);
    if (yPressed && !this.prevYPressed) {
      this.setPlacementMode(!this.placementMode);
    }
    this.prevYPressed = yPressed;

    // Show ray lines only during placement mode or when squeezing
    const showRay = this.placementMode || this.activeGrabSlot !== null;
    for (const c of this.controllers) {
      c.rayLine.visible = showRay;
    }

    // Grab & drag diorama when Grip (squeeze) is held
    if (this.activeGrabSlot) {
      this.activeGrabSlot.grip.getWorldPosition(this.tempVecA);
      this.stadium.dioramaRoot.position.copy(this.tempVecA).add(this.grabOffset);

      this.activeGrabSlot.grip.getWorldQuaternion(this.tempQuat);
      const euler = new THREE.Euler().setFromQuaternion(this.tempQuat, 'YXZ');
      const deltaYaw = euler.y - this.grabStartControllerYaw;
      this.stadium.dioramaRoot.rotation.y = this.grabStartYaw + deltaYaw;

      // Right thumbstick scales or fine-rotates while holding grip
      const rightGp = rightSlot?.inputSource?.gamepad;
      if (rightGp && rightGp.axes.length >= 4) {
        const rx = Math.abs(rightGp.axes[2]) > 0.15 ? rightGp.axes[2] : 0;
        const ry = Math.abs(rightGp.axes[3]) > 0.15 ? rightGp.axes[3] : 0;
        if (ry !== 0) {
          const nextScale = THREE.MathUtils.clamp(
            this.stadium.dioramaRoot.scale.x * (1 - ry * dt * 0.9),
            MIN_DIORAMA_SCALE,
            MAX_DIORAMA_SCALE
          );
          this.stadium.dioramaRoot.scale.setScalar(nextScale);
        }
        if (rx !== 0) {
          this.stadium.dioramaRoot.rotation.y -= rx * dt * 1.6;
        }
      }
      return;
    }

    if (!this.placementMode) {
      this.reticle.visible = false;
      return;
    }

    // Placement Mode: use WebXR hit-test if available, or ray-plane fallback
    let placedOnHit = false;
    const session = this.renderer.xr.getSession();

    if (frame && session && this.mode === 'ar') {
      if (!this.hitTestRequested) {
        this.hitTestRequested = true;
        session
          .requestReferenceSpace('viewer')
          .then((viewerSpace) => session.requestHitTestSource?.({ space: viewerSpace }))
          .then((source) => {
            if (source) this.hitTestSource = source;
          })
          .catch(() => {
            // Hit-test unavailable; fallback plane handles placement smoothly
          });
      }

      if (this.hitTestSource) {
        const refSpace = this.renderer.xr.getReferenceSpace();
        if (refSpace) {
          const results = frame.getHitTestResults(this.hitTestSource);
          if (results.length > 0) {
            const pose = results[0].getPose(refSpace);
            if (pose) {
              this.reticle.visible = true;
              this.reticle.matrix.fromArray(pose.transform.matrix);
              this.stadium.dioramaRoot.position.setFromMatrixPosition(this.reticle.matrix);
              placedOnHit = true;
            }
          }
        }
      }
    }

    if (!placedOnHit && rightSlot) {
      // Controller ray intersection against horizontal tabletop plane
      this.tempMatrix.identity().extractRotation(rightSlot.ray.matrixWorld);
      this.raycaster.ray.origin.setFromMatrixPosition(rightSlot.ray.matrixWorld);
      this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tempMatrix);

      this.fallbackPlane.constant = -this.stadium.dioramaRoot.position.y;
      if (this.raycaster.ray.intersectPlane(this.fallbackPlane, this.tempVecB)) {
        // Clamp distance so it doesn't shoot too far away
        const camPos = this.getCameraWorldPosition(this.tempVecA);
        if (this.tempVecB.distanceTo(camPos) < 3.5) {
          this.stadium.dioramaRoot.position.x = this.tempVecB.x;
          this.stadium.dioramaRoot.position.z = this.tempVecB.z;
          this.reticle.visible = true;
          this.reticle.matrix.makeTranslation(
            this.tempVecB.x,
            this.stadium.dioramaRoot.position.y,
            this.tempVecB.z
          );
        }
      }
    }

    // Allow manual height, rotation, and scale adjustment with right thumbstick during placement
    const rightGp = rightSlot?.inputSource?.gamepad;
    if (rightGp && rightGp.axes.length >= 4) {
      const rx = Math.abs(rightGp.axes[2]) > 0.15 ? rightGp.axes[2] : 0;
      const ry = Math.abs(rightGp.axes[3]) > 0.15 ? rightGp.axes[3] : 0;
      this.stadium.dioramaRoot.rotation.y -= rx * dt * 1.5;
      this.stadium.dioramaRoot.position.y = THREE.MathUtils.clamp(
        this.stadium.dioramaRoot.position.y - ry * dt * 0.45,
        0.0,
        1.5
      );
    }

    // Confirm placement on Right Trigger press
    const triggerDown = Boolean(rightSlot?.selecting || rightGp?.buttons[0]?.pressed);
    if (triggerDown && !this.prevTriggerPlace) {
      this.setPlacementMode(false);
      this.waitForKickRelease = true;
      this.pulseHaptics(0.45, 50);
    }
    this.prevTriggerPlace = triggerDown;
  }

  private readXRGameplayInput(): MatchInputState {
    if (this.placementMode || this.activeGrabSlot) {
      return {
        moveX: 0,
        moveZ: 0,
        sprint: false,
        kickHeld: false,
        passPressed: false,
        tacklePressed: false,
        switchPressed: false,
      };
    }

    const leftSlot = this.findController('left');
    const rightSlot = this.findController('right');
    const leftGp = leftSlot?.inputSource?.gamepad;
    const rightGp = rightSlot?.inputSource?.gamepad;

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

    // Shoot: Right Trigger (0)
    const rawKickHeld = Boolean(rightGp?.buttons[0]?.pressed || rightSlot?.selecting);
    if (this.waitForKickRelease && !rawKickHeld) {
      this.waitForKickRelease = false;
    }
    const kickHeld = this.waitForKickRelease ? false : rawKickHeld;

    // Dedicated Pass: A Button on Right Controller (4)
    const passNow = Boolean(rightGp?.buttons[4]?.pressed);
    const passPressed = passNow && !this.prevPassPressed;
    this.prevPassPressed = passNow;

    // Defensive Slide Tackle / Lunge: B Button on Right Controller (5)
    const tackleNow = Boolean(rightGp?.buttons[5]?.pressed);
    const tacklePressed = tackleNow && !this.prevTacklePressed;
    this.prevTacklePressed = tackleNow;

    // Sprint: Left Trigger (0) or Left Stick Click (3)
    const sprint = Boolean(leftGp?.buttons[0]?.pressed || leftGp?.buttons[3]?.pressed);

    // Switch player: X Button on Left Controller (4)
    const switchNow = Boolean(leftGp?.buttons[4]?.pressed);
    const switchPressed = switchNow && !this.prevSwitchPressed;
    this.prevSwitchPressed = switchNow;

    return { moveX, moveZ, sprint, kickHeld, passPressed, tacklePressed, switchPressed };
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
      tacklePressed,
      switchPressed,
    };
  }

  /**
   * Moss-style camera-relative movement:
   * Maps stick (rawX right/left, rawY down/up) relative to the viewer's current heading
   * projected onto the stadium's local horizontal XZ plane.
   */
  private projectStickToFieldSpace(rawX: number, rawY: number): { moveX: number; moveZ: number } {
    if (rawX === 0 && rawY === 0) return { moveX: 0, moveZ: 0 };

    const activeCam =
      this.mode !== 'desktop' && this.renderer.xr.isPresenting
        ? this.renderer.xr.getCamera()
        : this.camera;

    // Camera forward in world space (-Z of camera)
    activeCam.getWorldQuaternion(this.tempQuat);
    const worldForward = this.tempVecA.set(0, 0, -1).applyQuaternion(this.tempQuat);

    // Transform forward into fieldRoot's local coordinate system
    this.stadium.fieldRoot.updateMatrixWorld();
    const invFieldQuat = this.tempQuat.copy(this.stadium.fieldRoot.getWorldQuaternion(new THREE.Quaternion())).invert();
    const localForward = worldForward.applyQuaternion(invFieldQuat);
    localForward.y = 0;
    if (localForward.lengthSq() < 1e-5) {
      localForward.set(0, 0, -1);
    } else {
      localForward.normalize();
    }

    // Local right = forward x up (0, 1, 0)
    const localRight = this.tempVecB.set(-localForward.z, 0, localForward.x).normalize();

    // rawY < 0 means pushing stick forward/up
    const forwardAmount = -rawY;
    const moveX = localForward.x * forwardAmount + localRight.x * rawX;
    const moveZ = localForward.z * forwardAmount + localRight.z * rawX;

    return { moveX, moveZ };
  }

  private findController(hand: 'left' | 'right'): ControllerSlot | undefined {
    return this.controllers.find((c) => c.handedness === hand);
  }
}


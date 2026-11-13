import * as THREE from 'three';
import {
  BASE_DEPTH,
  BASE_WIDTH,
  FIELD_LENGTH,
  FIELD_WIDTH,
  GOAL_DEPTH,
  GOAL_HEIGHT,
  GOAL_POST_RADIUS,
  GOAL_WIDTH,
  HALF_LENGTH,
  HALF_WIDTH,
  PITCH_Y,
} from './constants';

interface CrowdFan {
  mesh: THREE.Mesh;
  baseY: number;
  phase: number;
}

/**
 * Builds and manages the tabletop 3D stadium diorama.
 * Moving, rotating, or scaling `dioramaRoot` transforms the entire stadium and match.
 */
export class StadiumDiorama {
  public readonly dioramaRoot: THREE.Group;
  public readonly fieldRoot: THREE.Group;
  public readonly borderInteractables: THREE.Object3D[] = [];

  private readonly placementOutline: THREE.Group;
  private readonly scoreboardCanvas: HTMLCanvasElement;
  private readonly scoreboardCtx: CanvasRenderingContext2D;
  private readonly scoreboardTexture: THREE.CanvasTexture;
  private readonly fans: CrowdFan[] = [];
  private readonly facadeLedMat: THREE.MeshStandardMaterial;
  private readonly adBoardMat: THREE.MeshStandardMaterial;

  private celebrationTimer = 0;
  private lastBlue = -1;
  private lastRed = -1;
  private lastTimeText = '';
  private lastStatusText = '';

  constructor() {
    this.dioramaRoot = new THREE.Group();
    this.fieldRoot = new THREE.Group();
    this.fieldRoot.position.y = PITCH_Y;
    this.dioramaRoot.add(this.fieldRoot);

    this.facadeLedMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0284c7,
      emissiveIntensity: 0.95,
      roughness: 0.25,
      metalness: 0.1,
    });
    this.adBoardMat = new THREE.MeshStandardMaterial({
      map: this.createAdBannerTexture(),
      emissive: 0xffffff,
      emissiveMap: undefined,
      emissiveIntensity: 0.18,
      roughness: 0.35,
    });
    this.adBoardMat.emissiveMap = this.adBoardMat.map;

    this.buildPedestal();
    this.buildPitch();
    this.buildBoundaryCushions();
    this.buildPitchsideDetails();
    this.buildGoal(-HALF_LENGTH, -1, 0x111827); // Black & White defends -X
    this.buildGoal(HALF_LENGTH, 1, 0x16a34a);   // Green & White defends +X
    this.buildStandsAndCrowd();
    this.buildFloodlights();

    this.scoreboardCanvas = document.createElement('canvas');
    this.scoreboardCanvas.width = 512;
    this.scoreboardCanvas.height = 192;
    const ctx = this.scoreboardCanvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not initialize 2D context for 3D scoreboard');
    }
    this.scoreboardCtx = ctx;
    this.scoreboardTexture = new THREE.CanvasTexture(this.scoreboardCanvas);
    this.scoreboardTexture.colorSpace = THREE.SRGBColorSpace;
    this.buildScoreboard();

    this.placementOutline = this.buildPlacementOutline();
    this.placementOutline.visible = false;
    this.dioramaRoot.add(this.placementOutline);

    this.updateScoreboard(0, 0, '03:00', '');
  }

  public setPlacementMode(active: boolean): void {
    this.placementOutline.visible = active;
  }

  public triggerGoalCelebration(duration = 2.6): void {
    this.celebrationTimer = duration;
  }

  public updateScoreboard(
    blueScore: number,
    redScore: number,
    timeText: string,
    statusText: string
  ): void {
    if (
      blueScore === this.lastBlue &&
      redScore === this.lastRed &&
      timeText === this.lastTimeText &&
      statusText === this.lastStatusText
    ) {
      return;
    }

    this.lastBlue = blueScore;
    this.lastRed = redScore;
    this.lastTimeText = timeText;
    this.lastStatusText = statusText;

    const ctx = this.scoreboardCtx;
    const w = this.scoreboardCanvas.width;
    const h = this.scoreboardCanvas.height;

    ctx.clearRect(0, 0, w, h);

    // Dark rounded backing
    ctx.fillStyle = '#0f172a';
    this.roundRect(ctx, 6, 6, w - 12, h - 12, 22);
    ctx.fill();

    ctx.lineWidth = 5;
    ctx.strokeStyle = statusText ? '#facc15' : '#334155';
    ctx.stroke();

    // Black & White badge
    ctx.fillStyle = '#111827';
    this.roundRect(ctx, 24, 28, 175, 86, 14);
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#f8fafc';
    ctx.stroke();

    // Green & White badge
    ctx.fillStyle = '#15803d';
    this.roundRect(ctx, w - 199, 28, 175, 86, 14);
    ctx.fill();
    ctx.strokeStyle = '#dcfce7';
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 18px system-ui, sans-serif';
    ctx.fillText('PRETO/BRANCO', 111, 52);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 46px system-ui, sans-serif';
    ctx.fillText(String(blueScore), 111, 88);

    ctx.fillStyle = '#dcfce7';
    ctx.font = 'bold 18px system-ui, sans-serif';
    ctx.fillText('VERDE/BRANCO', w - 111, 52);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 46px system-ui, sans-serif';
    ctx.fillText(String(redScore), w - 111, 88);

    // Timer in center
    ctx.fillStyle = '#facc15';
    ctx.font = 'bold 34px monospace';
    ctx.fillText(timeText, w / 2, 72);

    // Bottom status bar
    ctx.fillStyle = statusText ? '#facc15' : '#94a3b8';
    ctx.font = statusText ? 'bold 26px system-ui, sans-serif' : '600 20px system-ui, sans-serif';
    ctx.fillText(statusText || 'DIORAMA SOCCER 8x8', w / 2, 150);

    this.scoreboardTexture.needsUpdate = true;
  }

  public update(dt: number, elapsedTime: number): void {
    if (this.celebrationTimer > 0) {
      this.celebrationTimer = Math.max(0, this.celebrationTimer - dt);
      const intensity = Math.min(1, this.celebrationTimer);
      for (const fan of this.fans) {
        fan.mesh.position.y =
          fan.baseY + Math.abs(Math.sin(elapsedTime * 14 + fan.phase)) * 0.012 * intensity;
      }

      // Allianz-style goal celebration light show on exterior LEDs & perimeter ad boards
      const flash = 0.5 + 0.5 * Math.sin(elapsedTime * 16);
      this.facadeLedMat.color.setHex(flash > 0.5 ? 0xfacc15 : 0x22c55e);
      this.facadeLedMat.emissive.setHex(flash > 0.5 ? 0xeab308 : 0x16a34a);
      this.facadeLedMat.emissiveIntensity = 1.2 + flash * 0.9;
      this.adBoardMat.emissiveIntensity = 0.35 + flash * 0.45;
    } else {
      if (this.fans.length > 0 && this.fans[0].mesh.position.y !== this.fans[0].baseY) {
        for (const fan of this.fans) {
          fan.mesh.position.y = fan.baseY;
        }
      }
      // Subtle ambient breathing glow on exterior facade LEDs
      const breathe = 0.8 + Math.sin(elapsedTime * 1.8) * 0.18;
      this.facadeLedMat.color.setHex(0x38bdf8);
      this.facadeLedMat.emissive.setHex(0x0284c7);
      this.facadeLedMat.emissiveIntensity = breathe;
      this.adBoardMat.emissiveIntensity = 0.22;
    }
  }

  private createPlazaTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 768;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const w = canvas.width;
      const h = canvas.height;
      ctx.fillStyle = '#334155';
      ctx.fillRect(0, 0, w, h);

      // Stone paving grid
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.28)';
      ctx.lineWidth = 2;
      const step = 32;
      for (let x = 0; x <= w; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 0; y <= h; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Outer promenade border & 4 grand entrance red-carpet/slate walkways
      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 10;
      ctx.strokeRect(18, 18, w - 36, h - 36);

      ctx.fillStyle = '#475569';
      ctx.fillRect(w / 2 - 42, 0, 84, h);
      ctx.fillRect(0, h / 2 - 42, w, 84);

      // Landscaped outer green beds along the corners of the plaza
      ctx.fillStyle = '#14532d';
      const cornerSpots = [
        [24, 24, 150, 90],
        [w - 174, 24, 150, 90],
        [24, h - 114, 150, 90],
        [w - 174, h - 114, 150, 90],
      ];
      for (const [rx, ry, rw, rh] of cornerSpots) {
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 3;
        ctx.strokeRect(rx, ry, rw, rh);
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  private createAdBannerTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const panels = [
        { bg: '#0f172a', fg: '#facc15', text: 'DIORAMA CHAMPIONS ARENA' },
        { bg: '#15803d', fg: '#ffffff', text: 'XR STADIUM SERIES' },
        { bg: '#111827', fg: '#38bdf8', text: 'EURO CUP 8x8' },
        { bg: '#0284c7', fg: '#ffffff', text: 'MIXED REALITY LIVE' },
      ];
      const pw = canvas.width / panels.length;
      panels.forEach((p, idx) => {
        ctx.fillStyle = p.bg;
        ctx.fillRect(idx * pw, 0, pw, canvas.height);
        ctx.fillStyle = p.fg;
        ctx.font = 'bold 20px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.text, idx * pw + pw / 2, canvas.height / 2);
      });
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.set(3, 1);
    return tex;
  }

  private buildPedestal(): void {
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.72,
      metalness: 0.2,
    });
    const deckSideMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.65,
      metalness: 0.25,
    });
    const plazaTopMat = new THREE.MeshStandardMaterial({
      map: this.createPlazaTexture(),
      roughness: 0.85,
      metalness: 0.05,
    });

    // Lower architectural plinth resting cleanly on y = 0 (tabletop)
    const lowerGeo = new THREE.BoxGeometry(BASE_WIDTH, 0.025, BASE_DEPTH);
    const lowerMesh = new THREE.Mesh(lowerGeo, baseMat);
    lowerMesh.position.y = 0.0125;
    lowerMesh.receiveShadow = true;
    lowerMesh.castShadow = true;
    this.dioramaRoot.add(lowerMesh);

    // Upper stadium promenade deck up to PITCH_Y with paved top plaza surface
    const deckGeo = new THREE.BoxGeometry(BASE_WIDTH - 0.02, PITCH_Y - 0.025, BASE_DEPTH - 0.02);
    const deckMesh = new THREE.Mesh(deckGeo, [
      deckSideMat,
      deckSideMat,
      plazaTopMat,
      deckSideMat,
      deckSideMat,
      deckSideMat,
    ]);
    deckMesh.position.y = 0.025 + (PITCH_Y - 0.025) / 2;
    deckMesh.receiveShadow = true;
    this.dioramaRoot.add(deckMesh);

    // Pitch track & dark turf apron framing the field seamlessly into the stands
    const trackGeo = new THREE.BoxGeometry(FIELD_LENGTH + 0.14, 0.0015, FIELD_WIDTH + 0.14);
    const trackMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.9,
    });
    const track = new THREE.Mesh(trackGeo, trackMat);
    track.position.y = -0.0015;
    track.receiveShadow = true;
    this.fieldRoot.add(track);

    const apronGeo = new THREE.BoxGeometry(FIELD_LENGTH + 0.12, 0.002, FIELD_WIDTH + 0.12);
    const apronMat = new THREE.MeshStandardMaterial({
      color: 0x14532d,
      roughness: 0.92,
    });
    const apron = new THREE.Mesh(apronGeo, apronMat);
    apron.position.y = -0.001;
    apron.receiveShadow = true;
    this.fieldRoot.add(apron);

    // Exterior architectural plaza: 4 cardinal entrance staircases, 16 trees, and light bollards
    const stairMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.7 });
    const stairStepH = 0.012;
    const stairDepth = 0.018;

    // North & South exterior entrance stairs
    for (const zSign of [-1, 1]) {
      const baseZ = zSign * (BASE_DEPTH / 2 - 0.025);
      for (let s = 0; s < 3; s++) {
        const stair = new THREE.Mesh(
          new THREE.BoxGeometry(0.32, stairStepH * (3 - s), stairDepth),
          stairMat
        );
        stair.position.set(0, -PITCH_Y + 0.025 + (stairStepH * (3 - s)) / 2, baseZ + zSign * s * stairDepth);
        stair.receiveShadow = true;
        this.fieldRoot.add(stair);
      }
    }
    // East & West exterior entrance stairs
    for (const xSign of [-1, 1]) {
      const baseX = xSign * (BASE_WIDTH / 2 - 0.025);
      for (let s = 0; s < 3; s++) {
        const stair = new THREE.Mesh(
          new THREE.BoxGeometry(stairDepth, stairStepH * (3 - s), 0.28),
          stairMat
        );
        stair.position.set(baseX + xSign * s * stairDepth, -PITCH_Y + 0.025 + (stairStepH * (3 - s)) / 2, 0);
        stair.receiveShadow = true;
        this.fieldRoot.add(stair);
      }
    }

    // 16 miniature plaza trees & illuminated bollards around outer stadium concourse
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.85 });
    const leafMat1 = new THREE.MeshStandardMaterial({ color: 0x15803d, roughness: 0.8 });
    const leafMat2 = new THREE.MeshStandardMaterial({ color: 0x166534, roughness: 0.8 });
    const bollardBodyMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.4 });
    const bollardGlowMat = new THREE.MeshBasicMaterial({ color: 0xfef08a });

    const pz = BASE_DEPTH / 2 - 0.05;
    const px = BASE_WIDTH / 2 - 0.038;
    const treePositions: Array<[number, number]> = [
      [-px * 0.80, -pz], [-px * 0.40, -pz], [px * 0.40, -pz], [px * 0.80, -pz],
      [-px * 0.80, pz], [-px * 0.40, pz], [px * 0.40, pz], [px * 0.80, pz],
      [-px, -pz * 0.58], [-px, -pz * 0.26], [-px, pz * 0.26], [-px, pz * 0.58],
      [px, -pz * 0.58], [px, -pz * 0.26], [px, pz * 0.26], [px, pz * 0.58],
    ];

    treePositions.forEach(([tx, tz], idx) => {
      const tree = new THREE.Group();
      tree.position.set(tx, 0, tz);

      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.0055, 0.022, 6), trunkMat);
      trunk.position.y = 0.011;
      trunk.castShadow = true;
      tree.add(trunk);

      const crown1 = new THREE.Mesh(
        new THREE.SphereGeometry(0.017, 10, 8),
        idx % 2 === 0 ? leafMat1 : leafMat2
      );
      crown1.position.y = 0.029;
      crown1.castShadow = true;
      tree.add(crown1);

      const crown2 = new THREE.Mesh(
        new THREE.SphereGeometry(0.012, 8, 7),
        idx % 2 === 0 ? leafMat2 : leafMat1
      );
      crown2.position.set(0.004, 0.038, 0.003);
      tree.add(crown2);

      this.fieldRoot.add(tree);

      // Adjacent pedestrian plaza light bollard
      const bollard = new THREE.Group();
      bollard.position.set(tx * 0.985, 0, tz + (tz > 0 ? -0.028 : 0.028));
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.0022, 0.0026, 0.016, 6), bollardBodyMat);
      post.position.y = 0.008;
      bollard.add(post);
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.0024, 0.0024, 0.004, 6), bollardGlowMat);
      lamp.position.y = 0.016;
      bollard.add(lamp);
      this.fieldRoot.add(bollard);
    });
  }

  private buildPitchsideDetails(): void {
    const boardH = 0.015;
    const boardT = 0.006;

    // 1. Perimeter LED Advertising Boards (South continuous, North flanking dugouts, East/West outside goals)
    const southBoard = new THREE.Mesh(
      new THREE.BoxGeometry(FIELD_LENGTH + 0.02, boardH, boardT),
      this.adBoardMat
    );
    southBoard.position.set(0, boardH / 2, HALF_WIDTH + 0.036);
    this.fieldRoot.add(southBoard);

    const northSegLen = HALF_LENGTH - 0.42;
    for (const xSign of [-1, 1]) {
      const northSideBoard = new THREE.Mesh(
        new THREE.BoxGeometry(northSegLen, boardH, boardT),
        this.adBoardMat
      );
      northSideBoard.position.set(xSign * (0.42 + northSegLen / 2), boardH / 2, -(HALF_WIDTH + 0.036));
      this.fieldRoot.add(northSideBoard);
    }

    const endBoardLen = (FIELD_WIDTH - GOAL_WIDTH - 0.06) / 2;
    for (const xSign of [-1, 1]) {
      for (const zSign of [-1, 1]) {
        const endBoard = new THREE.Mesh(
          new THREE.BoxGeometry(boardT, boardH, endBoardLen),
          this.adBoardMat
        );
        endBoard.position.set(
          xSign * (HALF_LENGTH + 0.036),
          boardH / 2,
          zSign * (GOAL_WIDTH / 2 + 0.03 + endBoardLen / 2)
        );
        this.fieldRoot.add(endBoard);
      }
    }

    // 2. Team Dugouts / Technical Benches & Central Player Tunnel on North Apron
    const glassRoofMat = new THREE.MeshStandardMaterial({
      color: 0x93c5fd,
      transparent: true,
      opacity: 0.45,
      roughness: 0.15,
      metalness: 0.3,
    });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.4, metalness: 0.5 });

    for (const [idx, xSign] of ([-1, 1] as const).entries()) {
      const dugout = new THREE.Group();
      dugout.position.set(xSign * 0.22, 0, -(HALF_WIDTH + 0.048));

      const back = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.022, 0.004), glassRoofMat);
      back.position.set(0, 0.011, -0.011);
      dugout.add(back);

      const canopy = new THREE.Mesh(new THREE.BoxGeometry(0.145, 0.003, 0.026), glassRoofMat);
      canopy.position.set(0, 0.023, 0);
      canopy.rotation.x = 0.18;
      dugout.add(canopy);

      const benchBase = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.006, 0.014), frameMat);
      benchBase.position.set(0, 0.003, -0.002);
      dugout.add(benchBase);

      const seatMat = new THREE.MeshStandardMaterial({
        color: idx === 0 ? 0x111827 : 0x15803d,
        roughness: 0.5,
      });
      for (let s = -2; s <= 2; s++) {
        const seat = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.010, 0.010), seatMat);
        seat.position.set(s * 0.024, 0.010, -0.002);
        dugout.add(seat);
      }
      this.fieldRoot.add(dugout);
    }

    // Central Player Tunnel portal leading under the North Stand
    const tunnelFrame = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.028, 0.022), frameMat);
    tunnelFrame.position.set(0, 0.014, -(HALF_WIDTH + 0.058));
    this.fieldRoot.add(tunnelFrame);
    const tunnelVoid = new THREE.Mesh(
      new THREE.BoxGeometry(0.064, 0.022, 0.024),
      new THREE.MeshBasicMaterial({ color: 0x020617 })
    );
    tunnelVoid.position.set(0, 0.011, -(HALF_WIDTH + 0.058));
    this.fieldRoot.add(tunnelVoid);
  }

  private buildPitch(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 1288;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    // 1. Alternating mowed vertical grass stripes (rich stadium emerald)
    const stripes = 16;
    const stripeW = w / stripes;
    for (let i = 0; i < stripes; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#1e7e3e' : '#25964a';
      ctx.fillRect(i * stripeW, 0, stripeW + 1, h);
    }

    // Subtle horizontal cross-cut mowing bands for realistic checkerboard turf sheen
    const crossBands = 8;
    const bandH = h / crossBands;
    for (let j = 0; j < crossBands; j++) {
      ctx.fillStyle = j % 2 === 0 ? 'rgba(255, 255, 255, 0.03)' : 'rgba(0, 0, 0, 0.03)';
      ctx.fillRect(0, j * bandH, w, bandH + 1);
    }

    // 2. Fine procedural grass blade flecks & organic soil variation
    let seed = 1337;
    const rand = (): number => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    for (let i = 0; i < 18000; i++) {
      const gx = rand() * w;
      const gy = rand() * h;
      const bladeLen = 2 + rand() * 4;
      const angle = (rand() - 0.5) * 0.9;
      ctx.strokeStyle =
        rand() > 0.48 ? 'rgba(56, 189, 98, 0.16)' : 'rgba(13, 62, 30, 0.18)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.lineTo(gx + Math.cos(angle) * bladeLen, gy + Math.sin(angle) * bladeLen);
      ctx.stroke();
    }

    const pad = 28;
    const pw = w - pad * 2;
    const ph = h - pad * 2;

    // 3. Organic turf wear in high-traffic zones (goal mouths, penalty spots & center circle)
    const drawWear = (cx: number, cy: number, radius: number, alpha: number): void => {
      const grad = ctx.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius);
      grad.addColorStop(0, `rgba(140, 115, 65, ${alpha})`);
      grad.addColorStop(0.65, `rgba(110, 115, 60, ${alpha * 0.45})`);
      grad.addColorStop(1, 'rgba(110, 115, 60, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
    };

    drawWear(w / 2, h / 2, ph * 0.12, 0.14);
    drawWear(pad + pw * 0.03, h / 2, ph * 0.14, 0.20);
    drawWear(w - pad - pw * 0.03, h / 2, ph * 0.14, 0.20);
    drawWear(pad + pw * 0.105, h / 2, ph * 0.055, 0.16);
    drawWear(w - pad - pw * 0.105, h / 2, ph * 0.055, 0.16);

    // Subtle dark outer touchline vignette
    const vignette = ctx.createRadialGradient(w / 2, h / 2, ph * 0.45, w / 2, h / 2, w * 0.62);
    vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vignette.addColorStop(1, 'rgba(5, 25, 14, 0.24)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);

    // 4. Crisp official chalk pitch markings
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.90)';
    ctx.fillStyle = 'rgba(248, 250, 252, 0.90)';
    ctx.lineWidth = 8;

    // Outer boundary
    ctx.strokeRect(pad, pad, pw, ph);

    // Halfway line
    ctx.beginPath();
    ctx.moveTo(w / 2, pad);
    ctx.lineTo(w / 2, h - pad);
    ctx.stroke();

    // Center circle & spot
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, ph * 0.15, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 10, 0, Math.PI * 2);
    ctx.fill();

    // Penalty areas, 6-yard boxes, penalty spots & D-arcs ("meia-lua")
    const boxW = pw * 0.15;
    const boxH = ph * 0.50;
    const goalBoxW = pw * 0.055;
    const goalBoxH = ph * 0.26;
    const penOffset = pw * 0.105;
    const rArc = pw * 0.075;
    const thetaArc = Math.acos((boxW - penOffset) / rArc);

    // Left box & D-arc
    ctx.strokeRect(pad, (h - boxH) / 2, boxW, boxH);
    ctx.strokeRect(pad, (h - goalBoxH) / 2, goalBoxW, goalBoxH);
    ctx.beginPath();
    ctx.arc(pad + penOffset, h / 2, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(pad + penOffset, h / 2, rArc, -thetaArc, thetaArc);
    ctx.stroke();

    // Right box & D-arc
    ctx.strokeRect(w - pad - boxW, (h - boxH) / 2, boxW, boxH);
    ctx.strokeRect(w - pad - goalBoxW, (h - goalBoxH) / 2, goalBoxW, goalBoxH);
    ctx.beginPath();
    ctx.arc(w - pad - penOffset, h / 2, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(w - pad - penOffset, h / 2, rArc, Math.PI - thetaArc, Math.PI + thetaArc);
    ctx.stroke();

    // Corner arcs
    const rCorner = 36;
    const corners: Array<[number, number, number, number]> = [
      [pad, pad, 0, Math.PI / 2],
      [w - pad, pad, Math.PI / 2, Math.PI],
      [w - pad, h - pad, Math.PI, Math.PI * 1.5],
      [pad, h - pad, Math.PI * 1.5, Math.PI * 2],
    ];
    for (const [cx, cy, a0, a1] of corners) {
      ctx.beginPath();
      ctx.arc(cx, cy, rCorner, a0, a1);
      ctx.stroke();
    }

    // 5. Micro-turf bumpMap & roughnessMap (tiled 6x4 for fine grass blade detail under lights)
    const detailCanvas = document.createElement('canvas');
    detailCanvas.width = 512;
    detailCanvas.height = 322;
    const dCtx = detailCanvas.getContext('2d');
    if (dCtx) {
      dCtx.fillStyle = '#848484';
      dCtx.fillRect(0, 0, 512, 322);

      // Alternating stripe roughness modulation
      const subStripes = 4;
      const subW = 512 / subStripes;
      for (let s = 0; s < subStripes; s++) {
        dCtx.fillStyle = s % 2 === 0 ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';
        dCtx.fillRect(s * subW, 0, subW, 322);
      }

      for (let i = 0; i < 6500; i++) {
        const bx = rand() * 512;
        const by = rand() * 322;
        const lum = Math.floor(70 + rand() * 145);
        dCtx.fillStyle = `rgb(${lum},${lum},${lum})`;
        dCtx.fillRect(bx, by, 1.5, 2 + rand() * 2.5);
      }
    }

    const detailMap = new THREE.CanvasTexture(detailCanvas);
    detailMap.wrapS = THREE.RepeatWrapping;
    detailMap.wrapT = THREE.RepeatWrapping;
    detailMap.repeat.set(6, 4);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;

    const pitchGeo = new THREE.PlaneGeometry(FIELD_LENGTH + 0.04, FIELD_WIDTH + 0.04);
    const pitchMat = new THREE.MeshStandardMaterial({
      map: texture,
      bumpMap: detailMap,
      bumpScale: 0.0025,
      roughnessMap: detailMap,
      roughness: 0.88,
      metalness: 0.02,
    });
    const pitchMesh = new THREE.Mesh(pitchGeo, pitchMat);
    pitchMesh.rotation.x = -Math.PI / 2;
    pitchMesh.position.y = 0.0005;
    pitchMesh.receiveShadow = true;
    this.fieldRoot.add(pitchMesh);

    // 6. 3D corner flags at all 4 corners of the pitch
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.35 });
    const flagMat = new THREE.MeshStandardMaterial({
      color: 0xfacc15,
      emissive: 0x713f12,
      emissiveIntensity: 0.15,
      side: THREE.DoubleSide,
      roughness: 0.55,
    });
    const poleGeo = new THREE.CylinderGeometry(0.0018, 0.002, 0.042, 8);
    const flagGeo = new THREE.PlaneGeometry(0.014, 0.009);

    for (const xSign of [-1, 1]) {
      for (const zSign of [-1, 1]) {
        const cornerGroup = new THREE.Group();
        cornerGroup.position.set(xSign * HALF_LENGTH, 0, zSign * HALF_WIDTH);

        const pole = new THREE.Mesh(poleGeo, poleMat);
        pole.position.y = 0.021;
        pole.castShadow = true;
        cornerGroup.add(pole);

        const pennant = new THREE.Mesh(flagGeo, flagMat);
        pennant.position.set(-xSign * 0.007, 0.037, -zSign * 0.002);
        pennant.rotation.y = xSign * zSign * 0.35;
        cornerGroup.add(pennant);

        this.fieldRoot.add(cornerGroup);
      }
    }
  }

  private buildBoundaryCushions(): void {
    // Low translucent perimeter curb so the miniature ball stays inside the diorama nicely
    const curbMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.5,
      metalness: 0.2,
    });

    const curbH = 0.012;
    const curbT = 0.014;
    const sideLen = FIELD_LENGTH + 0.04;

    // North & South touchline curbs
    for (const sign of [-1, 1]) {
      const sideCurb = new THREE.Mesh(
        new THREE.BoxGeometry(sideLen, curbH, curbT),
        curbMat
      );
      sideCurb.position.set(0, curbH / 2, sign * (HALF_WIDTH + 0.02));
      sideCurb.receiveShadow = true;
      this.fieldRoot.add(sideCurb);
    }

    // Endline curbs outside the goal mouth
    const segmentLen = (FIELD_WIDTH + 0.04 - GOAL_WIDTH) / 2;
    for (const xSign of [-1, 1]) {
      for (const zSign of [-1, 1]) {
        const endCurb = new THREE.Mesh(
          new THREE.BoxGeometry(curbT, curbH, segmentLen),
          curbMat
        );
        endCurb.position.set(
          xSign * (HALF_LENGTH + 0.02),
          curbH / 2,
          zSign * (GOAL_WIDTH / 2 + segmentLen / 2)
        );
        this.fieldRoot.add(endCurb);
      }
    }
  }

  private buildGoal(xLine: number, dir: -1 | 1, accentHex: number): void {
    const goalGroup = new THREE.Group();
    goalGroup.position.set(xLine, 0, 0);

    const postMat = new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      roughness: 0.3,
      metalness: 0.25,
    });
    const accentMat = new THREE.MeshStandardMaterial({
      color: accentHex,
      roughness: 0.4,
      metalness: 0.2,
    });

    const postGeo = new THREE.CylinderGeometry(GOAL_POST_RADIUS, GOAL_POST_RADIUS, GOAL_HEIGHT, 12);
    const halfG = GOAL_WIDTH / 2;

    // Front posts
    for (const zSign of [-1, 1]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(0, GOAL_HEIGHT / 2, zSign * halfG);
      post.castShadow = true;
      goalGroup.add(post);

      // Back bottom bar
      const baseSide = new THREE.Mesh(
        new THREE.CylinderGeometry(GOAL_POST_RADIUS * 0.75, GOAL_POST_RADIUS * 0.75, GOAL_DEPTH, 10),
        accentMat
      );
      baseSide.rotation.z = Math.PI / 2;
      baseSide.position.set((dir * GOAL_DEPTH) / 2, GOAL_POST_RADIUS, zSign * halfG);
      goalGroup.add(baseSide);

      // Back top bar
      const topSide = baseSide.clone();
      topSide.position.y = GOAL_HEIGHT;
      goalGroup.add(topSide);

      // Back upright
      const backPost = new THREE.Mesh(postGeo, accentMat);
      backPost.position.set(dir * GOAL_DEPTH, GOAL_HEIGHT / 2, zSign * halfG);
      goalGroup.add(backPost);
    }

    // Front crossbar
    const crossbarGeo = new THREE.CylinderGeometry(
      GOAL_POST_RADIUS,
      GOAL_POST_RADIUS,
      GOAL_WIDTH + GOAL_POST_RADIUS * 2,
      12
    );
    const crossbar = new THREE.Mesh(crossbarGeo, postMat);
    crossbar.rotation.x = Math.PI / 2;
    crossbar.position.set(0, GOAL_HEIGHT, 0);
    crossbar.castShadow = true;
    goalGroup.add(crossbar);

    // Back top bar
    const backCross = crossbar.clone();
    backCross.material = accentMat;
    backCross.position.set(dir * GOAL_DEPTH, GOAL_HEIGHT, 0);
    goalGroup.add(backCross);

    // Netting (translucent mesh panels)
    const netMat = new THREE.MeshBasicMaterial({
      color: 0xe2e8f0,
      transparent: true,
      opacity: 0.28,
      wireframe: true,
      side: THREE.DoubleSide,
    });

    const backNet = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_WIDTH, GOAL_HEIGHT, 10, 5), netMat);
    backNet.rotation.y = Math.PI / 2;
    backNet.position.set(dir * GOAL_DEPTH, GOAL_HEIGHT / 2, 0);
    goalGroup.add(backNet);

    const roofNet = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_DEPTH, GOAL_WIDTH, 4, 10), netMat);
    roofNet.rotation.x = Math.PI / 2;
    roofNet.position.set((dir * GOAL_DEPTH) / 2, GOAL_HEIGHT, 0);
    goalGroup.add(roofNet);

    for (const zSign of [-1, 1]) {
      const sideNet = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_DEPTH, GOAL_HEIGHT, 4, 5), netMat);
      sideNet.position.set((dir * GOAL_DEPTH) / 2, GOAL_HEIGHT / 2, zSign * halfG);
      goalGroup.add(sideNet);
    }

    this.fieldRoot.add(goalGroup);
  }

  private buildStandsAndCrowd(): void {
    const concreteMat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      roughness: 0.85,
    });
    const seatRowMat = new THREE.MeshStandardMaterial({
      color: 0x475569,
      roughness: 0.72,
    });
    const aisleMat = new THREE.MeshStandardMaterial({
      color: 0xfacc15,
      roughness: 0.55,
    });
    const skyboxGlassMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      emissive: 0x0284c7,
      emissiveIntensity: 0.32,
      roughness: 0.12,
      metalness: 0.85,
    });
    const ribbonLedMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0ea5e9,
      emissiveIntensity: 1.0,
      roughness: 0.25,
    });
    const facadeMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.55,
      metalness: 0.45,
    });
    const louverMat = new THREE.MeshStandardMaterial({
      color: 0x64748b,
      roughness: 0.35,
      metalness: 0.65,
    });

    const crowdColors = [0x111827, 0xf8fafc, 0x16a34a, 0xe2e8f0, 0x15803d, 0xfacc15];
    const fanMats = crowdColors.map(
      (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.6 })
    );
    const fanGeo = new THREE.BoxGeometry(0.010, 0.014, 0.010);

    const tiers = 9; // 0..3 lower tier, 4 VIP skybox + LED ribbon, 5..8 upper tier
    const tierTopY = (t: number): number => {
      if (t <= 3) return (t + 1) * 0.017;
      if (t === 4) return 0.090;
      return 0.090 + (t - 4) * 0.022;
    };

    const sideDepth = 0.024;
    const sideStart = HALF_WIDTH + 0.070;
    const endDepth = 0.020;
    const endStart = HALF_LENGTH + 0.125;

    const sideLen = endStart * 2;
    const endLen = sideStart * 2;
    const wallH = 0.210;
    const sideWallDist = sideStart + tiers * sideDepth + 0.008;
    const endWallDist = endStart + tiers * endDepth + 0.008;

    // 1. North & South 2-Tier Stands + VIP Skybox + Yellow Aisles + Exterior Allianz Facade
    for (const zSign of [-1, 1]) {
      for (let t = 0; t < tiers; t++) {
        const h = tierTopY(t);
        const z = zSign * (sideStart + t * sideDepth + sideDepth / 2);

        if (t === 4) {
          const skybox = new THREE.Mesh(
            new THREE.BoxGeometry(sideLen, h, sideDepth),
            skyboxGlassMat
          );
          skybox.position.set(0, h / 2, z);
          skybox.receiveShadow = true;
          this.fieldRoot.add(skybox);

          const ribbon = new THREE.Mesh(
            new THREE.BoxGeometry(sideLen, 0.006, 0.004),
            ribbonLedMat
          );
          ribbon.position.set(0, h - 0.003, z - zSign * (sideDepth / 2 + 0.001));
          this.fieldRoot.add(ribbon);
          continue;
        }

        const step = new THREE.Mesh(
          new THREE.BoxGeometry(sideLen, h, sideDepth),
          t % 2 === 0 ? concreteMat : seatRowMat
        );
        step.position.set(0, h / 2, z);
        step.receiveShadow = true;
        step.castShadow = true;
        this.fieldRoot.add(step);

        const ledge = new THREE.Mesh(
          new THREE.BoxGeometry(sideLen, 0.004, sideDepth * 0.72),
          t % 2 === 0 ? seatRowMat : concreteMat
        );
        ledge.position.set(0, h + 0.002, z);
        this.fieldRoot.add(ledge);

        // Stepped yellow access aisles along North/South stands
        for (let a = -2; a <= 2; a++) {
          const aisle = new THREE.Mesh(
            new THREE.BoxGeometry(0.022, 0.005, sideDepth * 0.92),
            aisleMat
          );
          aisle.position.set(a * (sideLen * 0.19), h + 0.0025, z);
          this.fieldRoot.add(aisle);
        }

        const count = 48;
        for (let i = 0; i < count; i++) {
          if ((i + t) % 4 === 0) continue;
          const x = -sideLen / 2 + 0.05 + (i / (count - 1)) * (sideLen - 0.10);
          // Keep yellow aisles clear of fans
          if (Math.abs((Math.abs(x) % (sideLen * 0.19))) < 0.022) continue;
          const fan = new THREE.Mesh(fanGeo, fanMats[(i * 7 + t * 3) % fanMats.length]);
          const baseY = h + 0.010;
          fan.position.set(x, baseY, z);
          this.fieldRoot.add(fan);
          this.fans.push({ mesh: fan, baseY, phase: i * 0.7 + t });
        }
      }

      // Outer metallic Bernabéu/Allianz shell along North/South
      const backWall = new THREE.Mesh(
        new THREE.BoxGeometry(sideLen + 0.02, wallH, 0.016),
        facadeMat
      );
      backWall.position.set(0, wallH / 2, zSign * sideWallDist);
      backWall.castShadow = true;
      this.fieldRoot.add(backWall);

      // Horizontal titanium architectural louvers wrapping exterior facade
      for (const ly of [0.055, 0.105, 0.155, 0.195]) {
        const louver = new THREE.Mesh(
          new THREE.BoxGeometry(sideLen + 0.028, 0.006, 0.022),
          louverMat
        );
        louver.position.set(0, ly, zSign * (sideWallDist + 0.002));
        this.fieldRoot.add(louver);
      }

      // Illuminated Allianz-style exterior facade LED ribs
      const ribCount = 15;
      for (let r = 0; r < ribCount; r++) {
        const rx = -sideLen / 2 + 0.06 + (r / (ribCount - 1)) * (sideLen - 0.12);
        const rib = new THREE.Mesh(
          new THREE.BoxGeometry(0.016, wallH - 0.016, 0.014),
          this.facadeLedMat
        );
        rib.position.set(rx, wallH / 2, zSign * (sideWallDist + 0.009));
        rib.rotation.z = (r % 2 === 0 ? 1 : -1) * 0.12;
        this.fieldRoot.add(rib);
      }
    }

    // 2. East & West 2-Tier Stands + VIP Skybox + Yellow Aisles + Exterior Allianz Facade
    for (const xSign of [-1, 1]) {
      for (let t = 0; t < tiers; t++) {
        const h = tierTopY(t);
        const x = xSign * (endStart + t * endDepth + endDepth / 2);

        if (t === 4) {
          const skybox = new THREE.Mesh(
            new THREE.BoxGeometry(endDepth, h, endLen),
            skyboxGlassMat
          );
          skybox.position.set(x, h / 2, 0);
          skybox.receiveShadow = true;
          this.fieldRoot.add(skybox);

          const ribbon = new THREE.Mesh(
            new THREE.BoxGeometry(0.004, 0.006, endLen),
            ribbonLedMat
          );
          ribbon.position.set(x - xSign * (endDepth / 2 + 0.001), h - 0.003, 0);
          this.fieldRoot.add(ribbon);
          continue;
        }

        const step = new THREE.Mesh(
          new THREE.BoxGeometry(endDepth, h, endLen),
          t % 2 === 0 ? concreteMat : seatRowMat
        );
        step.position.set(x, h / 2, 0);
        step.receiveShadow = true;
        step.castShadow = true;
        this.fieldRoot.add(step);

        const ledge = new THREE.Mesh(
          new THREE.BoxGeometry(endDepth * 0.72, 0.004, endLen),
          t % 2 === 0 ? seatRowMat : concreteMat
        );
        ledge.position.set(x, h + 0.002, 0);
        this.fieldRoot.add(ledge);

        for (let a = -1; a <= 1; a++) {
          const aisle = new THREE.Mesh(
            new THREE.BoxGeometry(endDepth * 0.92, 0.005, 0.022),
            aisleMat
          );
          aisle.position.set(x, h + 0.0025, a * (endLen * 0.27));
          this.fieldRoot.add(aisle);
        }

        const count = 30;
        for (let i = 0; i < count; i++) {
          if ((i + t) % 3 === 0) continue;
          const z = -endLen / 2 + 0.05 + (i / (count - 1)) * (endLen - 0.10);
          const fan = new THREE.Mesh(fanGeo, fanMats[(i * 5 + t) % fanMats.length]);
          const baseY = h + 0.010;
          fan.position.set(x, baseY, z);
          this.fieldRoot.add(fan);
          this.fans.push({ mesh: fan, baseY, phase: i * 0.9 + t });
        }
      }

      const backWall = new THREE.Mesh(
        new THREE.BoxGeometry(0.016, wallH, endLen + 0.02),
        facadeMat
      );
      backWall.position.set(xSign * endWallDist, wallH / 2, 0);
      backWall.castShadow = true;
      this.fieldRoot.add(backWall);

      for (const ly of [0.055, 0.105, 0.155, 0.195]) {
        const louver = new THREE.Mesh(
          new THREE.BoxGeometry(0.022, 0.006, endLen + 0.028),
          louverMat
        );
        louver.position.set(xSign * (endWallDist + 0.002), ly, 0);
        this.fieldRoot.add(louver);
      }

      const ribCount = 9;
      for (let r = 0; r < ribCount; r++) {
        const rz = -endLen / 2 + 0.06 + (r / (ribCount - 1)) * (endLen - 0.12);
        const rib = new THREE.Mesh(
          new THREE.BoxGeometry(0.014, wallH - 0.016, 0.016),
          this.facadeLedMat
        );
        rib.position.set(xSign * (endWallDist + 0.009), wallH / 2, rz);
        rib.rotation.x = (r % 2 === 0 ? 1 : -1) * 0.12;
        this.fieldRoot.add(rib);
      }
    }

    // 3. 360-Degree Angled Corner Bowl Seating + Illuminated Architectural Corner Pylons
    const cornerInnerX = endStart;
    const cornerOuterX = endWallDist;
    const cornerInnerZ = sideStart;
    const cornerOuterZ = sideWallDist;
    const cornerW = cornerOuterX - cornerInnerX;
    const cornerD = cornerOuterZ - cornerInnerZ;
    const cornerMidX = (cornerInnerX + cornerOuterX) / 2;
    const cornerMidZ = (cornerInnerZ + cornerOuterZ) / 2;

    for (const xSign of [-1, 1]) {
      for (const zSign of [-1, 1]) {
        // Outer corner enclosure wall + glowing corner pylon
        const cornerBlock = new THREE.Mesh(
          new THREE.BoxGeometry(cornerW + 0.016, wallH, cornerD + 0.016),
          facadeMat
        );
        cornerBlock.position.set(xSign * cornerMidX, wallH / 2, zSign * cornerMidZ);
        cornerBlock.receiveShadow = true;
        cornerBlock.castShadow = true;
        this.fieldRoot.add(cornerBlock);

        // Stepped diagonal corner bowl tiers facing center of pitch
        const cornerPivot = new THREE.Group();
        cornerPivot.position.set(xSign * cornerInnerX, 0, zSign * cornerInnerZ);
        cornerPivot.lookAt(0, 0, 0);

        for (let t = 0; t < tiers; t++) {
          const h = tierTopY(t);
          const distBack = -t * 0.022 - 0.015;
          const benchW = Math.hypot(cornerW, cornerD) * (0.72 + t * 0.05);
          const mat = t === 4 ? skyboxGlassMat : t % 2 === 0 ? concreteMat : seatRowMat;
          const step = new THREE.Mesh(new THREE.BoxGeometry(benchW, h, 0.024), mat);
          step.position.set(0, h / 2, distBack);
          cornerPivot.add(step);

          if (t === 4) {
            const cRibbon = new THREE.Mesh(
              new THREE.BoxGeometry(benchW, 0.006, 0.004),
              ribbonLedMat
            );
            cRibbon.position.set(0, h - 0.003, distBack + 0.013);
            cornerPivot.add(cRibbon);
          } else {
            for (let f = -2; f <= 2; f++) {
              const fan = new THREE.Mesh(fanGeo, fanMats[(Math.abs(f) + t) % fanMats.length]);
              fan.position.set(f * (benchW * 0.16), h + 0.010, distBack);
              cornerPivot.add(fan);
            }
          }
        }
        this.fieldRoot.add(cornerPivot);

        // Tall illuminated Allianz/Bernabéu corner pylon at exterior edge
        const pylon = new THREE.Mesh(
          new THREE.CylinderGeometry(0.022, 0.026, wallH + 0.018, 12),
          louverMat
        );
        pylon.position.set(xSign * (cornerOuterX + 0.006), (wallH + 0.018) / 2, zSign * (cornerOuterZ + 0.006));
        pylon.castShadow = true;
        this.fieldRoot.add(pylon);

        const pylonLed = new THREE.Mesh(
          new THREE.CylinderGeometry(0.024, 0.024, wallH - 0.02, 12),
          this.facadeLedMat
        );
        pylonLed.position.set(xSign * (cornerOuterX + 0.006), wallH / 2, zSign * (cornerOuterZ + 0.006));
        this.fieldRoot.add(pylonLed);
      }
    }
  }

  private buildFloodlights(): void {
    const roofMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      roughness: 0.35,
      metalness: 0.45,
    });
    const trussMat = new THREE.MeshStandardMaterial({
      color: 0x64748b,
      roughness: 0.35,
      metalness: 0.7,
    });
    const ledRingMat = new THREE.MeshBasicMaterial({ color: 0xfef9c3 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.4 });

    const roofY = 0.222;
    const overhang = 0.11; // Covers upper rows only so pitch & lower tiers stay 100% open above
    const sideOuterZ = HALF_WIDTH + 0.070 + 9 * 0.024 + 0.016;
    const endOuterX = HALF_LENGTH + 0.125 + 9 * 0.020 + 0.016;
    const roofRimD = 0.135;

    // North & South cantilever roof canopies + radial steel roof trusses + inner LED floodlight lip
    for (const zSign of [-1, 1]) {
      const canopyZ = zSign * (sideOuterZ - roofRimD / 2);
      const canopy = new THREE.Mesh(
        new THREE.BoxGeometry(endOuterX * 2 + 0.02, 0.008, roofRimD),
        roofMat
      );
      canopy.position.set(0, roofY, canopyZ);
      canopy.rotation.x = zSign * 0.06;
      canopy.castShadow = true;
      this.fieldRoot.add(canopy);

      const ledLip = new THREE.Mesh(
        new THREE.BoxGeometry(endOuterX * 2 - 0.22, 0.006, 0.008),
        ledRingMat
      );
      ledLip.position.set(0, roofY - 0.006, zSign * (sideOuterZ - overhang));
      this.fieldRoot.add(ledLip);

      const trussCount = 11;
      for (let i = 0; i < trussCount; i++) {
        const tx = -endOuterX + 0.14 + (i / (trussCount - 1)) * (endOuterX * 2 - 0.28);
        const truss = new THREE.Mesh(
          new THREE.BoxGeometry(0.012, 0.014, roofRimD + 0.01),
          trussMat
        );
        truss.position.set(tx, roofY + 0.008, canopyZ);
        this.fieldRoot.add(truss);
      }
    }

    // East & West cantilever roof canopies + trusses + inner LED floodlight lip
    for (const xSign of [-1, 1]) {
      const canopyX = xSign * (endOuterX - roofRimD / 2);
      const spanZ = (sideOuterZ - roofRimD) * 2 + 0.02;
      const canopy = new THREE.Mesh(
        new THREE.BoxGeometry(roofRimD, 0.008, spanZ),
        roofMat
      );
      canopy.position.set(canopyX, roofY, 0);
      canopy.rotation.z = -xSign * 0.06;
      canopy.castShadow = true;
      this.fieldRoot.add(canopy);

      const ledLip = new THREE.Mesh(
        new THREE.BoxGeometry(0.008, 0.006, spanZ - 0.10),
        ledRingMat
      );
      ledLip.position.set(xSign * (endOuterX - overhang), roofY - 0.006, 0);
      this.fieldRoot.add(ledLip);

      const trussCount = 7;
      for (let i = 0; i < trussCount; i++) {
        const tz = -spanZ / 2 + 0.08 + (i / (trussCount - 1)) * (spanZ - 0.16);
        const truss = new THREE.Mesh(
          new THREE.BoxGeometry(roofRimD + 0.01, 0.014, 0.012),
          trussMat
        );
        truss.position.set(canopyX, roofY + 0.008, tz);
        this.fieldRoot.add(truss);
      }
    }

    // 4 architectural corner floodlight masts rising above roof canopy
    const poleHeight = 0.34;
    for (const xSign of [-1, 1]) {
      for (const zSign of [-1, 1]) {
        const tower = new THREE.Group();
        tower.position.set(xSign * (endOuterX - 0.03), 0, zSign * (sideOuterZ - 0.03));

        const pole = new THREE.Mesh(
          new THREE.CylinderGeometry(0.008, 0.012, poleHeight, 10),
          trussMat
        );
        pole.position.y = poleHeight / 2;
        tower.add(pole);

        const head = new THREE.Mesh(new THREE.BoxGeometry(0.060, 0.028, 0.018), headMat);
        head.position.y = poleHeight;
        head.lookAt(-xSign * 0.6, -0.25, -zSign * 0.6);
        tower.add(head);

        const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.052, 0.020), ledRingMat);
        glow.position.z = 0.0095;
        head.add(glow);

        this.fieldRoot.add(tower);
      }
    }
  }

  private buildScoreboard(): void {
    const wallTopY = 0.226;
    const wallZ = HALF_WIDTH + 0.070 + 9 * 0.024 - 0.02;

    const pillarMat = new THREE.MeshStandardMaterial({
      color: 0x64748b,
      metalness: 0.65,
      roughness: 0.35,
    });
    const casingMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      metalness: 0.35,
      roughness: 0.55,
    });
    const bezelMat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      metalness: 0.45,
      roughness: 0.4,
    });
    const screenMat = new THREE.MeshBasicMaterial({
      map: this.scoreboardTexture,
      transparent: true,
    });

    const pillarGeo = new THREE.CylinderGeometry(0.009, 0.011, 0.055, 10);
    const casingGeo = new THREE.BoxGeometry(0.50, 0.185, 0.024);
    const bezelGeo = new THREE.BoxGeometry(0.52, 0.20, 0.018);
    const hoodGeo = new THREE.BoxGeometry(0.525, 0.012, 0.042);
    const screenGeo = new THREE.PlaneGeometry(0.48, 0.168);

    // Mount physical scoreboard signs on top of both North and South grandstand roof rims
    for (const zSign of [-1, 1]) {
      const mount = new THREE.Group();
      mount.position.set(0, 0, zSign * wallZ);
      if (zSign === 1) {
        mount.rotation.y = Math.PI;
      }

      // Two steel support pillars anchored into the roof/wall rim
      for (const xPos of [-0.17, 0.17]) {
        const pillar = new THREE.Mesh(pillarGeo, pillarMat);
        pillar.position.set(xPos, wallTopY + 0.022, 0);
        pillar.castShadow = true;
        mount.add(pillar);
      }

      // Tilted scoreboard housing ("placa do estádio")
      const boardHead = new THREE.Group();
      boardHead.position.set(0, 0.315, 0);
      boardHead.rotation.x = 0.12;

      const casing = new THREE.Mesh(casingGeo, casingMat);
      casing.castShadow = true;
      boardHead.add(casing);

      const bezel = new THREE.Mesh(bezelGeo, bezelMat);
      boardHead.add(bezel);

      const hood = new THREE.Mesh(hoodGeo, bezelMat);
      hood.position.set(0, 0.10, 0.008);
      boardHead.add(hood);

      const innerScreen = new THREE.Mesh(screenGeo, screenMat);
      innerScreen.position.z = 0.013;
      boardHead.add(innerScreen);

      const outerScreen = new THREE.Mesh(screenGeo, screenMat);
      outerScreen.position.z = -0.013;
      outerScreen.rotation.y = Math.PI;
      boardHead.add(outerScreen);

      mount.add(boardHead);
      this.fieldRoot.add(mount);
    }
  }

  private createBorderButtonMesh(
    label: string,
    bgColor: string,
    strokeColor: string,
    textColor: string,
    action: 'shrink' | 'grow' | 'resume',
    width = 0.68,
    depth = 0.20
  ): THREE.Mesh {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 160;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = bgColor;
      this.roundRect(ctx, 6, 6, canvas.width - 12, canvas.height - 12, 26);
      ctx.fill();

      ctx.lineWidth = 8;
      ctx.strokeStyle = strokeColor;
      ctx.stroke();

      ctx.fillStyle = textColor;
      ctx.font = 'bold 42px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, canvas.width / 2, canvas.height / 2);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;

    const sideMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.45,
      metalness: 0.25,
    });
    const topMat = new THREE.MeshBasicMaterial({ map: tex });
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.016, depth),
      [sideMat, sideMat, topMat, sideMat, sideMat, sideMat]
    );
    mesh.userData.borderAction = action;
    return mesh;
  }

  private buildPlacementOutline(): THREE.Group {
    const group = new THREE.Group();
    const boxGeo = new THREE.BoxGeometry(BASE_WIDTH + 0.02, 0.008, BASE_DEPTH + 0.02);
    const edges = new THREE.EdgesGeometry(boxGeo);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x34d399 });
    const wire = new THREE.LineSegments(edges, lineMat);
    wire.position.y = 0.004;
    group.add(wire);

    // Subtle translucent green footprint pad on the tabletop
    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(BASE_WIDTH + 0.02, BASE_DEPTH + 0.02),
      new THREE.MeshBasicMaterial({
        color: 0x10b981,
        transparent: true,
        opacity: 0.14,
        side: THREE.DoubleSide,
      })
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = 0.001;
    group.add(pad);

    // Clickable glowing perimeter rails (clicking the stadium border shrinks it)
    const railMat = new THREE.MeshBasicMaterial({
      color: 0x34d399,
      transparent: true,
      opacity: 0.72,
    });
    const railThick = 0.055;
    const railH = 0.018;
    const halfW = BASE_WIDTH / 2 + 0.035;
    const halfD = BASE_DEPTH / 2 + 0.035;

    for (const zSign of [-1, 1]) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(BASE_WIDTH + railThick * 2, railH, railThick),
        railMat
      );
      rail.position.set(0, railH / 2, zSign * halfD);
      group.add(rail);
    }

    for (const xSign of [-1, 1]) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(railThick, railH, BASE_DEPTH),
        railMat
      );
      rail.position.set(xSign * halfW, railH / 2, 0);
      group.add(rail);
    }

    // Large labeled interactive border bars in front of the stadium (Shrink / Start-Resume / Grow)
    const borderButtons: Array<{
      label: string;
      bg: string;
      stroke: string;
      fg: string;
      action: 'shrink' | 'grow' | 'resume';
      x: number;
    }> = [
      {
        label: '- DIMINUIR ESTÁDIO',
        bg: '#7f1d1d',
        stroke: '#f87171',
        fg: '#fef2f2',
        action: 'shrink',
        x: -0.78,
      },
      {
        label: '▶ INICIAR / CONTINUAR',
        bg: '#14532d',
        stroke: '#4ade80',
        fg: '#f0fdf4',
        action: 'resume',
        x: 0,
      },
      {
        label: '+ AUMENTAR ESTÁDIO',
        bg: '#0c4a6e',
        stroke: '#38bdf8',
        fg: '#f0f9ff',
        action: 'grow',
        x: 0.78,
      },
    ];

    for (const b of borderButtons) {
      const btnMesh = this.createBorderButtonMesh(b.label, b.bg, b.stroke, b.fg, b.action);
      btnMesh.position.set(b.x, 0.036, halfD + 0.115);
      btnMesh.rotation.x = 0.24;
      group.add(btnMesh);
      this.borderInteractables.push(btnMesh);
    }

    return group;
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number
  ): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}


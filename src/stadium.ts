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

  private readonly placementOutline: THREE.Group;
  private readonly scoreboardCanvas: HTMLCanvasElement;
  private readonly scoreboardCtx: CanvasRenderingContext2D;
  private readonly scoreboardTexture: THREE.CanvasTexture;
  private readonly fans: CrowdFan[] = [];

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

    this.buildPedestal();
    this.buildPitch();
    this.buildBoundaryCushions();
    this.buildGoal(-HALF_LENGTH, -1, 0x3b82f6); // Blue defends -X
    this.buildGoal(HALF_LENGTH, 1, 0xef4444);   // Red defends +X
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

    // Blue badge
    ctx.fillStyle = '#1d4ed8';
    this.roundRect(ctx, 24, 28, 175, 86, 14);
    ctx.fill();

    // Red badge
    ctx.fillStyle = '#b91c1c';
    this.roundRect(ctx, w - 199, 28, 175, 86, 14);
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = '#dbeafe';
    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.fillText('AZUL', 111, 52);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 46px system-ui, sans-serif';
    ctx.fillText(String(blueScore), 111, 88);

    ctx.fillStyle = '#fee2e2';
    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.fillText('VERMELHO', w - 111, 52);

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
    ctx.fillText(statusText || 'DIORAMA SOCCER 5x5', w / 2, 150);

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
    } else if (this.fans.length > 0 && this.fans[0].mesh.position.y !== this.fans[0].baseY) {
      for (const fan of this.fans) {
        fan.mesh.position.y = fan.baseY;
      }
    }
  }

  private buildPedestal(): void {
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.75,
      metalness: 0.15,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      roughness: 0.5,
      metalness: 0.3,
    });

    // Lower plinth resting cleanly on y = 0 (tabletop)
    const lowerGeo = new THREE.BoxGeometry(BASE_WIDTH, 0.025, BASE_DEPTH);
    const lowerMesh = new THREE.Mesh(lowerGeo, baseMat);
    lowerMesh.position.y = 0.0125;
    lowerMesh.receiveShadow = true;
    lowerMesh.castShadow = true;
    this.dioramaRoot.add(lowerMesh);

    // Upper stadium deck up to PITCH_Y
    const deckGeo = new THREE.BoxGeometry(BASE_WIDTH - 0.03, PITCH_Y - 0.025, BASE_DEPTH - 0.03);
    const deckMesh = new THREE.Mesh(deckGeo, trimMat);
    deckMesh.position.y = 0.025 + (PITCH_Y - 0.025) / 2;
    deckMesh.receiveShadow = true;
    this.dioramaRoot.add(deckMesh);

    // Pitch apron (dark turf border around the white lines)
    const apronGeo = new THREE.BoxGeometry(FIELD_LENGTH + 0.1, 0.002, FIELD_WIDTH + 0.1);
    const apronMat = new THREE.MeshStandardMaterial({
      color: 0x14532d,
      roughness: 0.9,
    });
    const apron = new THREE.Mesh(apronGeo, apronMat);
    apron.position.y = -0.001;
    apron.receiveShadow = true;
    this.fieldRoot.add(apron);
  }

  private buildPitch(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 672;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    // Alternating mowed grass stripes
    const stripes = 10;
    const stripeW = w / stripes;
    for (let i = 0; i < stripes; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#1f8a42' : '#24994b';
      ctx.fillRect(i * stripeW, 0, stripeW + 1, h);
    }

    // White pitch markings
    const pad = 26;
    const pw = w - pad * 2;
    const ph = h - pad * 2;

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.lineWidth = 6;

    // Outer boundary
    ctx.strokeRect(pad, pad, pw, ph);

    // Halfway line
    ctx.beginPath();
    ctx.moveTo(w / 2, pad);
    ctx.lineTo(w / 2, h - pad);
    ctx.stroke();

    // Center circle & spot
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, ph * 0.17, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 7, 0, Math.PI * 2);
    ctx.fill();

    // Penalty areas (left & right)
    const boxW = pw * 0.16;
    const boxH = ph * 0.56;
    const goalBoxW = pw * 0.065;
    const goalBoxH = ph * 0.30;

    // Left box
    ctx.strokeRect(pad, (h - boxH) / 2, boxW, boxH);
    ctx.strokeRect(pad, (h - goalBoxH) / 2, goalBoxW, goalBoxH);
    ctx.beginPath();
    ctx.arc(pad + pw * 0.115, h / 2, 6, 0, Math.PI * 2);
    ctx.fill();

    // Right box
    ctx.strokeRect(w - pad - boxW, (h - boxH) / 2, boxW, boxH);
    ctx.strokeRect(w - pad - goalBoxW, (h - goalBoxH) / 2, goalBoxW, goalBoxH);
    ctx.beginPath();
    ctx.arc(w - pad - pw * 0.115, h / 2, 6, 0, Math.PI * 2);
    ctx.fill();

    // Corner arcs
    const rCorner = 24;
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

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;

    const pitchGeo = new THREE.PlaneGeometry(FIELD_LENGTH + 0.04, FIELD_WIDTH + 0.04);
    const pitchMat = new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.85,
      metalness: 0.02,
    });
    const pitchMesh = new THREE.Mesh(pitchGeo, pitchMat);
    pitchMesh.rotation.x = -Math.PI / 2;
    pitchMesh.position.y = 0.0005;
    pitchMesh.receiveShadow = true;
    this.fieldRoot.add(pitchMesh);
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
      roughness: 0.75,
    });
    const facadeMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.7,
      metalness: 0.2,
    });
    const ribMat = new THREE.MeshStandardMaterial({
      color: 0x64748b,
      roughness: 0.5,
      metalness: 0.35,
    });

    const crowdColors = [0x3b82f6, 0xef4444, 0xfacc15, 0xf8fafc, 0x22c55e, 0xf97316];
    const fanGeo = new THREE.BoxGeometry(0.011, 0.014, 0.011);

    const stepH = 0.021;
    const sideTiers = 7;
    const sideDepth = 0.028;
    const sideStart = HALF_WIDTH + 0.045;
    const sideLen = FIELD_LENGTH + 0.12;

    // North & South grandstands along X (7 tiers)
    for (const zSign of [-1, 1]) {
      for (let t = 0; t < sideTiers; t++) {
        const h = (t + 1) * stepH;
        const z = zSign * (sideStart + t * sideDepth + sideDepth / 2);
        const step = new THREE.Mesh(
          new THREE.BoxGeometry(sideLen, h, sideDepth),
          t % 2 === 0 ? concreteMat : seatRowMat
        );
        step.position.set(0, h / 2, z);
        step.receiveShadow = true;
        step.castShadow = true;
        this.fieldRoot.add(step);

        // Seat ledge accent
        const ledge = new THREE.Mesh(
          new THREE.BoxGeometry(sideLen, 0.004, sideDepth * 0.75),
          t % 2 === 0 ? seatRowMat : concreteMat
        );
        ledge.position.set(0, h + 0.002, z);
        this.fieldRoot.add(ledge);

        // Populate lively crowd blocks
        const count = 34;
        for (let i = 0; i < count; i++) {
          if ((i + t) % 4 === 0) continue;
          const fanMat = new THREE.MeshStandardMaterial({
            color: crowdColors[(i * 7 + t * 3) % crowdColors.length],
            roughness: 0.6,
          });
          const fan = new THREE.Mesh(fanGeo, fanMat);
          const x = -sideLen / 2 + 0.05 + (i / (count - 1)) * (sideLen - 0.10);
          const baseY = h + 0.010;
          fan.position.set(x, baseY, z);
          this.fieldRoot.add(fan);
          this.fans.push({ mesh: fan, baseY, phase: i * 0.7 + t });
        }
      }

      // Outer back wall / stadium facade + architectural ribs
      const wallH = sideTiers * stepH + 0.022;
      const wallZ = zSign * (sideStart + sideTiers * sideDepth + 0.007);
      const backWall = new THREE.Mesh(
        new THREE.BoxGeometry(sideLen + 0.02, wallH, 0.014),
        facadeMat
      );
      backWall.position.set(0, wallH / 2, wallZ);
      backWall.castShadow = true;
      this.fieldRoot.add(backWall);

      const ribCount = 9;
      for (let r = 0; r < ribCount; r++) {
        const rx = -sideLen / 2 + 0.06 + (r / (ribCount - 1)) * (sideLen - 0.12);
        const rib = new THREE.Mesh(new THREE.BoxGeometry(0.018, wallH + 0.008, 0.022), ribMat);
        rib.position.set(rx, (wallH + 0.008) / 2, wallZ);
        this.fieldRoot.add(rib);
      }
    }

    // East & West grandstands behind goals (6 tiers)
    const endTiers = 6;
    const endDepth = 0.025;
    const endStart = HALF_LENGTH + 0.095;
    const endLen = FIELD_WIDTH + 0.09;

    for (const xSign of [-1, 1]) {
      for (let t = 0; t < endTiers; t++) {
        const h = (t + 1) * stepH;
        const x = xSign * (endStart + t * endDepth + endDepth / 2);
        const step = new THREE.Mesh(
          new THREE.BoxGeometry(endDepth, h, endLen),
          t % 2 === 0 ? concreteMat : seatRowMat
        );
        step.position.set(x, h / 2, 0);
        step.receiveShadow = true;
        step.castShadow = true;
        this.fieldRoot.add(step);

        const ledge = new THREE.Mesh(
          new THREE.BoxGeometry(endDepth * 0.75, 0.004, endLen),
          t % 2 === 0 ? seatRowMat : concreteMat
        );
        ledge.position.set(x, h + 0.002, 0);
        this.fieldRoot.add(ledge);

        const count = 22;
        for (let i = 0; i < count; i++) {
          if ((i + t) % 3 === 0) continue;
          const fanMat = new THREE.MeshStandardMaterial({
            color: crowdColors[(i * 5 + t) % crowdColors.length],
            roughness: 0.6,
          });
          const fan = new THREE.Mesh(fanGeo, fanMat);
          const z = -endLen / 2 + 0.05 + (i / (count - 1)) * (endLen - 0.10);
          const baseY = h + 0.010;
          fan.position.set(x, baseY, z);
          this.fieldRoot.add(fan);
          this.fans.push({ mesh: fan, baseY, phase: i * 0.9 + t });
        }
      }

      // Outer back wall & support ribs behind goals
      const wallH = endTiers * stepH + 0.022;
      const wallX = xSign * (endStart + endTiers * endDepth + 0.007);
      const backWall = new THREE.Mesh(
        new THREE.BoxGeometry(0.014, wallH, endLen + 0.02),
        facadeMat
      );
      backWall.position.set(wallX, wallH / 2, 0);
      backWall.castShadow = true;
      this.fieldRoot.add(backWall);

      const ribCount = 6;
      for (let r = 0; r < ribCount; r++) {
        const rz = -endLen / 2 + 0.06 + (r / (ribCount - 1)) * (endLen - 0.12);
        const rib = new THREE.Mesh(new THREE.BoxGeometry(0.022, wallH + 0.008, 0.018), ribMat);
        rib.position.set(wallX, (wallH + 0.008) / 2, rz);
        this.fieldRoot.add(rib);
      }
    }

    // Unified corner bowl connectors closing the 4 corners of the stadium
    const cornerInnerX = endStart;
    const cornerOuterX = endStart + endTiers * endDepth + 0.014;
    const cornerInnerZ = sideStart;
    const cornerOuterZ = sideStart + sideTiers * sideDepth + 0.014;
    const cornerW = cornerOuterX - cornerInnerX;
    const cornerD = cornerOuterZ - cornerInnerZ;
    const cornerMidX = (cornerInnerX + cornerOuterX) / 2;
    const cornerMidZ = (cornerInnerZ + cornerOuterZ) / 2;
    const cornerBaseH = endTiers * stepH;

    for (const xSign of [-1, 1]) {
      for (const zSign of [-1, 1]) {
        const cornerBlock = new THREE.Mesh(
          new THREE.BoxGeometry(cornerW, cornerBaseH, cornerD),
          facadeMat
        );
        cornerBlock.position.set(xSign * cornerMidX, cornerBaseH / 2, zSign * cornerMidZ);
        cornerBlock.receiveShadow = true;
        cornerBlock.castShadow = true;
        this.fieldRoot.add(cornerBlock);

        // Stepped inner corner deck
        const innerStep = new THREE.Mesh(
          new THREE.BoxGeometry(cornerW * 0.65, stepH * 3, cornerD * 0.65),
          concreteMat
        );
        innerStep.position.set(
          xSign * (cornerInnerX + cornerW * 0.325),
          (stepH * 3) / 2,
          zSign * (cornerInnerZ + cornerD * 0.325)
        );
        this.fieldRoot.add(innerStep);
      }
    }
  }

  private buildFloodlights(): void {
    const poleMat = new THREE.MeshStandardMaterial({
      color: 0x64748b,
      metalness: 0.6,
      roughness: 0.35,
    });
    const headMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.4,
    });
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0xfef9c3 });

    const poleHeight = 0.38;
    const cornerX = HALF_LENGTH + 0.20;
    const cornerZ = HALF_WIDTH + 0.20;

    for (const xSign of [-1, 1]) {
      for (const zSign of [-1, 1]) {
        const tower = new THREE.Group();
        tower.position.set(xSign * cornerX, 0, zSign * cornerZ);

        const pole = new THREE.Mesh(
          new THREE.CylinderGeometry(0.007, 0.011, poleHeight, 10),
          poleMat
        );
        pole.position.y = poleHeight / 2;
        tower.add(pole);

        const head = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.026, 0.018), headMat);
        head.position.y = poleHeight;
        head.lookAt(-xSign * 0.6, -0.25, -zSign * 0.6);
        tower.add(head);

        const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.044, 0.018), bulbMat);
        glow.position.z = 0.0095;
        head.add(glow);

        this.fieldRoot.add(tower);
      }
    }
  }

  private buildScoreboard(): void {
    const wallTopY = 7 * 0.021 + 0.022;
    const wallZ = HALF_WIDTH + 0.045 + 7 * 0.028 + 0.007;

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

    // Mount physical scoreboard signs on top of both North and South grandstand walls
    for (const zSign of [-1, 1]) {
      const mount = new THREE.Group();
      mount.position.set(0, 0, zSign * wallZ);
      if (zSign === 1) {
        mount.rotation.y = Math.PI;
      }

      // Two steel support pillars anchored into the grandstand back wall
      for (const xPos of [-0.17, 0.17]) {
        const pillar = new THREE.Mesh(pillarGeo, pillarMat);
        pillar.position.set(xPos, wallTopY + 0.022, 0);
        pillar.castShadow = true;
        mount.add(pillar);
      }

      // Tilted scoreboard housing ("placa do estádio")
      const boardHead = new THREE.Group();
      boardHead.position.set(0, 0.285, 0);
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
        opacity: 0.16,
        side: THREE.DoubleSide,
      })
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = 0.001;
    group.add(pad);

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


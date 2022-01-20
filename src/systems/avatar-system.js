import avatarSheetImgSrc from "!!url-loader!../assets/jel/images/avatar-sheet.png";
import avatarSheetBasisSrc from "!!url-loader!../assets/jel/images/avatar-sheet.basis";
import HubsTextureLoader from "../loaders/HubsTextureLoader";
import { createBasisTexture } from "../utils/media-utils";
import { DynamicInstancedMesh } from "../jel/objects/DynamicInstancedMesh";
import { RENDER_ORDER } from "../constants";
import { almostEqual } from "../utils/three-utils";
import { AvatarSphereBufferGeometry } from "../jel/objects/avatar-sphere-buffer-geometry";
import { WORLD_MATRIX_CONSUMERS } from "../utils/threejs-world-update";
import { getMicrophonePresences } from "../utils/microphone-presence";

export const rgbToCssRgb = v => Math.floor(v * 255.0);
const BLANK_AVATAR_ID = "9ioqyYv";

const {
  ShaderMaterial,
  Color,
  MeshBasicMaterial,
  Matrix4,
  ShaderLib,
  UniformsUtils,
  MeshToonMaterial,
  NearestFilter,
  LinearFilter,
  DataTexture,
  Vector4
} = THREE;

const USE_BASIS = true;
const MAX_ANISOTROPY = 16;

const EYE_DECAL_NEUTRAL = 0;
const EYE_DECAL_UP = 1;
const EYE_DECAL_DOWN = 2;
const EYE_DECAL_LEFT = 3;
const EYE_DECAL_RIGHT = 4;
const EYE_DECAL_BLINK1 = 5;
const EYE_DECAL_BLINK2 = 6;
const EYE_DECAL_BLINK3 = 7;
const EYE_SHIFT_DECALS = [EYE_DECAL_LEFT, EYE_DECAL_RIGHT, EYE_DECAL_UP, EYE_DECAL_DOWN];
const BLINK_TRIGGER_PROBABILITY = 0.005;
const SHIFT_TRIGGER_PROBABILITY = 0.005;
const BLINK_FRAME_DURATION_MS = 25.0;
const EYE_SHIFT_DURATION_MS = 500.0;

let toonGradientMap;

(() => {
  const colors = new Uint8Array(3);

  for (let c = 0; c <= colors.length; c++) {
    colors[c] = (c / colors.length) * 256;
  }

  toonGradientMap = new DataTexture(colors, colors.length, 1, THREE.LuminanceFormat);
  toonGradientMap.minFilter = NearestFilter;
  toonGradientMap.magFilter = NearestFilter;
  toonGradientMap.generateMipmaps = false;
})();

const IDENTITY = new Matrix4();
const TINY = new Matrix4().makeScale(0.001, 0.001, 0.001);
const ZERO = new Vector4();
ZERO.w = 0.0;
const AVATAR_RADIUS = 0.4;

const avatarMaterial = new ShaderMaterial({
  name: "avatar",
  fog: true,
  fragmentShader: ShaderLib.toon.fragmentShader,
  vertexShader: ShaderLib.toon.vertexShader,
  lights: true,
  transparent: true,
  defines: {
    ...new MeshToonMaterial().defines,
    TWOPI: 3.1415926538
  },
  uniforms: {
    ...UniformsUtils.clone(ShaderLib.toon.uniforms),
    ...{
      decalMap: {
        type: "t",
        value: null
      },
      time: { value: 0.0 }
    }
  }
});

avatarMaterial.uniforms.gradientMap.value = toonGradientMap;
avatarMaterial.uniforms.diffuse.value = new Color(0.5, 0.5, 0.5);

avatarMaterial.stencilWrite = true; // Avoid SSAO
avatarMaterial.stencilFunc = THREE.AlwaysStencilFunc;
avatarMaterial.stencilRef = 2;
avatarMaterial.stencilZPass = THREE.ReplaceStencilOp;

const outlineMaterial = new MeshBasicMaterial({ color: new Color(0, 0, 0) });
const highlightMaterial = new MeshBasicMaterial({ color: new Color(1, 1, 1) });

export const WORLD_RADIUS = 12800.0;

export const addVertexCurvingToShader = (shader, postCurveShader = "") => {
  shader.vertexShader = shader.vertexShader.replace(
    "#include <project_vertex>",
    [
      "#define cplx vec2",
      "#define cplx_new(re, im) vec2(re, im)",
      "#define cplx_re(z) z.x",
      "#define cplx_im(z) z.y",
      "#define cplx_exp(z) (exp(z.x) * cplx_new(cos(z.y), sin(z.y)))",
      "#define cplx_scale(z, scalar) (z * scalar)",
      "#define cplx_abs(z) (sqrt(z.x * z.x + z.y * z.y))",
      `float rp = ${WORLD_RADIUS.toFixed(2)};`,
      "vec4 mvPosition = vec4( transformed, 1.0 );",
      "#ifdef USE_INSTANCING",
      "mvPosition = instanceMatrix * mvPosition;",
      "#endif",
      "vec4 pos = modelMatrix * mvPosition;",
      "mvPosition = modelViewMatrix * mvPosition;", // Leave mvPosition correct for remainder of shader.
      "#ifdef STANDARD",
      "vec3 camPos = cameraPosition;",
      "#else",
      "mat4 worldViewMatrix = inverse(viewMatrix);",
      "vec3 camPos = worldViewMatrix[3].xyz;",
      "#endif",
      "vec2 planedir = normalize(vec2(pos.x - camPos.x, pos.z - camPos.z));",
      "cplx plane = cplx_new(pos.y - camPos.y, sqrt((pos.x - camPos.x) * (pos.x - camPos.x) + (pos.z - camPos.z) * (pos.z - camPos.z)));",
      "cplx circle = rp * cplx_exp(cplx_scale(plane, 1.0 / rp)) - cplx_new(rp, 0);",
      "pos.x = cplx_im(circle) * planedir.x + camPos.x;",
      "pos.z = cplx_im(circle) * planedir.y + camPos.z;",
      "pos.y = cplx_re(circle) + camPos.y;",
      "gl_Position = projectionMatrix * viewMatrix * pos;",
      postCurveShader
    ].join("\n")
  );
};

avatarMaterial.onBeforeCompile = shader => {
  // Float oscillation, vary period and freq by instance index
  const postCurveShader = [
    "gl_Position.y = gl_Position.y + sin(time * TWOPI * 0.001 * (mod(instanceIndex, 10.0) / 7.0) + instanceIndex * 7.0) * 0.025;"
  ].join("\n");

  addVertexCurvingToShader(shader, postCurveShader);

  // Add shader code to add decals
  shader.vertexShader = shader.vertexShader.replace(
    "#include <uv2_pars_vertex>",
    [
      "#include <uv2_pars_vertex>",
      "attribute vec3 instanceColor;",
      "varying vec3 vInstanceColor;",
      "uniform float time;",
      "attribute vec3 duv;",
      "varying vec3 vDuv;",
      "attribute float colorScale;",
      "varying float vColorScale;",
      "attribute vec4 duvOffset;",
      "varying vec4 vDuvOffset;",
      "attribute float showOutline;",
      "varying float vShowOutline;",
      "attribute float instanceIndex;"
    ].join("\n")
  );

  shader.vertexShader = shader.vertexShader.replace(
    "#include <color_vertex>",
    [
      "#include <color_vertex>",
      "vDuv = duv;",
      "vDuvOffset = duvOffset;",
      "vShowOutline = showOutline;",
      "vColorScale = colorScale;",
      "vInstanceColor = instanceColor;"
    ].join("\n")
  );

  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <gradientmap_pars_fragment>",
    [
      "#include <gradientmap_pars_fragment>",
      "precision highp sampler2D;",
      "uniform sampler2D decalMap;",
      "varying vec3 vDuv;",
      "varying vec4 vDuvOffset;",
      "varying float vShowOutline;",
      "varying vec3 vInstanceColor;",
      "varying float vColorScale;"
    ].join("\n")
  );

  // Avoid colored lights
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <lights_phong_pars_fragment>",
    [
      "varying vec3 vViewPosition;",
      "#ifndef FLAT_SHADED",
      "varying vec3 vNormal;",
      "#endif",
      "",
      "struct BlinnPhongMaterial {",
      "vec3	diffuseColor;",
      "vec3	specularColor;",
      "float	specularShininess;",
      "float	specularStrength;",
      "};",
      "",
      "void RE_Direct_BlinnPhong( const in IncidentLight directLight, const in GeometricContext geometry, const in BlinnPhongMaterial material, inout ReflectedLight reflectedLight ) {",
      "#ifdef TOON",
      "vec3 directLightColor = vec3(2.5, 2.5, 2.5);",
      "vec3 irradiance = getGradientIrradiance( geometry.normal, directLight.direction ) * directLightColor;",
      "",
      "#else",
      "",
      "float dotNL = saturate( dot( geometry.normal, directLight.direction ) );",
      "vec3 irradiance = dotNL * directLightColor;",
      "",
      "#endif",
      "",
      "#ifndef PHYSICALLY_CORRECT_LIGHTS",
      "",
      "irradiance *= PI; // punctual light",
      "",
      "#endif",
      "",
      "reflectedLight.directDiffuse += irradiance * BRDF_Diffuse_Lambert( material.diffuseColor );",
      "",
      "reflectedLight.directSpecular += irradiance * BRDF_Specular_BlinnPhong( directLight, geometry, material.specularColor, material.specularShininess ) * material.specularStrength;",
      "",
      "}",
      "",
      "void RE_IndirectDiffuse_BlinnPhong( const in vec3 irradiance, const in GeometricContext geometry, const in BlinnPhongMaterial material, inout ReflectedLight reflectedLight ) {",
      "",
      "reflectedLight.indirectDiffuse += irradiance * BRDF_Diffuse_Lambert( material.diffuseColor );",
      "",
      "}",
      "",
      "#define RE_Direct				RE_Direct_BlinnPhong",
      "#define RE_IndirectDiffuse		RE_IndirectDiffuse_BlinnPhong",
      "",
      "#define Material_LightProbeLOD( material )	(0)"
    ].join("\n")
  );

  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <color_fragment>",
    ["#include <color_fragment>", "diffuseColor.rgb = vInstanceColor.rgb;"].join("\n")
  );
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <tonemapping_fragment>",
    [
      // Refactored below: "float duOffset = vDuv.z == 0.0 ? vDuvOffset.x : vDuvOffset.z;",
      "float clampedLayer = clamp(vDuv.z, 0.0, 1.0);",
      "float duOffset = mix(vDuvOffset.x, vDuvOffset.z, clampedLayer);",
      "float dvOffset = mix(vDuvOffset.y, vDuvOffset.w, clampedLayer);",
      "vec4 texel = texture(decalMap, vec2(vDuv.x / 8.0 + duOffset / 8.0, vDuv.y / 16.0 + dvOffset / 16.0 + vDuv.z * 0.5));",
      "vec3 color = gl_FragColor.rgb * (1.0 - texel.a) + texel.rgb * texel.a;",
      "vec3 scaled = clamp(max(color * vColorScale, step(1.1, vColorScale)), 0.0, 1.0);",
      "gl_FragColor = vec4(scaled, gl_FragColor.a * (1.0 - step(1.0, 1.0 - vShowOutline) * step(1.01, vColorScale)));",
      "#include <tonemapping_fragment>"
    ].join("\n")
  );
};

outlineMaterial.onBeforeCompile = shader => addVertexCurvingToShader(shader);
highlightMaterial.onBeforeCompile = shader => addVertexCurvingToShader(shader);

const MAX_AVATARS = 1024;

// Draws instanced avatar heads. IK controller now sets instanced heads to non-visible to avoid draw calls.
export class AvatarSystem {
  constructor(sceneEl) {
    this.sceneEl = sceneEl;
    this.avatarEntityIdToIndex = new Map();
    this.avatarCreatorIds = Array(MAX_AVATARS).fill(null);
    this.avatarEntityIds = Array(MAX_AVATARS).fill(null);
    this.avatarVolumes = Array(MAX_AVATARS).fill(0);
    this.currentVisemes = Array(MAX_AVATARS).fill(-1);
    this.dirtyColors = Array(MAX_AVATARS).fill(false);
    this.avatarIkControllers = Array(MAX_AVATARS).fill(null);
    this.selfAvatarEntityId = null;
    this.selfAvatarSwatch = null;
    this.selfAvatarSwatchCheckTime = null;
    this.lastMicrophonePresence = performance.now();
    this.microphonePresences = new Map();
    this.hoveredAvatarSessionId = null;

    this.scheduledEyeDecals = Array(MAX_AVATARS);
    this.avatarColorOverrides = Array(MAX_AVATARS).fill(null);

    for (let i = 0; i < this.scheduledEyeDecals.length; i++) {
      this.scheduledEyeDecals[i] = { t: 0.0, decal: 0, state: 0 };
    }

    for (let i = 0; i < this.currentVisemes.length; i++) {
      this.currentVisemes[i] = -1;
    }

    this.maxRegisteredIndex = -1;
    this.loadedDecals = false;

    this.createMesh();

    setInterval(() => {
      // When scene is off (since we're in a channel or paused) we need to keep updating the self avatar in the UI.
      if (sceneEl.is("off") || !sceneEl.object3D.isPlaying) {
        this.beginUpdatingSelfAsync();
      }
    }, 1000);
  }

  beginUpdatingSelfAsync() {
    if (this.selfUpdateInterval) return;

    // Update at 60 hz
    this.selfUpdateInterval = setInterval(() => {
      this.processAvatars(performance.now(), true);
    }, 1000.0 / 60.0);
  }

  stopUpdatingSelfAsync() {
    if (this.selfUpdateInterval) {
      clearInterval(this.selfUpdateInterval);
      this.selfUpdateInterval = null;
    }
  }

  async loadDecalMap() {
    let decalMap;

    if (USE_BASIS) {
      decalMap = (await createBasisTexture(avatarSheetBasisSrc))[0];
    } else {
      decalMap = await new HubsTextureLoader().load(avatarSheetImgSrc);
    }

    decalMap.magFilter = LinearFilter;
    decalMap.minFilter = LinearFilter;
    decalMap.anisotropy = MAX_ANISOTROPY;
    avatarMaterial.uniforms.decalMap.value = decalMap;
    avatarMaterial.uniformsNeedUpdate = true;
  }

  register(avatarEntityId, creatorId, isSelf) {
    if (this.avatarEntityIdToIndex.has(avatarEntityId)) return;

    // Hack, start self tiny since self is delayed a few frames
    const index = this.mesh.addInstance(ZERO, ZERO, isSelf ? TINY : IDENTITY);
    this.avatarCreatorIds[index] = creatorId;
    this.avatarEntityIds[index] = avatarEntityId;
    this.maxRegisteredIndex = Math.max(index, this.maxRegisteredIndex);
    this.avatarEntityIdToIndex.set(avatarEntityId, index);
    this.dirtyColors[index] = true;

    if (isSelf) {
      this.selfAvatarEntityId = avatarEntityId;
    }
  }

  setIkController(avatarEntityId, el) {
    if (!this.avatarEntityIdToIndex.has(avatarEntityId)) return;
    const i = this.avatarEntityIdToIndex.get(avatarEntityId);
    this.avatarIkControllers[i] = el.components["ik-controller"];
  }

  unregister(avatarEntityId) {
    if (!this.avatarEntityIdToIndex.has(avatarEntityId)) return;
    const i = this.avatarEntityIdToIndex.get(avatarEntityId);
    this.avatarEntityIds[i] = null;
    this.avatarCreatorIds[i] = null;
    this.avatarIkControllers[i] = null;
    this.avatarColorOverrides[i] = null;
    this.avatarVolumes[i] = 0;
    this.mesh.freeInstance(i);
    this.avatarEntityIdToIndex.delete(avatarEntityId);

    if (this.selfAvatarEntityId === avatarEntityId) {
      this.selfAvatarEntityId = null;
    }

    if (this.maxRegisteredIndex === i) {
      this.maxRegisteredIndex--;
    }
  }

  setAvatarVolume(avatarEntityId, volume) {
    if (!this.avatarEntityIdToIndex.has(avatarEntityId)) return;

    const i = this.avatarEntityIdToIndex.get(avatarEntityId);
    this.avatarVolumes[i] = volume;
  }

  markPersonaAvatarDirty(creatorId) {
    for (let i = 0; i <= this.maxRegisteredIndex; i++) {
      if (this.avatarCreatorIds[i] === creatorId) {
        this.dirtyColors[i] = true;
        return;
      }
    }
  }

  createMesh() {
    this.mesh = new DynamicInstancedMesh(
      new AvatarSphereBufferGeometry(AVATAR_RADIUS, MAX_AVATARS),
      avatarMaterial,
      MAX_AVATARS
    );
    this.mesh.renderOrder = RENDER_ORDER.INSTANCED_AVATAR;
    this.mesh.castShadow = true;
    this.duvOffsetAttribute = this.mesh.geometry.instanceAttributes[0][1];
    this.instanceColorAttribute = this.mesh.geometry.instanceAttributes[1][1];
    this.showOutlineAttribute = this.mesh.geometry.instanceAttributes[2][1];

    this.sceneEl.object3D.add(this.mesh);
  }

  tick(t) {
    this.stopUpdatingSelfAsync();

    if (!this.loadedDecals) {
      this.loadDecalMap();
      this.loadedDecals = true;
    }

    if (!avatarMaterial.uniforms.decalMap.value) return;
    if (!window.APP.hubChannel) return;
    if (!window.APP.hubChannel.presence) return;

    avatarMaterial.uniforms.time.value = t;

    if (performance.now() - this.lastMicrophonePresence > 250) {
      this.microphonePresences = getMicrophonePresences();
      this.lastMicrophonePresence = performance.now();
    }

    this.processAvatars(t);

    this.showHoveredNametag();
  }

  getAvatarElForSessionId(sessionId) {
    for (const avatarEl of document.querySelectorAll("[networked-avatar]")) {
      if (avatarEl.components.networked && avatarEl.components.networked.data.creator === sessionId) {
        return avatarEl;
      }
    }

    return null;
  }

  processAvatars(t, selfOnly = false) {
    const {
      scheduledEyeDecals,
      currentVisemes,
      avatarEntityIds,
      avatarCreatorIds,
      maxRegisteredIndex,
      duvOffsetAttribute,
      instanceColorAttribute,
      showOutlineAttribute,
      mesh,
      avatarIkControllers,
      avatarVolumes
    } = this;

    const presenceState =
      window.APP.hubChannel && window.APP.hubChannel.presence && window.APP.hubChannel.presence.state;
    if (!presenceState) return;

    const nafAdapter = NAF.connection.adapter;
    let duvNeedsUpdate = false,
      instanceMatrixNeedsUpdate = false,
      instanceColorNeedsUpdate = false,
      showOutlineNeedsUpdate = false;

    let selfChanged = false;
    let newSelfEyeDecal = null,
      newSelfViseme = null,
      newSelfColor = null;

    for (let i = 0; i <= maxRegisteredIndex; i++) {
      const creatorId = avatarCreatorIds[i];
      if (creatorId === null) continue;

      const isSelf = avatarEntityIds[i] === this.selfAvatarEntityId;
      if (selfOnly && !isSelf) continue;

      const scheduledEyeDecal = scheduledEyeDecals[i];
      const hasScheduledDecal = scheduledEyeDecal.t > 0.0;
      const volume = avatarVolumes[i];

      if (!hasScheduledDecal) {
        this.maybeScheduleEyeDecal(t, i);
      }

      const hasEyeDecalChange = hasScheduledDecal && scheduledEyeDecal.t < t;
      const prevViseme = currentVisemes[i];

      const creatorPresenceState = creatorId && presenceState[creatorId];
      const presenceMetas = creatorPresenceState && presenceState[creatorId].metas;
      const presenceMeta = presenceMetas && presenceMetas[0];
      const micPresence = this.microphonePresences && this.microphonePresences.get(creatorId);
      let hasDirtyColor = this.dirtyColors[i];
      let r = null,
        g = null,
        b = null;

      if (this.avatarColorOverrides[i] !== null) {
        r = this.avatarColorOverrides[i].r;
        g = this.avatarColorOverrides[i].g;
        b = this.avatarColorOverrides[i].b;
      } else if (presenceMeta) {
        r = presenceMeta.profile.avatarPrimaryR;
        g = presenceMeta.profile.avatarPrimaryG;
        b = presenceMeta.profile.avatarPrimaryB;
      }

      if (r !== null) {
        // Glow/dim, apply more delta for brighter colors
        const dv = volume * Math.min(0.5, Math.max(r, g, b)) * (r > 0.5 && g > 0.5 && b > 0.5 ? -1 : 1);
        r = Math.max(0, Math.min(1, r + dv));
        g = Math.max(0, Math.min(1, g + dv));
        b = Math.max(0, Math.min(1, b + dv));

        const curR = instanceColorAttribute.array[i * 3 + 0];
        const curG = instanceColorAttribute.array[i * 3 + 1];
        const curB = instanceColorAttribute.array[i * 3 + 2];

        if (hasDirtyColor || (!almostEqual(r, curR) || !almostEqual(g, curG) || !almostEqual(b !== curB))) {
          hasDirtyColor = true;

          if (isSelf) {
            newSelfColor = { r, g, b };
            selfChanged = true;
          }

          instanceColorAttribute.array[i * 3 + 0] = r;
          instanceColorAttribute.array[i * 3 + 1] = g;
          instanceColorAttribute.array[i * 3 + 2] = b;

          instanceColorNeedsUpdate = true;

          this.dirtyColors[i] = false;
        }
      }

      let currentViseme = 0;
      let isMuted = false;

      if (micPresence && micPresence.muted) {
        // Do not show the mouth - viseme 12 is "mouth missing"
        currentViseme = 12;
        isMuted = true;
      } else {
        if (nafAdapter && creatorId !== null) {
          currentViseme = nafAdapter.getCurrentViseme(creatorId);
        }
      }

      const showOutlineValue = isMuted ? 0.0 : 1.0;

      if (showOutlineAttribute.array[i] !== showOutlineValue) {
        showOutlineAttribute.array[i] = showOutlineValue;
        showOutlineNeedsUpdate = true;
      }

      const hasNewViseme = currentViseme !== prevViseme;
      let hasDirtyMatrix = false;

      if (avatarIkControllers[i] !== null) {
        const head = avatarIkControllers[i].head;

        hasDirtyMatrix = head.consumeIfDirtyWorldMatrix(WORLD_MATRIX_CONSUMERS.AVATARS);
      }

      if (!hasDirtyMatrix && !hasEyeDecalChange && !hasNewViseme && !hasDirtyColor) continue;

      if (hasEyeDecalChange) {
        const newDecal = scheduledEyeDecal.decal;
        duvOffsetAttribute.array[i * 4] = newDecal;
        duvNeedsUpdate = true;

        if (isSelf) {
          newSelfEyeDecal = newDecal;
          selfChanged = true;
        }

        this.eyeDecalStateTransition(t, i);
      }

      if (hasNewViseme) {
        currentVisemes[i] = currentViseme;

        if (currentViseme <= 7) {
          duvOffsetAttribute.array[i * 4 + 2] = currentViseme;
          duvOffsetAttribute.array[i * 4 + 3] = 0;
        } else {
          duvOffsetAttribute.array[i * 4 + 2] = currentViseme - 8;
          duvOffsetAttribute.array[i * 4 + 3] = 1;
        }

        duvNeedsUpdate = true;

        if (isSelf) {
          newSelfViseme = currentViseme;
          selfChanged = true;
        }
      }

      if (hasDirtyMatrix) {
        const head = avatarIkControllers[i].head;

        head.updateMatrices();

        // Hacky, hide avatars with specific id
        if (presenceMeta && presenceMeta.profile && presenceMeta.profile.avatarId === BLANK_AVATAR_ID) {
          mesh.setMatrixAt(i, TINY);
        } else {
          mesh.setMatrixAt(i, head.matrixWorld);
        }

        instanceMatrixNeedsUpdate = true;
      }
    }

    if (selfChanged) {
      this.updateSelfAvatarSwatch(newSelfEyeDecal, newSelfViseme, newSelfColor);
    }

    duvOffsetAttribute.needsUpdate = duvNeedsUpdate;
    instanceColorAttribute.needsUpdate = instanceColorNeedsUpdate;
    showOutlineAttribute.needsUpdate = showOutlineNeedsUpdate;
    mesh.instanceMatrix.needsUpdate = instanceMatrixNeedsUpdate;
  }

  maybeScheduleEyeDecal(t, i) {
    const scheduledEyeDecal = this.scheduledEyeDecals[i];

    // No scheduled decal change, see if we should generate one.
    const r = Math.random();

    // First see if we will potentially schedule a blink or a shift.
    if (r > 0.5 && r - 0.5 <= BLINK_TRIGGER_PROBABILITY) {
      scheduledEyeDecal.t = t + BLINK_FRAME_DURATION_MS;
      scheduledEyeDecal.decal = EYE_DECAL_BLINK1;
    } else if (r < 0.5 && r <= SHIFT_TRIGGER_PROBABILITY) {
      scheduledEyeDecal.t = t + EYE_SHIFT_DURATION_MS;
      scheduledEyeDecal.decal = EYE_SHIFT_DECALS[Math.floor(Math.random() * EYE_SHIFT_DECALS.length)];
    }
  }

  eyeDecalStateTransition(t, i) {
    const scheduledEyeDecal = this.scheduledEyeDecals[i];
    const { decal } = scheduledEyeDecal;

    // Perform decal state machine for blink/shift
    switch (decal) {
      case EYE_DECAL_BLINK1:
        scheduledEyeDecal.t = t + BLINK_FRAME_DURATION_MS;
        scheduledEyeDecal.decal = scheduledEyeDecal.state === 0 ? EYE_DECAL_BLINK2 : EYE_DECAL_NEUTRAL;
        break;
      case EYE_DECAL_BLINK2:
        scheduledEyeDecal.t = t + BLINK_FRAME_DURATION_MS;
        scheduledEyeDecal.decal = scheduledEyeDecal.state === 0 ? EYE_DECAL_BLINK3 : EYE_DECAL_BLINK1;
        break;
      case EYE_DECAL_BLINK3:
        scheduledEyeDecal.t = t + BLINK_FRAME_DURATION_MS;
        scheduledEyeDecal.decal = EYE_DECAL_BLINK2;
        scheduledEyeDecal.state = 1; // Used to know if closing or opening eyes in blink.
        break;
      case EYE_DECAL_UP:
      case EYE_DECAL_DOWN:
      case EYE_DECAL_LEFT:
      case EYE_DECAL_RIGHT:
        scheduledEyeDecal.t = t + EYE_SHIFT_DURATION_MS;
        scheduledEyeDecal.decal = EYE_DECAL_NEUTRAL;
        break;
      case EYE_DECAL_NEUTRAL:
        // Eye now neutral, deschedule decals.
        scheduledEyeDecal.t = 0.0;
        scheduledEyeDecal.state = 0;
    }
  }

  updateSelfAvatarSwatch(eyeDecal, viseme, color) {
    let swatch = this.selfAvatarSwatch;

    if (!swatch || performance.now() - this.selfAvatarSwatchCheckTime > 1000) {
      swatch = document.getElementById("self-avatar-swatch");

      if (swatch) {
        swatch.setAttribute("data-eyes", 0);
        swatch.setAttribute("data-mouth", 0);
        this.selfAvatarSwatch = swatch;
      }

      this.selfAvatarSwatchCheckTime = performance.now();
    }

    if (swatch) {
      if (eyeDecal !== null) {
        swatch.setAttribute("data-eyes", eyeDecal);
      }

      if (viseme !== null) {
        swatch.setAttribute("data-mouth", viseme);
      }

      if (color !== null) {
        const { r, g, b } = color;
        swatch.setAttribute("style", `color: rgb(${rgbToCssRgb(r)}, ${rgbToCssRgb(g)}, ${rgbToCssRgb(b)});`);
      }
    }
  }

  setColorOverride(avatarEntityId, color) {
    if (!this.avatarEntityIdToIndex.has(avatarEntityId)) return;

    const i = this.avatarEntityIdToIndex.get(avatarEntityId);
    this.avatarColorOverrides[i] = color;
    this.dirtyColors[i] = true;
  }

  stampDummyAvatar(pos = null, quat = null, color = null, arr = []) {
    const scene = this.sceneEl;
    const entity = document.createElement("a-entity");

    const templateBody = document
      .importNode(document.body.querySelector("#remote-avatar").content, true)
      .firstElementChild.cloneNode(true);
    const elAttrs = templateBody.attributes;

    // Merge root element attributes with this entity
    for (let attrIdx = 0; attrIdx < elAttrs.length; attrIdx++) {
      entity.setAttribute(elAttrs[attrIdx].name, elAttrs[attrIdx].value);
    }

    // Append all child elements
    while (templateBody.firstElementChild) {
      entity.appendChild(templateBody.firstElementChild);
    }

    entity.setAttribute("ik-root", {});
    entity.setAttribute("networked", { template: "#remote-avatar", attachTemplateToLocal: false });

    scene.appendChild(entity);

    setTimeout(() => {
      const rig = document.getElementById("avatar-rig").object3D;
      const camera = document.getElementById("viewing-camera").components.camera.camera;
      const v = new THREE.Vector3();
      const q = new THREE.Quaternion();

      const c = {
        r: Math.random(),
        g: Math.random(),
        b: Math.random()
      };

      if (pos) {
        v.set(pos.x, pos.y, pos.z);
      } else {
        rig.getWorldPosition(v);
      }

      if (quat) {
        q.set(quat._x, quat._y, quat._z, quat._w);
      } else {
        camera.getWorldQuaternion(q);
      }

      if (color) {
        c.r = color.r;
        c.g = color.g;
        c.b = color.b;
      }

      this.setColorOverride(entity.id, c);
      entity.object3D.position.copy(v);
      entity.object3D.rotation.setFromQuaternion(q);

      entity.object3D.traverse(o => {
        if (o.name === "Head") {
          o.position.y = 1.7;
          o.matrixNeedsUpdate = true;
        }

        //o.el && o.el.removeAttribute("avatar-audio-source");
      });

      entity.object3D.matrixNeedsUpdate = true;
      arr.push([v, q, c]);
    }, 1000);

    return entity;
  }

  showHoveredNametag() {
    // Check for hovered avatar
    const interaction = this.sceneEl.systems.interaction;

    // OSTN hack update nametags
    if (!interaction.ready) return;
    const rightRemoteHoverTarget = interaction.getRightRemoteHoverTarget();

    const oldHoveredAvatarSessionId = this.hoveredAvatarSessionId;

    if (rightRemoteHoverTarget && rightRemoteHoverTarget.components["avatar-audio-source"]) {
      this.hoveredAvatarSessionId =
        rightRemoteHoverTarget.parentElement.parentElement.parentElement.parentElement.components.networked.data.creator;
    } else if (this.hoveredAvatarSessionId) {
      this.hoveredAvatarSessionId = null;
    }

    if (this.hoveredAvatarSessionId !== oldHoveredAvatarSessionId) {
      const playerInfos = window.APP.componentRegistry["player-info"] || [];
      for (let i = 0; i < playerInfos.length; i++) {
        const playerInfo = playerInfos[i];
        playerInfo.applyDisplayName();
      }
    }
  }
}

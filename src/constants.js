let bit = 0;
const nextBit = () => 1 << bit++;
const CL = {
  ALL: -1,
  NONE: 0,
  INTERACTABLES: nextBit(),
  ENVIRONMENT: nextBit(),
  AVATAR: nextBit(),
  HANDS: nextBit(),
  MEDIA_FRAMES: nextBit()
};

// @TODO we should split these "sets" off into something other than COLLISION_LAYERS or at least name
// them differently to indicate they are a combination of multiple bits
CL.DEFAULT_INTERACTABLE = CL.INTERACTABLES | CL.ENVIRONMENT | CL.AVATAR | CL.HANDS | CL.MEDIA_FRAMES;
CL.UNOWNED_INTERACTABLE = CL.INTERACTABLES | CL.HANDS;
CL.DEFAULT_SPAWNER = CL.INTERACTABLES | CL.HANDS;

module.exports = {
  COLLISION_LAYERS: CL,
  RENDER_ORDER: {
    LIGHTS: 0, // Render lights first, otherwise compiled programs may not define USE_SHADOWMAP
    HUD_BACKGROUND: 1,
    HUD_ICONS: 2,
    TERRAIN: 10,
    FIELD: 100,
    PHYSICS_DEBUG: 1000,
    VOX: 5000,
    MEDIA: 10000,
    MEDIA_NO_FXAA: 10010, // Render last because of stencil ops
    TOON: 20000, // Render last because of stencil ops
    INSTANCED_AVATAR: 21000, // Render last because of stencil ops
    INSTANCED_BEAM: 22000, // Render last because of stencil ops
    SKY: 100000,
    HELPERS: 200000,
    CURSOR: 300000,
    PICTURE_IN_PICTURE: 350000,

    // Transparent objects:
    WATER: 1
  }
};

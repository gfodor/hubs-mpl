import { restartPeriodicSyncs } from "./periodic-full-syncs";

/**
 * Stores networked avatar state.
 * @namespace avatar
 * @component networked-avatar
 */
AFRAME.registerComponent("networked-avatar", {
  schema: {
    left_hand_pose: { default: 0 },
    right_hand_pose: { default: 0 },
    relative_motion: { default: 0 },
    // True when avatar should be expressing body language of executing a jump
    is_jumping: { default: false }
  },

  init() {
    // Whenever a networked avatar is spawned, we need to begin periodic
    // syncs to ensure we spawn on their side.
    restartPeriodicSyncs();
  }
});

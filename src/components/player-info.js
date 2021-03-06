import { injectCustomShaderChunks } from "../utils/media-utils";
import { AVATAR_TYPES } from "../utils/avatar-utils";
import { registerComponentInstance, deregisterComponentInstance } from "../utils/component-utils";
import defaultAvatar from "../assets/models/DefaultAvatar.glb";
export const HIDE_NAMETAG_OCCUPANT_COUNT = 50;

/**
 * Sets player info state, including avatar choice and display name.
 * @namespace avatar
 * @component player-info
 */
AFRAME.registerComponent("player-info", {
  schema: {
    avatarSrc: { type: "string" },
    avatarType: { type: "string", default: AVATAR_TYPES.SKINNABLE },
    muted: { default: false },
    isSharingAvatarCamera: { default: false }
  },
  init() {
    this.displayName = null;
    this.identityName = null;
    this.isOwner = false;
    this.isRecording = false;
    this.applyProperties = this.applyProperties.bind(this);
    this.updateDisplayName = this.updateDisplayName.bind(this);
    this.applyDisplayName = this.applyDisplayName.bind(this);
    this.handleModelError = this.handleModelError.bind(this);
    this.handleRemoteModelError = this.handleRemoteModelError.bind(this);
    this.update = this.update.bind(this);
    this.localStateAdded = this.localStateAdded.bind(this);
    this.localStateRemoved = this.localStateRemoved.bind(this);
    this.nametagEl = null;
    this.identityNameEl = null;
    this.recordingBadgeEl = null;
    this.modBadgeEl = null;
    this.twitterAvatarEl = null;

    this.isLocalPlayerInfo = this.el.id === "avatar-rig";
    this.playerSessionId = null;

    this.twitterAvatarUrl = null;
    this.twitterHandle = null;

    if (!this.isLocalPlayerInfo) {
      NAF.utils.getNetworkedEntity(this.el).then(networkedEntity => {
        this.playerSessionId = NAF.utils.getCreator(networkedEntity);
        const playerPresence = window.APP.hubChannel.presence.state[this.playerSessionId];
        if (playerPresence) {
          this.updateFromPresenceMeta(playerPresence.metas[0]);
        }
      });
    }
    registerComponentInstance(this, "player-info");
  },
  remove() {
    deregisterComponentInstance(this, "player-info");
  },
  play() {
    this.el.addEventListener("model-loaded", this.applyProperties);
    this.el.sceneEl.addEventListener("presence_updated", this.updateDisplayName);
    if (this.isLocalPlayerInfo) {
      this.el.querySelector(".model").addEventListener("model-error", this.handleModelError);
    } else {
      this.el.querySelector(".model").addEventListener("model-error", this.handleRemoteModelError);
    }
    window.APP.store.addEventListener("statechanged", this.update);

    this.el.sceneEl.addEventListener("stateadded", this.update);
    this.el.sceneEl.addEventListener("stateremoved", this.update);

    if (this.isLocalPlayerInfo) {
      this.el.sceneEl.addEventListener("stateadded", this.localStateAdded);
      this.el.sceneEl.addEventListener("stateremoved", this.localStateRemoved);
    }
  },
  pause() {
    this.el.removeEventListener("model-loaded", this.applyProperties);
    this.el.sceneEl.removeEventListener("presence_updated", this.updateDisplayName);
    if (this.isLocalPlayerInfo) {
      this.el.querySelector(".model").removeEventListener("model-error", this.handleModelError);
    } else {
      this.el.querySelector(".model").removeEventListener("model-error", this.handleRemoteModelError);
    }
    this.el.sceneEl.removeEventListener("stateadded", this.update);
    this.el.sceneEl.removeEventListener("stateremoved", this.update);
    window.APP.store.removeEventListener("statechanged", this.update);

    if (this.isLocalPlayerInfo) {
      this.el.sceneEl.removeEventListener("stateadded", this.localStateAdded);
      this.el.sceneEl.removeEventListener("stateremoved", this.localStateRemoved);
    }
  },

  update() {
    this.applyProperties();
  },
  updateDisplayName(e) {
    if (!this.playerSessionId && this.isLocalPlayerInfo) {
      this.playerSessionId = NAF.clientId;
    }
    if (!this.playerSessionId) return;
    if (this.playerSessionId !== e.detail.sessionId) return;

    this.updateFromPresenceMeta(e.detail);
  },
  updateFromPresenceMeta(presenceMeta) {
    this.permissions = presenceMeta.permissions;
    this.displayName = presenceMeta.twitter_handle || presenceMeta.profile.displayName;
    this.identityName = presenceMeta.profile.identityName;
    this.isRecording = !!(presenceMeta.streaming || presenceMeta.recording);
    this.isOwner = !!(presenceMeta.roles && presenceMeta.roles.owner);
    this.twitterAvatarUrl = presenceMeta.twitter_avatar_url;
    this.applyDisplayName();
  },
  can(perm) {
    return !!this.permissions && this.permissions[perm];
  },
  applyDisplayName() {
    if (!this.nametagEl) {
      this.nametagEl = this.el.querySelector(".nametag");
      this.identityNameEl = this.el.querySelector(".identityName");
      this.recordingBadgeEl = this.el.querySelector(".recordingBadge");
      this.modBadgeEl = this.el.querySelector(".modBadge");
      this.twitterAvatarEl = this.el.querySelector(".twitter-avatar");
    }

    const store = window.APP.store;
    // OSTN hide nametags of non-promoted users after enough occupants

    const presenceCount = (window.APP.hubChannel && window.APP.hubChannel.presenceCount) || 0;
    const SYSTEMS = this.el.sceneEl.systems["hubs-systems"];
    const hideNametagsInCrowd = !SYSTEMS.avatarAudioTrackSystem.hasAudioFalloff();
    const hideCrowdNonOwnerNametag =
      hideNametagsInCrowd && presenceCount >= HIDE_NAMETAG_OCCUPANT_COUNT && !this.isOwner;

    const isHoveredAvatar = SYSTEMS.avatarSystem.hoveredAvatarSessionId === this.playerSessionId;

    const isFrozen = this.el.sceneEl.is("frozen");

    const infoShouldBeHidden =
      this.isLocalPlayerInfo ||
      ((hideCrowdNonOwnerNametag || store.state.preferences.onlyShowNametagsInFreeze) && !isFrozen && !isHoveredAvatar);

    const { nametagEl, identityNameEl, recordingBadgeEl, modBadgeEl, twitterAvatarEl } = this;

    if (this.displayName && nametagEl) {
      if (nametagEl.getAttribute("text").value !== this.displayName) {
        nametagEl.setAttribute("text", { value: this.displayName });
      }

      if (nametagEl.object3D.visible !== !infoShouldBeHidden) {
        nametagEl.object3D.visible = !infoShouldBeHidden;

        if (nametagEl.object3D.visible) {
          nametagEl.components.billboard.updateBillboard();
        }
      }
    }
    if (identityNameEl) {
      if (this.identityName) {
        if (identityNameEl.getAttribute("text").value !== this.identityName) {
          identityNameEl.setAttribute("text", { value: this.identityName });
        }

        identityNameEl.object3D.visible = isFrozen;
      }
    }
    if (recordingBadgeEl) {
      recordingBadgeEl.object3D.visible = this.isRecording && !infoShouldBeHidden;
    }

    if (modBadgeEl) {
      modBadgeEl.object3D.visible = !this.isRecording && this.isOwner && !infoShouldBeHidden;
    }

    if (twitterAvatarEl) {
      if (this.twitterAvatarUrl && this.twitterAvatarUrl !== twitterAvatarEl.getAttribute("src")) {
        twitterAvatarEl.setAttribute("media-image", {
          batch: true,
          src: this.twitterAvatarUrl,
          contentType: "image/jpg",
          alphaMode: "opaque"
        });
      } else if (!this.twitterAvatarUrl) {
        twitterAvatarEl.setAttribute("src", "hubs/src/assets/images/warning_icon.png");
        twitterAvatarEl.object3D.visible = false;
      }
    }
  },
  applyProperties(e) {
    this.applyDisplayName();

    const modelEl = this.el.querySelector(".model");

    if (!e || e.target === modelEl) {
      const uniforms = injectCustomShaderChunks(this.el.object3D);
      this.el.querySelectorAll("[hover-visuals]").forEach(el => {
        el.components["hover-visuals"].uniforms = uniforms;
      });
    }

    const videoTextureTargets = modelEl.querySelectorAll("[video-texture-target]");

    const sessionId = this.isLocalPlayerInfo ? NAF.clientId : this.playerSessionId;

    for (const el of Array.from(videoTextureTargets)) {
      el.setAttribute("video-texture-target", {
        src: this.data.isSharingAvatarCamera ? `hubs://clients/${sessionId}/video` : ""
      });

      if (this.isLocalPlayerInfo) {
        el.setAttribute("emit-scene-event-on-remove", "event:action_end_video_sharing");
      }
    }
  },
  handleModelError() {
    window.APP.store.resetToRandomDefaultAvatar();
  },
  handleRemoteModelError() {
    this.data.avatarSrc = defaultAvatar;
    this.applyProperties();
  },
  localStateAdded(e) {
    if (e.detail === "muted") {
      this.el.setAttribute("player-info", { muted: true });
    }
  },
  localStateRemoved(e) {
    if (e.detail === "muted") {
      this.el.setAttribute("player-info", { muted: false });
    }
  }
});

import { isSafari } from "../utils/detect-safari";

function updateMediaAudioSettings(mediaVideo, settings) {
  mediaVideo.el.setAttribute("media-video", {
    distanceModel: settings.mediaDistanceModel,
    rolloffFactor: settings.mediaRolloffFactor,
    refDistance: settings.mediaRefDistance,
    maxDistance: settings.mediaMaxDistance,
    coneInnerAngle: settings.mediaConeInnerAngle,
    coneOuterAngle: settings.mediaConeOuterAngle,
    coneOuterGain: settings.mediaConeOuterGain
  });
}

export class AudioSettingsSystem {
  constructor(sceneEl, avatarAudioTrackSystem) {
    this.sceneEl = sceneEl;
    this.avatarAudioTrackSystem = avatarAudioTrackSystem;

    this.defaultSettings = {
      avatarDistanceModel: "inverse",
      avatarRolloffFactor: 10,
      avatarRefDistance: 5,
      avatarMaxDistance: 10000,
      mediaVolume: 0.5,
      mediaDistanceModel: "inverse",
      mediaRolloffFactor: 1,
      mediaRefDistance: 1,
      mediaMaxDistance: 10000,
      mediaConeInnerAngle: 360,
      mediaConeOuterAngle: 0,
      mediaConeOuterGain: 0
    };
    this.audioSettings = this.defaultSettings;
    this.avatarAudioTrackSystem.updateAudioSettings(this.audioSettings);
    this.mediaVideos = [];

    this.sceneEl.addEventListener("reset_scene", this.onSceneReset);

    // Do not force panner audio in Safari as a temporary fix for distorted audio.
    // See https://github.com/mozilla/hubs/issues/4411
    if (!isSafari() && window.APP.store.state.preferences.audioOutputMode === "audio") {
      //hack to always reset to "panner"
      window.APP.store.update({
        preferences: { audioOutputMode: "panner" }
      });
    }
    if (window.APP.store.state.preferences.audioNormalization !== 0.0) {
      //hack to always reset to 0.0 (disabled)
      window.APP.store.update({
        preferences: { audioNormalization: 0.0 }
      });
    }

    this.audioOutputMode = window.APP.store.state.preferences.audioOutputMode;
    this.onPreferenceChanged = () => {
      const newPref = window.APP.store.state.preferences.audioOutputMode;
      const shouldUpdateAudioSettings = this.audioOutputMode !== newPref;
      this.audioOutputMode = newPref;
      if (shouldUpdateAudioSettings) {
        this.updateAudioSettings(this.audioSettings);
      }
    };
    window.APP.store.addEventListener("statechanged", this.onPreferenceChanged);
  }

  registerMediaAudioSource(mediaVideo) {
    const index = this.mediaVideos.indexOf(mediaVideo);
    if (index === -1) {
      this.mediaVideos.push(mediaVideo);
    }
    updateMediaAudioSettings(mediaVideo, this.audioSettings);
  }

  unregisterMediaAudioSource(mediaVideo) {
    this.mediaVideos.splice(this.mediaVideos.indexOf(mediaVideo), 1);
  }

  updateAudioSettings(settings) {
    this.audioSettings = Object.assign({}, this.defaultSettings, settings);
    this.avatarAudioTrackSystem.updateAudioSettings(settings);

    for (const mediaVideo of this.mediaVideos) {
      updateMediaAudioSettings(mediaVideo, settings);
    }
  }

  onSceneReset = () => {
    this.updateAudioSettings(this.defaultSettings);
  };
}

AFRAME.registerComponent("use-audio-system-settings", {
  init() {
    this.onVideoLoaded = this.onVideoLoaded.bind(this);
    this.el.addEventListener("video-loaded", this.onVideoLoaded);
  },

  onVideoLoaded() {
    const audioSettingsSystem = this.el.sceneEl.systems["hubs-systems"].audioSettingsSystem;
    if (this.mediaVideo) {
      audioSettingsSystem.unregisterMediaAudioSource(this.mediaVideo);
    }
    this.mediaVideo = this.el.components["media-video"];
    audioSettingsSystem.registerMediaAudioSource(this.mediaVideo);
  },

  remove() {
    const audioSettingsSystem = this.el.sceneEl.systems["hubs-systems"].audioSettingsSystem;
    if (this.mediaVideo) {
      audioSettingsSystem.unregisterMediaAudioSource(this.mediaVideo);
    }
    this.el.removeEventListener("video-loaded", this.onVideoLoaded);
  }
});

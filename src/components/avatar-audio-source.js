const INFO_INIT_FAILED = "Failed to initialize avatar-audio-source.";
const INFO_NO_NETWORKED_EL = "Could not find networked el.";
const INFO_NO_OWNER = "Networked component has no owner.";

async function getOwnerId(el) {
  const networkedEl = await NAF.utils.getNetworkedEntity(el).catch(e => {
    console.error(INFO_INIT_FAILED, INFO_NO_NETWORKED_EL, e);
  });
  if (!networkedEl) {
    return null;
  }
  return networkedEl.components.networked.data.owner;
}

async function getMediaStream(el) {
  const peerId = await getOwnerId(el);
  if (!peerId) {
    console.error(INFO_INIT_FAILED, INFO_NO_OWNER);
    return null;
  }
  const stream = await NAF.connection.adapter.getMediaStream(peerId).catch(e => {
    console.error(INFO_INIT_FAILED, `Error getting media stream for ${peerId}`, e);
  });
  if (!stream) {
    return null;
  }
  return stream;
}

function setPositionalAudioProperties(audio, settings) {
  audio.setDistanceModel(settings.distanceModel);
  audio.setMaxDistance(settings.maxDistance);
  audio.setRefDistance(settings.refDistance);
  audio.setRolloffFactor(settings.rolloffFactor);
  audio.setDirectionalCone(settings.innerAngle, settings.outerAngle, settings.outerGain);
}

AFRAME.registerComponent("avatar-audio-source", {
  async init() {
    this.trackLastUpdated = null;

    const ownerId = await getOwnerId(this.el);
    this.el.sceneEl.systems["hubs-systems"].avatarAudioTrackSystem.register(this.el, ownerId);
  },

  remove: function() {
    this.el.sceneEl.systems["hubs-systems"].avatarAudioTrackSystem.unregister(this.el);
  },

  toDump: function(indent, nindent) {
    let s = "";
    s += `${indent} up: ${this.trackLastUpdated}\n`;
    s += this.el.sceneEl.systems["hubs-systems"].avatarAudioTrackSystem.toDump(this.el, indent, nindent);

    return s;
  }
});

function createWhiteNoise(audioContext, gain) {
  const bufferSize = 2 * audioContext.sampleRate,
    noiseBuffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate),
    output = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    output[i] = (Math.random() * 2 - 1) * gain;
  }

  const whiteNoise = audioContext.createBufferSource();
  whiteNoise.buffer = noiseBuffer;
  whiteNoise.loop = true;
  whiteNoise.start(0);
  return whiteNoise;
}

const tmpWorldPos = new THREE.Vector3();

/**
 * @component zone-audio-source
 * This component looks for audio sources that get near it, keeping track
 * of them and making them available to other components. It currently only
 * supports avatars via the avatar-audio-source component, and only a single
 * source at a time, but this can easily be expanded in the future.
 */
AFRAME.registerComponent("zone-audio-source", {
  schema: {
    onlyMods: { default: true },
    muteSelf: { default: true },

    debug: { default: false }
  },

  init() {
    const audioListener = this.el.sceneEl.audioListener;
    const ctx = audioListener.context;
    this.output = ctx.createGain();
    if (this.data.debug) {
      this.whiteNoise = createWhiteNoise(ctx, 0.01);
      this.setInput(this.whiteNoise);
    }

    // TODO this should probably be using bounds similar to media-frames and trigger-volume.
    // Doing the simple thing for now since we only support avatar audio sources currently
    this.el.object3D.updateMatrixWorld();
    const radius = this.el.object3D.matrixWorld.getMaxScaleOnAxis();
    this.boundingRadiusSquared = radius * radius;

    if (this.data.debug) {
      this.el.setObject3D(
        "debug",
        new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.SphereBufferGeometry(1, 10, 10)))
      );
    }
  },

  setInput(newInput) {
    if (this.input) {
      this.input.disconnect(this.output);
      this.input = null;
    }

    if (newInput) {
      newInput.connect(this.output);
      this.input = newInput;
    }
  },

  getAudioOutput() {
    return this.output;
  },

  tick() {
    this.el.object3D.getWorldPosition(tmpWorldPos);
    if (this.trackingEl) {
      const distanceSquared = this.trackingEl.object3D.position.distanceToSquared(tmpWorldPos);
      if (distanceSquared > this.boundingRadiusSquared) {
        this.trackingEl = null;
        this.setInput(this.whiteNoise);
      }
    } else {
      const playerInfos = window.APP.componentRegistry["player-info"];
      for (let i = 0; i < playerInfos.length; i++) {
        const playerInfo = playerInfos[i];
        const avatar = playerInfo.el;

        if (this.data.onlyMods && !playerInfo.can("amplify_audio")) continue;

        const distanceSquared = avatar.object3D.position.distanceToSquared(tmpWorldPos);
        if (distanceSquared < this.boundingRadiusSquared) {
          this.trackingEl = avatar;
          if (this.data.muteSelf && this.trackingEl.id === "avatar-rig") {
            // Don't emit your own audio
            this.setInput(null);
          } else {
            getMediaStream(this.trackingEl).then(stream => {
              const audioListener = this.el.sceneEl.audioListener;
              const ctx = audioListener.context;
              const node = ctx.createMediaStreamSource(stream);
              this.setInput(node);
            });
          }
        }
      }
    }
  }
});

/**
 * @component audio-target
 * This component pulls audio from a "source" component and re-emits it.
 * Currently the audio can come from a zone-audio-source. A gain as well
 * as a random delay can be applied in addition to the standard positional
 * audio properties, to better simulate a real world speaker setup.
 */
AFRAME.registerComponent("audio-target", {
  schema: {
    positional: { default: true },

    distanceModel: {
      default: "inverse",
      oneOf: ["linear", "inverse", "exponential"]
    },
    maxDistance: { default: 10000 },
    refDistance: { default: 8 },
    rolloffFactor: { default: 5 },

    innerAngle: { default: 170 },
    outerAngle: { default: 300 },
    outerGain: { default: 0.3 },

    minDelay: { default: 0.01 },
    maxDelay: { default: 0.13 },
    gain: { default: 1.0 },

    srcEl: { type: "selector" },

    debug: { default: false }
  },

  init() {
    this.createAudio();
    // TODO this is to ensure targets and sources loaded at the same time don't have
    // an order depndancy but this should be done in a more robust way
    setTimeout(() => {
      this.connectAudio();
    }, 0);
  },

  remove: function() {
    this.destroyAudio();
  },

  createAudio: function() {
    const audioListener = this.el.sceneEl.audioListener;
    const audio = this.data.positional ? new THREE.PositionalAudio(audioListener) : new THREE.Audio(audioListener);

    if (this.data.debug && this.data.positional) {
      setPositionalAudioProperties(audio, this.data);
      const helper = new THREE.PositionalAudioHelper(audio, this.data.refDistance, 16, 16);
      audio.add(helper);
    }

    audio.setVolume(this.data.gain);

    if (this.data.maxDelay > 0) {
      const delayNode = audio.context.createDelay(this.data.maxDelay);
      delayNode.delayTime.value = THREE.Math.randFloat(this.data.minDelay, this.data.maxDelay);
      audio.setFilters([delayNode]);
    }

    this.el.setObject3D(this.attrName, audio);
    audio.matrixNeedsUpdate = true;
    audio.updateMatrixWorld();
    this.audio = audio;
  },

  connectAudio() {
    const srcEl = this.data.srcEl;
    const srcZone = srcEl && srcEl.components["zone-audio-source"];
    const node = srcZone && srcZone.getAudioOutput();
    if (node) {
      this.audio.setNodeSource(node);
    } else {
      console.warn(`Failed to get audio from source for ${this.el.className}`, srcEl);
    }
  },

  destroyAudio() {
    const audio = this.el.getObject3D(this.attrName);
    if (!audio) return;

    audio.disconnect();
    this.el.removeObject3D(this.attrName);
  }
});

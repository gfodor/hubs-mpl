import { calculateVolume } from "../components/audio-feedback";

const MAX_SOURCES = 12;
const MAX_TARGETS = 1024;
const DETACH_AFTER_NO_AUDIO_AFTER_MS = 30000;
const NUM_RATE_SAMPLES_FOR_SILENCE_DETECTION = 30;

// Bytes per ms below of which is considered silence.
const SILENCE_DETECTION_BYTE_RATE = 3.0;

function setPositionalAudioProperties(audio, settings) {
  const enableFalloff = window.APP.store.state.preferences.audioOutputMode !== "audio";
  audio.setDistanceModel(settings.avatarDistanceModel);
  audio.setMaxDistance(settings.avatarMaxDistance);
  audio.setRefDistance(enableFalloff ? settings.avatarRefDistance : 10000);
  audio.setRolloffFactor(enableFalloff ? settings.avatarRolloffFactor : 0);
  audio.setDirectionalCone(360, 0, 0);
}

const BYTE_RECEIVE_CHECK_INTERVAL = 250;
const MIN_VOLUME_THRESHOLD = 0.08;

const tmpLevels = new Uint8Array(32);

const getVolume = (analyser, prevVolume) => {
  const levels = tmpLevels;

  const newRawVolume = calculateVolume(analyser, levels);

  const newPerceivedVolume = Math.log(THREE.Math.mapLinear(newRawVolume, 0, 1, 1, Math.E));

  const volume = newPerceivedVolume < MIN_VOLUME_THRESHOLD ? 0 : newPerceivedVolume;

  const s = volume > prevVolume ? 0.35 : 0.3;
  return s * volume + (1 - s) * prevVolume;
};

// This system sets things up to re-use positional audio nodes in the web audio
// API across avatars. At most, MAX_SOURCES audio nodes will be created, and will
// be assigned to the top N avatars sorted by the last time we saw bytes come
// in from their media stream.
export class AvatarAudioTrackSystem {
  constructor(sceneEl) {
    this.sceneEl = sceneEl;
    this.mediaStreamDestinations = Array(MAX_SOURCES).fill(null);
    this.mediaStreamSources = Array(MAX_SOURCES).fill(null);
    this.audioNodes = new Array(MAX_SOURCES).fill(null);
    this.analysers = new Array(MAX_SOURCES).fill(null);
    this.volumes = new Array(MAX_SOURCES).fill(0);
    this.entityToSourceIndex = new Map();
    this.sourceIndexToEntity = new Map();
    this.entities = Array(MAX_TARGETS).fill(null);
    this.entityToSessionId = new Map();
    this.entityLastBytesReceived = Array(MAX_TARGETS).fill(0);
    this.entityLastBytesReceivedRates = Array(MAX_TARGETS).fill(null);
    this.entityLastBytesReceivedAt = Array(MAX_TARGETS).fill(0);
    this.entityLastPresumedSpeakingAt = Array(MAX_TARGETS).fill(0);
    this.entityLastPresumedSpeakingAtSorted = [];
    this.entityLastByteReceivedCheckedAt = Array(MAX_TARGETS).fill(0);
    this.isUpdatingReceivedAtTimestamps = false;
    this.tracks = Array(MAX_TARGETS).fill(null);
    this.sourceCount = 0;
    this.maxEntityIndex = -1;
    this.audioSettings = {};
    this.maxEarshotDistanceSq = null;
    this.avatarRig = null;
    this.lastAssignEntitiesPresumedSpeakingSinceSince = 0;

    // Run when backgrounded
    let running = false;

    setInterval(() => {
      if (running) return;

      running = true;

      try {
        this.tick();
      } finally {
        running = false;
      }
    }, 1000);
  }

  hasAudioFalloff() {
    if (!this.audioSettings) return true;
    return this.audioSettings.avatarRolloffFactor > 0;
  }

  getMaxEarshotDistanceSq() {
    if (this.maxEarshotDistanceSq !== null) return this.maxEarshotDistanceSq;

    if (this.audioSettings.avatarDistanceModel !== "inverse") return Infinity;
    const refDist = this.audioSettings.avatarRefDistance;
    const rolloff = this.audioSettings.avatarRolloffFactor;

    // Formula: refDistance / (refDistance + rolloffFactor * (Math.max(distance, refDistance) - refDistance))
    // max distance is assumed to be when volume is cut by 20x
    // 19 * ref = rolloff * (dist - refDist)
    // 19 * ref / rolloff = dist - refDist
    // 19 * ref / rolloff + ref = dist

    const d = (19 * refDist) / rolloff + refDist;
    this.maxEarshotDistanceSq = d * d;
    return this.maxEarshotDistanceSq;
  }

  updateAudioSettings(audioSettings) {
    this.audioSettings = audioSettings;
    this.maxEarshotDistanceSq = null;

    for (let i = 0; i < this.sourceCount; i++) {
      setPositionalAudioProperties(this.audioNodes[i], this.audioSettings);
    }
  }

  register(entity, sessionId) {
    const { entities, entityToSessionId } = this;

    for (let entityIndex = 0; entityIndex < MAX_TARGETS; entityIndex++) {
      if (entities[entityIndex] !== null) continue;
      entities[entityIndex] = entity;
      entityToSessionId.set(entity, sessionId);

      this.maxEntityIndex = Math.max(this.maxEntityIndex, entityIndex);
      break;
    }
  }

  unregister(entity) {
    const {
      entities,
      entityToSessionId,
      entityLastBytesReceived,
      entityLastBytesReceivedAt,
      entityLastPresumedSpeakingAt,
      entityLastByteReceivedCheckedAt,
      entityLastBytesReceivedRates,
      tracks
    } = this;
    const entityIndex = entities.indexOf(entity);
    if (entityIndex === -1) return;

    entityToSessionId.delete(entity);
    entities[entityIndex] = null;
    entityLastBytesReceived[entityIndex] = 0;
    entityLastBytesReceivedAt[entityIndex] = 0;
    entityLastPresumedSpeakingAt[entityIndex] = 0;
    entityLastByteReceivedCheckedAt[entityIndex] = 0;
    entityLastBytesReceivedRates[entityIndex] = null;
    tracks[entityIndex] = null;

    if (this.maxEntityIndex === entityIndex) {
      this.maxEntityIndex = -1;

      for (let i = 0; i < entityIndex; i++) {
        if (entities[i] !== null) {
          this.maxEntityIndex = i;
        }
      }
    }

    this.detachEntityFromSource(entity);
  }

  tick() {
    if (this.maxEntityIndex === -1) return;

    if (this.avatarRig === null) {
      this.avatarRig = document.querySelector("#avatar-rig");
      if (!this.avatarRig) this.avatarRig = null;
    }

    const {
      entityLastPresumedSpeakingAtSorted,
      entities,
      entityLastPresumedSpeakingAt,
      volumes,
      analysers,
      tracks,
      entityToSessionId
    } = this;

    this.updateLastReceivedAtTimestamps();

    // Take the last received at timestamp of the top K'th entity and assign those.
    // IOW, the top K sources that have been heard most recently will be assigned output nodes
    entityLastPresumedSpeakingAtSorted.length = 0;
    for (let i = 0, max = this.maxEntityIndex; i <= max; i++) {
      if (entities[i] === null) continue;
      if (entityLastPresumedSpeakingAt[i] === 0) continue;
      if (!this.isInEarShot(entities[i])) continue;

      entityLastPresumedSpeakingAtSorted.push(entityLastPresumedSpeakingAt[i]);

      // Assign/revoke tracks
      const entity = entities[i];
      const sessionId = entityToSessionId.get(entity);

      const track = NAF.connection.adapter.getMediaTrackSync(sessionId, "audio");

      if (track !== null && tracks[i] !== track) {
        this.updateTrack(entity, track, sessionId);
      }
    }

    // Just assign all the entities until we use up the sources, then start
    // filtering and dynamically assigning them based on last received at date.
    const shouldAssignAllEntities = this.maxEntityIndex < MAX_SOURCES - 2;

    if (entityLastPresumedSpeakingAtSorted.length > 0 || shouldAssignAllEntities) {
      let assignEntitiesPresumedSpeakingSinceSince = 0;

      if (!shouldAssignAllEntities) {
        entityLastPresumedSpeakingAtSorted.sort();

        assignEntitiesPresumedSpeakingSinceSince =
          entityLastPresumedSpeakingAtSorted[Math.max(entityLastPresumedSpeakingAtSorted.length - MAX_SOURCES, 0)];
      }

      this.lastAssignEntitiesPresumedSpeakingSinceSince = assignEntitiesPresumedSpeakingSinceSince;
      this.ensureEntitiesAreAssignedPresumedSpeakingSince(assignEntitiesPresumedSpeakingSinceSince);
    }

    for (let sourceIndex = 0; sourceIndex < MAX_SOURCES; sourceIndex++) {
      const analyser = analysers[sourceIndex];
      if (analyser === null) break;
      volumes[sourceIndex] = getVolume(analyser, volumes[sourceIndex]);
    }
  }

  getAnalyserForEntityIfLive(entity) {
    const { entityToSourceIndex, analysers } = this;
    if (!entityToSourceIndex.has(entity)) return null;

    return analysers[entityToSourceIndex.get(entity)];
  }

  getAudioForEntityIfLive(entity) {
    const { entityToSourceIndex, audioNodes } = this;
    if (!entityToSourceIndex.has(entity)) return null;

    return audioNodes[entityToSourceIndex.get(entity)];
  }

  isSessionIdLive(sessionId) {
    const { sourceIndexToEntity, entityToSessionId } = this;

    for (let sourceIndex = 0; sourceIndex < MAX_SOURCES; sourceIndex++) {
      if (!sourceIndexToEntity.has(sourceIndex)) continue;
      const entity = sourceIndexToEntity.get(sourceIndex);
      const entitySessionId = entityToSessionId.get(entity);
      if (entitySessionId === sessionId) return true;
    }

    return false;
  }

  getVolumeForSessionId(sessionId) {
    const { sourceIndexToEntity, entityToSessionId, volumes } = this;

    for (let sourceIndex = 0; sourceIndex < MAX_SOURCES; sourceIndex++) {
      if (!sourceIndexToEntity.has(sourceIndex)) continue;
      const entity = sourceIndexToEntity.get(sourceIndex);
      const entitySessionId = entityToSessionId.get(entity);
      if (entitySessionId === sessionId) return volumes[sourceIndex];
    }

    return 0;
  }

  async updateLastReceivedAtTimestamps() {
    if (this.isUpdatingReceivedAtTimestamps) return;
    this.isUpdatingReceivedAtTimestamps = true;

    try {
      const {
        entities,
        entityToSessionId,
        entityLastBytesReceived,
        entityLastByteReceivedCheckedAt,
        entityLastBytesReceivedAt,
        entityLastPresumedSpeakingAt,
        entityLastBytesReceivedRates
      } = this;

      // Go through all entities and check for received bytes
      const now = performance.now();

      for (let entityIndex = 0; entityIndex <= this.maxEntityIndex; entityIndex++) {
        if (entities[entityIndex] === null) continue;

        const entity = entities[entityIndex];
        const sessionId = entityToSessionId.get(entity);
        const lastCheckedAt = entityLastByteReceivedCheckedAt[entityIndex];

        if (now - lastCheckedAt < BYTE_RECEIVE_CHECK_INTERVAL) continue;

        entityLastByteReceivedCheckedAt[entityIndex] = now;

        // Hacky :P
        let muted = false;
        let n = this.entities[entityIndex];
        do {
          const playerInfo = n.components["player-info"];
          if (playerInfo) {
            muted = playerInfo.data.muted;
            break;
          }

          n = n.parentEl;
        } while (n);

        if (muted) continue;

        const bytesReceived = await NAF.connection.adapter.getAudioBytesReceivedFromClient(sessionId);
        const lastBytesReceived = entityLastBytesReceived[entityIndex];

        if (bytesReceived > lastBytesReceived) {
          let rates = entityLastBytesReceivedRates[entityIndex];

          if (entityLastBytesReceivedAt[entityIndex] !== 0) {
            if (rates === null) {
              rates = entityLastBytesReceivedRates[entityIndex] = [];
            }

            rates.push(((bytesReceived - lastBytesReceived) * 1.0) / (now - entityLastBytesReceivedAt[entityIndex]));

            while (rates.length > NUM_RATE_SAMPLES_FOR_SILENCE_DETECTION) {
              rates.shift();
            }
          }

          entityLastBytesReceivedAt[entityIndex] = now;

          // Unless all the previous rates were silence, assume they're speaking.
          if (rates === null || rates.find(rate => rate > SILENCE_DETECTION_BYTE_RATE)) {
            entityLastPresumedSpeakingAt[entityIndex] = now;
          }
        }

        entityLastBytesReceived[entityIndex] = bytesReceived;
      }
    } finally {
      this.isUpdatingReceivedAtTimestamps = false;
    }
  }

  updateTrack(entity, track, sessionId) {
    const {
      entityToSourceIndex,
      entityToSessionId,
      mediaStreamSources,
      mediaStreamDestinations,
      analysers,
      entities,
      tracks,
      audioNodes
    } = this;
    const entityIndex = entities.indexOf(entity);
    if (entityIndex === -1) return;
    if (tracks[entityIndex] === track) return;

    tracks[entityIndex] = track;
    entityToSessionId.set(entity, sessionId);

    if (!entityToSourceIndex.has(entity)) return;
    const sourceIndex = entityToSourceIndex.get(entity);

    let mediaStreamSource = mediaStreamSources[sourceIndex];

    if (mediaStreamSource) {
      mediaStreamSource.disconnect();
    }

    const mediaStream = new MediaStream();
    mediaStream.addTrack(track);
    mediaStreamSource = audioNodes[sourceIndex].context.createMediaStreamSource(mediaStream);
    mediaStreamSources[sourceIndex] = mediaStreamSource;
    mediaStreamSource.connect(mediaStreamDestinations[sourceIndex]);
    mediaStreamSource.connect(analysers[sourceIndex]);
  }

  attachEntityToSource(entity, sourceIndex) {
    const {
      entities,
      audioNodes,
      tracks,
      analysers,
      mediaStreamSources,
      mediaStreamDestinations,
      entityToSourceIndex,
      sourceIndexToEntity
    } = this;

    const entityIndex = entities.indexOf(entity);

    if (entityIndex === -1) {
      console.error("Entity not registered", entity);
      return;
    }

    if (entityToSourceIndex.has(entity)) return;

    if (sourceIndexToEntity.has(sourceIndex)) {
      if (sourceIndexToEntity.get(sourceIndex) !== entity) {
        console.error("Trying to attach to source that is already attached", sourceIndex);
      }

      return;
    }

    entityToSourceIndex.set(entity, sourceIndex);
    sourceIndexToEntity.set(sourceIndex, entity);

    let mediaStreamSource = mediaStreamSources[sourceIndex];

    if (mediaStreamSource) {
      mediaStreamSource.disconnect();
      mediaStreamSources[sourceIndex] = null;
    }

    const audio = audioNodes[sourceIndex];

    if (tracks[entityIndex]) {
      const mediaStream = new MediaStream();
      mediaStream.addTrack(tracks[entityIndex]);

      mediaStreamSource = audio.context.createMediaStreamSource(mediaStream);
      mediaStreamSources[sourceIndex] = mediaStreamSource;
      mediaStreamSource.connect(mediaStreamDestinations[sourceIndex]);
      mediaStreamSource.connect(analysers[sourceIndex]);
    }

    entity.setObject3D("positional-audio", audio);
    audio.updateMatrixWorld();
  }

  detachEntityFromSource(entity) {
    const { mediaStreamSources, entityToSourceIndex, sourceIndexToEntity, volumes } = this;

    if (!entityToSourceIndex.has(entity)) return;
    const sourceIndex = entityToSourceIndex.get(entity);

    const mediaStreamSource = mediaStreamSources[sourceIndex];

    if (mediaStreamSource) {
      mediaStreamSource.disconnect();
    }

    mediaStreamSources[sourceIndex] = null;

    entity.removeObject3D("positional-audio");
    entityToSourceIndex.delete(entity);
    sourceIndexToEntity.delete(sourceIndex);
    volumes[sourceIndex] = 0;
  }

  ensureEntitiesAreAssignedPresumedSpeakingSince(assignEntitiesSpeakingSince) {
    const { entities, entityLastPresumedSpeakingAt, sourceIndexToEntity, entityToSourceIndex } = this;
    const now = performance.now();

    // Detach entities not heard since the cutoff
    for (let entityIndex = 0; entityIndex <= this.maxEntityIndex; entityIndex++) {
      if (entities[entityIndex] === null) continue;
      const entity = entities[entityIndex];
      if (!entityToSourceIndex.has(entity)) continue;
      if (
        entityLastPresumedSpeakingAt[entityIndex] < assignEntitiesSpeakingSince ||
        (entityLastPresumedSpeakingAt[entityIndex] !== 0 &&
          now - entityLastPresumedSpeakingAt[entityIndex] > DETACH_AFTER_NO_AUDIO_AFTER_MS)
      ) {
        this.detachEntityFromSource(entities[entityIndex]);
      }
    }

    // Attach entities
    for (let entityIndex = 0; entityIndex <= this.maxEntityIndex; entityIndex++) {
      if (entities[entityIndex] === null) continue;
      if (!this.isInEarShot(entities[entityIndex])) continue;

      const entity = entities[entityIndex];
      if (entityToSourceIndex.has(entity)) continue;

      if (
        entityLastPresumedSpeakingAt[entityIndex] >= assignEntitiesSpeakingSince &&
        (entityLastPresumedSpeakingAt[entityIndex] === 0 ||
          now - entityLastPresumedSpeakingAt[entityIndex] < DETACH_AFTER_NO_AUDIO_AFTER_MS)
      ) {
        if (this.sourceCount < MAX_SOURCES && this.sourceCount <= entityToSourceIndex.size) {
          this.createSource();
        }

        for (let sourceIndex = 0; sourceIndex < this.sourceCount; sourceIndex++) {
          if (sourceIndexToEntity.has(sourceIndex)) continue;
          this.attachEntityToSource(entity, sourceIndex);
          break;
        }

        if (entityToSourceIndex.size >= MAX_SOURCES) break;
      }
    }
  }

  createSource() {
    const audioListener = this.sceneEl.audioListener;
    const audio = new THREE.PositionalAudio(audioListener);

    setPositionalAudioProperties(audio, this.audioSettings);
    audio.panner.panningModel = "equalpower";

    const destination = audioListener.context.createMediaStreamDestination();
    const destinationSource = audioListener.context.createMediaStreamSource(destination.stream);
    const analyser = audioListener.context.createAnalyser();
    analyser.fftSize = 32;
    audio.setNodeSource(destinationSource);

    this.analysers[this.sourceCount] = analyser;
    this.mediaStreamDestinations[this.sourceCount] = destination;
    this.audioNodes[this.sourceCount] = audio;
    this.sourceCount++;
  }

  isInEarShot(entity) {
    if (this.avatarRig === null) return true;
    const ap = this.avatarRig.object3D.position;
    const ep = entity.object3D.parent.parent.parent.parent.position;
    const dx = ap.x - ep.x;
    const dy = ap.y - ep.y;
    const dz = ap.z - ep.z;
    const dist = dx * dx + dy * dy + dz * dz;

    return dist <= this.getMaxEarshotDistanceSq();
  }

  toDump(entity, indent) {
    const {
      entities,
      mediaStreamSources,
      audioNodes,
      volumes,
      entityToSourceIndex,
      entityLastBytesReceived,
      entityLastBytesReceivedAt,
      entityLastBytesReceivedRates,
      entityLastPresumedSpeakingAt,
      entityLastByteReceivedCheckedAt,
      tracks
    } = this;

    let entityIndex = -1;

    for (let i = 0; i < MAX_TARGETS; i++) {
      if (entities[i] !== entity) continue;
      entityIndex = i;
    }

    if (entityIndex === -1) {
      return `${indent} ats: no reg\n`;
    }

    let s = "";

    const sourceIndex = entityToSourceIndex.get(entity);
    const mediaStreamSource = mediaStreamSources[sourceIndex];

    s += `${indent} ats\n`;
    s += `${indent}   midx: ${this.maxEntityIndex}\n`;
    s += `${indent}   asince: ${this.lastAssignEntitiesPresumedSpeakingSinceSince}\n`;
    s += `${indent}   eidx: ${entityIndex}\n`;
    s += `${indent}   sidx: ${sourceIndex}\n`;
    s += `${indent}   recv: ${entityLastBytesReceived[entityIndex]}\n`;
    s += `${indent}   recvr: ${entityLastBytesReceivedRates[entityIndex]}\n`;
    s += `${indent}   recvat: ${entityLastBytesReceivedAt[entityIndex]}\n`;
    s += `${indent}   recvck: ${entityLastByteReceivedCheckedAt[entityIndex]}\n`;
    s += `${indent}   spkat: ${entityLastPresumedSpeakingAt[entityIndex]}\n`;
    s += `${indent}   vol: ${volumes[sourceIndex]}\n`;
    s += `${indent}   isaudio: ${entity.getObject3D("positional-audio") === audioNodes[sourceIndex]}\n`;
    s += `${indent}   earshot: ${this.isInEarShot(entity)}\n`;

    if (mediaStreamSource) {
      const mediaStream = mediaStreamSource.mediaStream;
      const audioTracks = mediaStream.getAudioTracks();

      s += `${indent}   tracks: \n`;
      for (let i = 0; i < audioTracks.length; i++) {
        const track = audioTracks[i];
        s += `${indent}     id: ${track.id}\n`;
        s += `${indent}     selected: ${track === tracks[entityIndex]}\n`;
        s += `${indent}     enabled: ${track.enabled}\n`;
        s += `${indent}     kind: ${track.kind}\n`;
        s += `${indent}     muted: ${track.muted}\n`;
        s += `${indent}     readyState: ${track.readyState}\n`;
      }
    } else {
      s += `${indent}   notracks\n`;
    }

    return s;
  }
}

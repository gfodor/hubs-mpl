const MIC_PRESENCE_VOLUME_THRESHOLD = 0.00001;

export const getMicrophonePresences = (() => {
  const microphonePresences = new Map();
  const sessionIds = [];
  const currentSessionIds = [];
  return function() {
    if (!window.APP || !window.APP.componentRegistry) {
      return null;
    }

    const sceneEl = AFRAME.scenes[0];

    currentSessionIds.length = 0;
    const avatarAudioTrackSystem = sceneEl.systems["hubs-systems"].avatarAudioTrackSystem;

    const playerInfos = window.APP.componentRegistry["player-info"];
    if (playerInfos) {
      for (let i = 0; i < playerInfos.length; i++) {
        const playerInfo = playerInfos[i];
        const playerSessionId = playerInfo.playerSessionId;
        let talking = false;
        if (playerInfo.isLocalPlayerInfo) {
          talking = sceneEl.systems["local-audio-analyser"].volume > MIC_PRESENCE_VOLUME_THRESHOLD;
        } else {
          talking = avatarAudioTrackSystem.getVolumeForSessionId(playerSessionId) > 0;
        }
        if (sessionIds.indexOf(playerSessionId) === -1) {
          sessionIds.push(playerSessionId);
        }
        currentSessionIds.push(playerSessionId);
        if (microphonePresences.has(playerSessionId)) {
          const presence = microphonePresences.get(playerSessionId);
          presence.muted = playerInfo.data.muted;
          presence.talking = talking;
        } else {
          microphonePresences.set(playerSessionId, { muted: playerInfo.data.muted, talking });
        }
      }
    }

    for (let i = sessionIds.length - 1; i >= 0; i--) {
      const sessionId = sessionIds[i];
      if (currentSessionIds.indexOf(sessionId) === -1) {
        microphonePresences.delete(sessionId);
        sessionIds.splice(i, 1);
      }
    }

    return microphonePresences;
  };
})();

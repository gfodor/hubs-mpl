/* global APP*/
import { getReticulumFetchUrl, hubUrl } from "./utils/phoenix-utils";
import { updateEnvironmentForHub, getSceneUrlForHub, updateUIForHub, remountUI } from "./hub";

const qs = new URLSearchParams(location.search);
import qsTruthy from "./utils/qs_truthy";

const isBotMode = qsTruthy("bot");

function unloadRoomObjects() {
  document.querySelectorAll("[pinnable]").forEach(el => {
    if (el.components.pinnable.data.pinned) {
      el.parentNode.removeChild(el);
    }
  });

  // Clean up empty object.gltf nodes
  document.querySelectorAll("#objects-scene .Room_Objects").forEach(el => {
    if (!el.children.length) {
      el.parentNode.parentNode.removeChild(el.parentNode);
    }
  });
}

function loadRoomObjects(hubId) {
  const objectsScene = document.querySelector("#objects-scene");
  const objectsUrl = getReticulumFetchUrl(`/${hubId}/objects.gltf`);
  const objectsEl = document.createElement("a-entity");
  objectsEl.setAttribute("gltf-model-plus", { src: objectsUrl, useCache: false, inflate: true });
  objectsScene.appendChild(objectsEl);
}

let isChanging = false;

export async function changeHub(hubId, addToHistory = true) {
  if (isChanging) return;
  isChanging = true;

  APP.suppressPresenceMessages = true;
  const scene = AFRAME.scenes[0];

  let data;
  try {
    data = await APP.hubChannel.migrateToHub(hubId);
  } catch (e) {
    console.warn(`Failed to join hub ${hubId}: ${e.reason}|${e.message}`);
    APP.suppressPresenceMessages = false;
    APP.messageDispatch.log("joinFailed", { message: e.message });
    isChanging = false;
    return;
  }

  const hub = data.hubs[0];

  if (addToHistory) {
    window.history.pushState(null, null, hubUrl(hubId, {}, hub.slug));
  }

  APP.hub = hub;
  updateUIForHub(hub, APP.hubChannel);
  scene.emit("hub_updated", { hub });

  APP.subscriptions.setSubscribed(data.subscriptions.web_push);

  remountUI({
    hubIsBound: data.hub_requires_oauth,
    initialIsFavorited: data.subscriptions.favorites
  });

  const micState = !scene.is("muted");
  await APP.mediaDevicesManager.stopMicShare();
  NAF.entities.removeRemoteEntities();
  await NAF.connection.adapter.disconnect();
  unloadRoomObjects();
  NAF.connection.connectedClients = {};
  NAF.connection.activeDataChannels = {};

  NAF.room = hub.hub_id;
  NAF.connection.adapter.setServerUrl(`wss://${hub.host}:${hub.port}`);
  NAF.connection.adapter.setRoom(hub.hub_id);
  // TODO does this need to look at oauth token? It isnt in prod
  NAF.connection.adapter.setJoinToken(data.perms_token);
  // TODO ostn, maybe broken due to AWS outage?
  //NAF.connection.adapter.setServerParams(await APP.hubChannel.getHost());

  const fader = document.getElementById("viewing-camera").components["fader"];

  if (
    document.querySelector("#environment-scene").childNodes[0].components["gltf-model-plus"].data.src !==
    (await getSceneUrlForHub(hub))
  ) {
    fader.fadeOut().then(() => {
      scene.emit("reset_scene");
      updateEnvironmentForHub(hub, APP.entryManager);
    });
  } else {
    fader.fadeOut().then(() => {
      setTimeout(() => {
        fader.fadeIn();
      }, 1000);
    });
  }

  APP.retChannel.push("change_hub", { hub_id: hub.hub_id });

  NAF.connection.adapter.connect().then(async function() {
    if (!isBotMode) {
      await APP.mediaDevicesManager.startMicShare();
      NAF.connection.adapter.enableMicrophone(micState);
    } else {
      const audioEl = document.getElementById("bot-audio-el");

      const audioStream = audioEl.captureStream
        ? audioEl.captureStream()
        : audioEl.mozCaptureStream
          ? audioEl.mozCaptureStream()
          : null;

      if (audioStream) {
        let audioVolume = Number(qs.get("audio_volume") || "1.0");
        if (isNaN(audioVolume)) {
          audioVolume = 1.0;
        }
        const audioContext = THREE.AudioContext.getContext();
        const audioSource = audioContext.createMediaStreamSource(audioStream);
        const audioDestination = audioContext.createMediaStreamDestination();
        const gainNode = audioContext.createGain();
        audioSource.connect(gainNode);
        gainNode.connect(audioDestination);
        gainNode.gain.value = audioVolume;
        for (const track of APP.mediaDevicesManager.mediaStream.getAudioTracks()) {
          APP.mediaDevicesManager.mediaStream.removeTrack(track);
        }

        APP.mediaDevicesManager.mediaStream.addTrack(audioDestination.stream.getAudioTracks()[0]);
      }

      await NAF.connection.adapter.setLocalMediaStream(APP.mediaDevicesManager.mediaStream);

      NAF.connection.adapter.enableMicrophone(true);
    }

    loadRoomObjects(hubId);

    APP.hubChannel.sendEnteredEvent();

    APP.messageDispatch.receive({
      type: "hub_changed",
      hubName: hub.name,
      showLineBreak: true
    });
    APP.suppressPresenceMessages = false;
    isChanging = false;
  });
}
window.changeHub = changeHub;

// TODO see if there is a better way to do this with react router
window.addEventListener("popstate", function() {
  if (!APP.store.state.preferences.fastRoomSwitching) return;
  const qs = new URLSearchParams(location.search);
  const newHubId = qs.get("hub_id") || document.location.pathname.substring(1).split("/")[0];
  if (newHubId !== APP.hub.hub_id) {
    changeHub(newHubId, false);
  }
});

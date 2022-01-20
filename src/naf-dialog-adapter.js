import * as mediasoupClient from "mediasoup-client";
import protooClient from "protoo-client";
import { debug as newDebug } from "debug";
import EventEmitter from "eventemitter3";
import { stringify as uuidStringify } from "uuid";

import qsTruthy from "./utils/qs_truthy";

const skipLipsync = qsTruthy("skip_lipsync");
const spawnModsOnly = qsTruthy("mods_only");

const presenceForSessionId = session_id =>
  window.APP.hubChannel &&
  window.APP.hubChannel.presence &&
  window.APP.hubChannel.presence.state &&
  window.APP.hubChannel.presence.state[session_id];

// If the browser supports insertable streams, we insert a 5 byte payload at the end of the voice
// frame encoding 4 magic bytes and 1 viseme byte. This is a hack because on older browsers
// this data will be injested into the codec, but since the values are near zero it seems to have
// minimal effect. (Eventually all browsers will support insertable streams.)
const supportsInsertableStreams = !!(window.RTCRtpSender && !!RTCRtpSender.prototype.createEncodedStreams);
const visemeMagicBytes = [0x00, 0x00, 0x00, 0x01]; // Bytes to add to end of frame to indicate a viseme will follow

// NOTE this adapter does not properly fire the onOccupantsReceived events since those are only needed for
// data channels, which are not yet supported. To fire that event, this class would need to keep a list of
// occupants around and manage it.
//
// Used for VP9 webcam video.
//const VIDEO_KSVC_ENCODINGS = [{ scalabilityMode: "S3T3_KEY" }];

// Used for VP9 desktop sharing.
//const VIDEO_SVC_ENCODINGS = [{ scalabilityMode: "S3T3", dtx: true }];

// TODO
// - look into requestConsumerKeyframe
// - look into applyNetworkThrottle
// SFU todo
// - remove active speaker stuff
// - remove score stuff

// Based upon mediasoup-demo RoomClient

const debug = newDebug("naf-dialog-adapter:debug");
//const warn = newDebug("naf-dialog-adapter:warn");
const error = newDebug("naf-dialog-adapter:error");
const info = newDebug("naf-dialog-adapter:info");

const PC_PROPRIETARY_CONSTRAINTS = {
  optional: [{ googDscp: true }]
};

const WEBCAM_SIMULCAST_ENCODINGS = [
  { scaleResolutionDownBy: 4, maxBitrate: 500000 },
  { scaleResolutionDownBy: 2, maxBitrate: 1000000 },
  { scaleResolutionDownBy: 1, maxBitrate: 5000000 }
];

// Used for simulcast screen sharing.
const SCREEN_SHARING_SIMULCAST_ENCODINGS = [{ dtx: true, maxBitrate: 1500000 }, { dtx: true, maxBitrate: 6000000 }];

let nonAuthorizedProperties = null;
function initializeNonAuthorizedProperties() {
  /*
  Takes the NAF schemas defined in network-schemas.js and produces a data structure of template name to non-authorized
  component indices:
  {
    "#interactable-media": { 5 => [], 6 => ["x", "y, "z"] }
  }

  Empty array signifies all properties
  */
  nonAuthorizedProperties = new Map();
  const { schemaDict } = NAF.schemas;
  for (const [template, schema] of Object.entries(schemaDict)) {
    if (!schema.nonAuthorizedComponents) continue;

    for (const schemaEntry of schema.nonAuthorizedComponents) {
      let map = nonAuthorizedProperties.get(template);

      if (!map) {
        map = new Map();
        nonAuthorizedProperties.set(template, map);
      }

      if (typeof schemaEntry === "string") {
        const component = schemaEntry;
        map.set(component, []);
      } else if (typeof schemaEntry === "object") {
        const component = schemaEntry.component;
        if (!map.has(component)) {
          map.set(component, []);
        }

        map.get(component).push(schemaEntry.property);
      }
    }
  }
}

export default class DialogAdapter extends EventEmitter {
  constructor() {
    super();

    this._timeOffsets = [];
    this._micProducer = null;
    this._cameraProducer = null;
    this._shareProducer = null;
    this._mediaStreams = {};
    this._localMediaStream = null;
    this._consumers = new Map();
    this._peerIdToConsumers = new Map();
    this._pendingMediaRequests = new Map();
    this._micEnabled = true;
    this._initialAudioConsumerPromise = null;
    this._initialAudioConsumerResolvers = new Map();
    this._serverTimeRequests = 0;
    this._closeMicProducerTimeout = null;
    this._avgTimeOffset = 0;
    this._blockedClients = new Map();
    this.type = "dialog";
    this.occupants = {}; // This is a public field
    this._forceTcp = false;
    this._forceTurn = false;
    this._iceTransportPolicy = "all";
    this._closed = true;
    this.scene = document.querySelector("a-scene");
    this._serverParams = {};
    this._consumerStats = {};
    this._isReconnect = false;
    this._outgoingVisemeBuffer = null;
    this._visemeMap = new Map();
    this._visemeTimestamps = new Map();
    this._messageCount = 0;
    this._updatingProducers = false;

    const showTps = qsTruthy("show_netstats");

    if (showTps) {
      setInterval(() => {
        console.log("TPS: ", this._messageCount, "Buffer:", this.scene.systems.networked.incomingData.length);
        this._messageCount = 0;
      }, 1000);
    }
  }

  hasPendingInitialConsumers() {
    return this._initialAudioConsumerResolvers.size > 0;
  }

  setOutgoingVisemeBuffer(buffer) {
    this._outgoingVisemeBuffer = buffer;
  }

  getCurrentViseme(peerId) {
    if (!this._visemeMap.has(peerId)) return 0;

    // If last viseme was longer than 1s ago, the producer was paused.
    if (this._visemeTimestamps.has(peerId) && performance.now() - 1000 >= this._visemeTimestamps.get(peerId)) return 0;

    return this._visemeMap.get(peerId);
  }

  get consumerStats() {
    return this._consumerStats;
  }

  get downlinkBwe() {
    return this._downlinkBwe;
  }

  get serverUrl() {
    return this._serverUrl;
  }

  setServerUrl(url) {
    this._serverUrl = url;
  }

  setJoinToken(joinToken) {
    this._joinToken = joinToken;
  }

  setTurnConfig(forceTcp, forceTurn) {
    this._forceTcp = forceTcp;
    this._forceTurn = forceTurn;

    if (this._forceTurn || this._forceTcp) {
      this._iceTransportPolicy = "relay";
    }
  }

  setServerParams(params) {
    this._serverParams = params;
  }

  getIceServers(host, port, turn) {
    const iceServers = [];

    this._serverUrl = `wss://${host}:${port}`;

    if (turn && turn.enabled) {
      turn.transports.forEach(ts => {
        // Try both TURN DTLS and TCP/TLS
        if (!this._forceTcp) {
          iceServers.push({
            urls: `turns:${host}:${ts.port}`,
            username: turn.username,
            credential: turn.credential
          });
        }

        iceServers.push({
          urls: `turns:${host}:${ts.port}?transport=tcp`,
          username: turn.username,
          credential: turn.credential
        });
      });
      iceServers.push({ urls: "stun:stun1.l.google.com:19302" });
    } else {
      iceServers.push({ urls: "stun:stun1.l.google.com:19302" }, { urls: "stun:stun2.l.google.com:19302" });
    }

    return iceServers;
  }

  setApp() {}

  setRoom(roomId) {
    this._roomId = roomId;
  }

  setClientId(clientId) {
    this._clientId = clientId;
  }

  setServerConnectListeners(successListener, failureListener) {
    this._connectSuccess = successListener;
    this._connectFailure = failureListener;
  }

  setRoomOccupantListener(occupantListener) {
    this._onOccupantsChanged = occupantListener;
  }

  setDataChannelListeners(openListener, closedListener, messageListener) {
    this._onOccupantConnected = openListener;
    this._onOccupantDisconnected = closedListener;
    this._onOccupantMessage = messageListener;
  }

  /**
   * Gets transport/consumer/producer stats on the server side.
   */
  async getServerStats() {
    if (this.getConnectStatus() === NAF.adapters.NOT_CONNECTED) {
      // Signaling channel not connected, no reason to get remote RTC stats.
      return;
    }

    const result = {};
    try {
      if (!this._sendTransport?._closed) {
        const sendTransport = (result[this._sendTransport.id] = {});
        sendTransport.name = "Send";
        sendTransport.stats = await this._protoo.request("getTransportStats", {
          transportId: this._sendTransport.id
        });
        result[this._sendTransport.id]["producers"] = {};
        for (const producer of this._sendTransport._producers) {
          const id = producer[0];
          result[this._sendTransport.id]["producers"][id] = await this._protoo.request("getProducerStats", {
            producerId: id
          });
        }
      }
      if (!this._recvTransport?._closed) {
        const recvTransport = (result[this._recvTransport.id] = {});
        recvTransport.name = "Receive";
        recvTransport.stats = await this._protoo.request("getTransportStats", {
          transportId: this._recvTransport.id
        });
        result[this._recvTransport.id]["consumers"] = {};
        for (const consumer of this._recvTransport._consumers) {
          const id = consumer[0];
          result[this._recvTransport.id]["consumers"][id] = await this._protoo.request("getConsumerStats", {
            consumerId: id
          });
        }
      }
      return result;
    } catch (e) {
      this.emitRTCEvent("error", "Adapter", () => `Error getting the server status: ${e}`);
      return { error: `Error getting the server status: ${e}` };
    }
  }

  async iceRestart(transport) {
    // Force an ICE restart to gather new candidates and trigger a reconnection
    this.emitRTCEvent(
      "log",
      "RTC",
      () => `Restarting ${transport.id === this._sendTransport.id ? "send" : "receive"} transport ICE`
    );
    const iceParameters = await this._protoo.request("restartIce", { transportId: transport.id });
    await transport.restartIce({ iceParameters });
  }

  async recreateSendTransport(iceServers) {
    this.emitRTCEvent("log", "RTC", () => `Recreating send transport ICE`);
    await this.closeSendTransport();
    await this.createSendTransport(iceServers);
  }

  /**
   * Restart ICE in the underlying send peerconnection.
   */
  async restartSendICE() {
    // Do not restart ICE if Signaling is disconnected. We are not in the meeting room if that's the case.
    if (this._closed) {
      return;
    }

    try {
      if (!this._sendTransport?._closed) {
        await this.iceRestart(this._sendTransport);
      } else {
        // If the transport is closed but the signaling is connected, we try to recreate
        const { host, port, turn } = this._serverParams;
        const iceServers = this.getIceServers(host, port, turn);
        await this.recreateSendTransport(iceServers);
      }
    } catch (err) {
      this.emitRTCEvent("error", "RTC", () => `Send transport [recreate] failed: ${err}`);
    }
  }

  /**
   * Checks the Send Transport ICE status and restarts it in case is in failed state.
   * This is called by the Send Transport "connectionstatechange" event listener.
   * @param {boolean} connectionState The transport connnection state (ICE connection state)
   */
  checkSendIceStatus(connectionState) {
    // If the ICE connection state is failed, we force an ICE restart
    if (connectionState === "failed") {
      this.restartSendICE();
    }
  }

  async recreateRecvTransport(iceServers) {
    this.emitRTCEvent("log", "RTC", () => `Recreating receive transport ICE`);
    await this.closeRecvTransport();
    await this.createRecvTransport(iceServers);
    await this.createMissingConsumers();
  }

  /**
   * Restart ICE in the underlying receive peerconnection.
   * @param {boolean} force Forces the execution of the reconnect.
   */
  async restartRecvICE() {
    // Do not restart ICE if Signaling is disconnected. We are not in the meeting room if that's the case.
    if (this._closed) {
      return;
    }

    try {
      if (!this._recvTransport?._closed) {
        await this.iceRestart(this._recvTransport);
      } else {
        // If the transport is closed but the signaling is connected, we try to recreate
        const { host, port, turn } = this._serverParams;
        const iceServers = this.getIceServers(host, port, turn);
        await this.recreateRecvTransport(iceServers);
      }
    } catch (err) {
      this.emitRTCEvent("error", "RTC", () => `Receive transport [recreate] failed: ${err}`);
    }
  }

  /**
   * Checks the ReeceiveReeceive Transport ICE status and restarts it in case is in failed state.
   * This is called by the Reeceive Transport "connectionstatechange" event listener.
   * @param {boolean} connectionState The transport connection state (ICE connection state)
   */
  checkRecvIceStatus(connectionState) {
    // If the ICE connection state is failed, we force an ICE restart
    if (connectionState === "failed") {
      this.restartRecvICE();
    }
  }

  async connect() {
    const urlWithParams = new URL(this._serverUrl);
    urlWithParams.searchParams.append("roomId", this._roomId);
    urlWithParams.searchParams.append("peerId", this._clientId);

    const protooTransport = new protooClient.WebSocketTransport(urlWithParams.toString());
    this._protoo = new protooClient.Peer(protooTransport);

    this._protoo.on("disconnected", () => {
      this.emitRTCEvent("info", "Signaling", () => `Disconnected`);
      this.disconnect();
    });

    this._protoo.on("failed", attempt => {
      this.emitRTCEvent("error", "Signaling", () => `Failed: ${attempt}, retrying...`);

      if (this._isReconnect) {
        this._reconnectingListener && this._reconnectingListener();
      }
    });

    this._protoo.on("close", () => {
      this.emitRTCEvent("error", "Signaling", () => `Closed`);
      this.disconnect();
    });

    await new Promise((resolve, reject) => {
      this._protoo.on("open", async () => {
        this.emitRTCEvent("info", "Signaling", () => `Open`);
        this._closed = false;

        // We only need to call the reconnect callbacks if it's a reconnection.
        if (this._isReconnect) {
          this._reconnectedListener && this._reconnectedListener();
        } else {
          this._isReconnect = true;
        }

        try {
          await this._joinRoom();
          resolve();
        } catch (err) {
          this.emitRTCEvent("warn", "Adapter", () => `Error during connect: ${error}`);
          reject(err);
        }
      });
    });

    // eslint-disable-next-line no-unused-vars
    this._protoo.on("request", async (request, accept, reject) => {
      this.emitRTCEvent("info", "Signaling", () => `Request [${request.method}]: ${request.data?.id}`);
      debug('proto "request" event [method:%s, data:%o]', request.method, request.data?.id);

      switch (request.method) {
        case "newConsumer": {
          const {
            peerId,
            producerId,
            id,
            kind,
            rtpParameters,
            /*type, */ appData /*, producerPaused */
          } = request.data;

          try {
            const consumer = await this._recvTransport.consume({
              id,
              producerId,
              kind,
              rtpParameters,
              appData: { ...appData, peerId } // Trick.
            });

            // Store in the map.
            this._consumers.set(consumer.id, consumer);

            if (consumer.appData.peerId) {
              let peerConsumers = this._peerIdToConsumers.get(consumer.appData.peerId);

              if (!peerConsumers) {
                peerConsumers = [];
                this._peerIdToConsumers.set(consumer.appData.peerId, peerConsumers);
              }

              peerConsumers.push(consumer);
            }

            consumer.on("transportclose", () => {
              this.emitRTCEvent("error", "RTC", () => `Consumer transport closed`);
              this.removeConsumer(consumer.id);
            });

            if (kind === "video") {
              const { spatialLayers, temporalLayers } = mediasoupClient.parseScalabilityMode(
                consumer.rtpParameters.encodings[0].scalabilityMode
              );

              this._consumerStats[consumer.id] = this._consumerStats[consumer.id] || {};
              this._consumerStats[consumer.id]["spatialLayers"] = spatialLayers;
              this._consumerStats[consumer.id]["temporalLayers"] = temporalLayers;
            }

            // We are ready. Answer the protoo request so the server will
            // resume this Consumer (which was paused for now if video).
            accept();

            this.resolvePendingMediaRequestForTrack(peerId, consumer.track);

            if (kind === "audio") {
              const initialAudioResolver = this._initialAudioConsumerResolvers.get(peerId);

              if (initialAudioResolver) {
                initialAudioResolver();
                this._initialAudioConsumerResolvers.delete(peerId);
                this.scene.emit("audio-consumer-loaded");
              }

              if (!skipLipsync && supportsInsertableStreams) {
                // Add viseme decoder
                const self = this;

                const receiverTransform = new TransformStream({
                  start() {},
                  flush() {},

                  async transform(encodedFrame, controller) {
                    if (encodedFrame.data.byteLength < visemeMagicBytes.length + 1) {
                      controller.enqueue(encodedFrame);
                    } else {
                      const view = new DataView(encodedFrame.data);
                      let hasViseme = true;

                      for (let i = 0, l = visemeMagicBytes.length; i < l; i++) {
                        if (
                          view.getUint8(encodedFrame.data.byteLength - 1 - visemeMagicBytes.length + i) !==
                          visemeMagicBytes[i]
                        ) {
                          hasViseme = false;
                        }
                      }

                      if (hasViseme) {
                        const viseme = view.getInt8(encodedFrame.data.byteLength - 1);
                        self._visemeMap.set(peerId, viseme);
                        self._visemeTimestamps.set(peerId, performance.now());

                        encodedFrame.data = encodedFrame.data.slice(
                          0,
                          encodedFrame.data.byteLength - 1 - visemeMagicBytes.length
                        );
                      }

                      controller.enqueue(encodedFrame);
                    }
                  }
                });

                const receiver = consumer.rtpReceiver;
                const receiverStreams = receiver.createEncodedStreams();
                receiverStreams.readable.pipeThrough(receiverTransform).pipeTo(receiverStreams.writable);
              }
            } else {
              // Video
              if (supportsInsertableStreams) {
                const receiverStreams = consumer.rtpReceiver.createEncodedStreams();
                receiverStreams.readable.pipeTo(receiverStreams.writable);
              }
            }

            // Notify of an stream update event
            this.emit("stream_updated", peerId, kind);
          } catch (err) {
            this.emitRTCEvent("error", "Adapter", () => `Error: ${err}`);
            error('"newConsumer" request failed:%o', err);

            throw err;
          }

          break;
        }
      }
    });

    this._protoo.on("notification", notification => {
      debug('proto "notification" event [method:%s, data:%o]', notification.method, notification.data);

      switch (notification.method) {
        case "newPeer": {
          const peer = notification.data;
          this.newPeer(peer);

          break;
        }

        case "peerClosed": {
          const { peerId } = notification.data;
          this.closePeer(peerId);

          break;
        }

        case "consumerClosed": {
          const { consumerId } = notification.data;
          const consumer = this._consumers.get(consumerId);

          if (!consumer) {
            info(`consumerClosed event received without related consumer: ${consumerId}`);
            break;
          }

          consumer.close();
          this.removeConsumer(consumer.id);

          break;
        }

        case "peerBlocked": {
          const { peerId } = notification.data;
          document.body.dispatchEvent(new CustomEvent("blocked", { detail: { clientId: peerId } }));

          break;
        }

        case "peerUnblocked": {
          const { peerId } = notification.data;
          document.body.dispatchEvent(new CustomEvent("unblocked", { detail: { clientId: peerId } }));

          break;
        }

        case "downlinkBwe": {
          this._downlinkBwe = notification.data;
          break;
        }

        case "consumerLayersChanged": {
          const { consumerId, spatialLayer, temporalLayer } = notification.data;

          const consumer = this._consumers.get(consumerId);

          if (!consumer) {
            info(`consumerLayersChanged event received without related consumer: ${consumerId}`);
            break;
          }

          this._consumerStats[consumerId] = this._consumerStats[consumerId] || {};
          this._consumerStats[consumerId]["spatialLayer"] = spatialLayer;
          this._consumerStats[consumerId]["temporalLayer"] = temporalLayer;

          // TODO: If spatialLayer/temporalLayer are null, that's probably because the current downlink
          // it's not enough forany spatial layer bitrate. In that case the server has paused the consumer.
          // At this point we it would be nice to give the user some visual cue that this stream is paused.
          // ie. A grey overlay with some icon or replacing the video stream por a generic person image.
          break;
        }

        case "consumerScore": {
          const { consumerId, score } = notification.data;

          const consumer = this._consumers.get(consumerId);

          if (!consumer) {
            info(`consumerScore event received without related consumer: ${consumerId}`);
            break;
          }

          this._consumerStats[consumerId] = this._consumerStats[consumerId] || {};
          this._consumerStats[consumerId]["score"] = score;
        }
      }
    });

    await Promise.all([this.updateTimeOffset(), this._initialAudioConsumerPromise]);
  }

  newPeer(peer) {
    this._onOccupantConnected(peer.id);
    this.occupants[peer.id] = peer;

    if (this._onOccupantsChanged) {
      this._onOccupantsChanged(this.occupants);
    }
  }

  closePeer(peerId) {
    this._onOccupantDisconnected(peerId);

    const pendingMediaRequests = this._pendingMediaRequests.get(peerId);

    if (pendingMediaRequests) {
      const msg = "The user disconnected before the media stream was resolved.";
      info(msg);

      if (pendingMediaRequests.audio) {
        pendingMediaRequests.audio.resolve(null);
      }

      if (pendingMediaRequests.video) {
        pendingMediaRequests.video.resolve(null);
      }

      this._pendingMediaRequests.delete(peerId);
    }

    // Resolve initial audio resolver since this person left.
    const initialAudioResolver = this._initialAudioConsumerResolvers.get(peerId);

    if (initialAudioResolver) {
      initialAudioResolver();

      this._initialAudioConsumerResolvers.delete(peerId);
      this.scene.emit("audio-consumer-loaded");
    }

    delete this.occupants[peerId];

    if (this._onOccupantsChanged) {
      this._onOccupantsChanged(this.occupants);
    }
  }

  shouldStartConnectionTo() {
    return true;
  }

  startStreamConnection() {}

  closeStreamConnection() {}

  resolvePendingMediaRequestForTrack(clientId, track) {
    const requests = this._pendingMediaRequests.get(clientId);

    if (requests && requests[track.kind]) {
      const resolve = requests[track.kind].resolve;
      delete requests[track.kind];
      resolve(new MediaStream([track]));
    }

    if (requests && Object.keys(requests).length === 0) {
      this._pendingMediaRequests.delete(clientId);
    }
  }

  removeConsumer(consumerId) {
    this.emitRTCEvent("info", "RTC", () => `Consumer removed: ${consumerId}`);
    const consumer = this._consumers.get(consumerId);
    if (consumer && consumer.appData.peerId) {
      const peerConsumers = this._peerIdToConsumers.get(consumer.appData.peerId);

      if (peerConsumers) {
        const newConsumers = peerConsumers.filter(c => c !== consumer);

        if (newConsumers.length > 0) {
          this._peerIdToConsumers.set(consumer.appData.peerId, newConsumers);
        } else {
          this._peerIdToConsumers.delete(consumer.appData.peerId);
        }
      }
    }

    this._consumers.delete(consumerId);
  }

  getConnectStatus(/*clientId*/) {
    return this._protoo.connected ? NAF.adapters.IS_CONNECTED : NAF.adapters.NOT_CONNECTED;
  }

  async getAudioBytesReceivedFromClient(clientId) {
    if (this._clientId === clientId) return 0;

    const peerConsumers = this._peerIdToConsumers.get(clientId);

    if (peerConsumers) {
      for (const consumer of peerConsumers) {
        if (consumer.track.kind === "audio") {
          const stats = await consumer.getStats();

          for (const stat of stats.values()) {
            if (stat.type == "inbound-rtp" && stat.kind === "audio") {
              return stat.bytesReceived;
            }
          }
        }
      }
    }

    return 0;
  }

  getMediaStream(clientId, kind = "audio") {
    const stream = this.getMediaStreamSync(clientId, kind);

    if (stream) {
      debug(`Already had ${kind} for ${clientId}`);
      return Promise.resolve(stream);
    } else {
      debug(`Waiting on ${kind} for ${clientId}`);
      if (!this._pendingMediaRequests.has(clientId)) {
        this._pendingMediaRequests.set(clientId, {});
      }

      const requests = this._pendingMediaRequests.get(clientId);
      const promise = new Promise((resolve, reject) => (requests[kind] = { resolve, reject }));
      requests[kind].promise = promise;
      promise.catch(e => {
        this.emitRTCEvent("error", "Adapter", () => `getMediaStream error: ${e}`);
        console.warn(`${clientId} getMediaStream Error`, e);
      });
      return promise;
    }
  }

  getMediaStreamSync(clientId, kind = "audio") {
    const track = this.getMediaTrackSync(clientId, kind);

    if (track) {
      return new MediaStream([track]);
    }

    return null;
  }

  getMediaTrackSync(clientId, kind = "audio") {
    if (this._clientId === clientId) {
      if (kind === "audio" && this._micProducer) {
        return this._micProducer.track;
      } else if (kind === "video") {
        if (this._cameraProducer && !this._cameraProducer.closed) {
          return this._cameraProducer.track;
        } else if (this._shareProducer && !this._shareProducer.closed) {
          return this._shareProducer.track;
        }
      }
    } else {
      const peerConsumers = this._peerIdToConsumers.get(clientId);

      if (peerConsumers) {
        for (const consumer of peerConsumers) {
          if (kind == consumer.track.kind) {
            return consumer.track;
          }
        }
      }
    }

    return null;
  }

  getServerTime() {
    return Date.now() + this._avgTimeOffset;
  }

  sendData(data /*, clientId*/) {
    this.unreliableTransport(data);
  }
  sendDataGuaranteed(data /*, clientId*/) {
    this.reliableTransport(data);
  }
  broadcastData(data, initialSyncNetworkIds) {
    this.unreliableTransport(data, initialSyncNetworkIds);
  }
  broadcastDataGuaranteed(data, initialSyncNetworkIds) {
    this.reliableTransport(data, initialSyncNetworkIds);
  }

  setReconnectionListeners(reconnectingListener, reconnectedListener) {
    this._reconnectingListener = reconnectingListener;
    this._reconnectedListener = reconnectedListener;
  }

  syncOccupants() {
    // Not implemented
  }

  async createSendTransport(iceServers) {
    // Create mediasoup Transport for sending (unless we don't want to produce).
    const sendTransportInfo = await this._protoo.request("createWebRtcTransport", {
      producing: true,
      consuming: false,
      sctpCapabilities: undefined
    });

    this._sendTransport = this._mediasoupDevice.createSendTransport({
      id: sendTransportInfo.id,
      iceParameters: sendTransportInfo.iceParameters,
      iceCandidates: sendTransportInfo.iceCandidates,
      dtlsParameters: sendTransportInfo.dtlsParameters,
      sctpParameters: sendTransportInfo.sctpParameters,
      iceServers,
      iceTransportPolicy: this._iceTransportPolicy,
      proprietaryConstraints: PC_PROPRIETARY_CONSTRAINTS,
      additionalSettings: { encodedInsertableStreams: supportsInsertableStreams }
    });

    this._sendTransport.on("connect", (
      { dtlsParameters },
      callback,
      errback // eslint-disable-line no-shadow
    ) => {
      this.emitRTCEvent("info", "RTC", () => `Send transport [connect]`);
      this._sendTransport.observer.on("close", () => {
        this.emitRTCEvent("info", "RTC", () => `Send transport [close]`);
        // TODO uncomment without calling close() twice
        //!this._sendTransport?._closed && this._sendTransport.close();
      });
      this._sendTransport.observer.on("newproducer", producer => {
        this.emitRTCEvent("info", "RTC", () => `Send transport [newproducer]: ${producer.id}`);
      });
      this._sendTransport.observer.on("newconsumer", consumer => {
        this.emitRTCEvent("info", "RTC", () => `Send transport [newconsumer]: ${consumer.id}`);
      });

      this._protoo
        .request("connectWebRtcTransport", {
          transportId: this._sendTransport.id,
          dtlsParameters
        })
        .then(callback)
        .catch(errback);
    });

    this._sendTransport.on("connectionstatechange", connectionState => {
      let level = "info";
      if (connectionState === "failed" || connectionState === "disconnected") {
        level = "error";
      }
      this.emitRTCEvent(level, "RTC", () => `Send transport [connectionstatechange]: ${connectionState}`);

      this.checkSendIceStatus(connectionState);
    });

    this._sendTransport.on("produce", async ({ kind, rtpParameters, appData }, callback, errback) => {
      this.emitRTCEvent("info", "RTC", () => `Send transport [produce]: ${kind}`);
      try {
        // eslint-disable-next-line no-shadow
        const { id } = await this._protoo.request("produce", {
          transportId: this._sendTransport.id,
          kind,
          rtpParameters,
          appData
        });

        callback({ id });
      } catch (error) {
        this.emitRTCEvent("error", "Signaling", () => `[produce] error: ${error}`);
        errback(error);
      }
    });
  }

  closeMicProducer() {
    clearTimeout(this._closeMicProducerTimeout);
    this._closeMicProducerTimeout = null;

    if (!this._micProducer) return;

    this._micProducer.close();
    this._protoo?.connected && this._protoo?.request("closeProducer", { producerId: this._micProducer.id });
    this._micProducer = null;
  }

  async closeSendTransport() {
    this.closeMicProducer();

    if (this._videoProducer) {
      this._videoProducer.close();
      this._protoo?.connected && this._protoo?.request("closeProducer", { producerId: this._videoProducer.id });
      this._videoProducer = null;
    }

    const transportId = this._sendTransport?.id;
    if (this._sendTransport && !this._sendTransport._closed) {
      this._sendTransport.close();
      this._sendTransport = null;
    }

    if (this._protoo?.connected) {
      try {
        await this._protoo.request("closeWebRtcTransport", { transportId });
      } catch (err) {
        error(err);
      }
    }
  }

  async createRecvTransport(iceServers) {
    // Create mediasoup Transport for sending (unless we don't want to consume).
    const recvTransportInfo = await this._protoo.request("createWebRtcTransport", {
      producing: false,
      consuming: true,
      sctpCapabilities: undefined
    });

    this._recvTransport = this._mediasoupDevice.createRecvTransport({
      id: recvTransportInfo.id,
      iceParameters: recvTransportInfo.iceParameters,
      iceCandidates: recvTransportInfo.iceCandidates,
      dtlsParameters: recvTransportInfo.dtlsParameters,
      sctpParameters: recvTransportInfo.sctpParameters,
      iceServers,
      iceTransportPolicy: this._iceTransportPolicy,

      additionalSettings: { encodedInsertableStreams: supportsInsertableStreams }
    });

    this._recvTransport.on("connect", (
      { dtlsParameters },
      callback,
      errback // eslint-disable-line no-shadow
    ) => {
      this.emitRTCEvent("info", "RTC", () => `Receive transport [connect]`);
      this._recvTransport.observer.on("close", () => {
        this.emitRTCEvent("info", "RTC", () => `Receive transport [close]`);
        // TODO uncomment without calling close() twice
        //!this._recvTransport?._closed && this._recvTransport.close();
      });
      this._recvTransport.observer.on("newproducer", producer => {
        this.emitRTCEvent("info", "RTC", () => `Receive transport [newproducer]: ${producer.id}`);
      });
      this._recvTransport.observer.on("newconsumer", consumer => {
        this.emitRTCEvent("info", "RTC", () => `Receive transport [newconsumer]: ${consumer.id}`);
      });

      this._protoo
        .request("connectWebRtcTransport", {
          transportId: this._recvTransport.id,
          dtlsParameters
        })
        .then(callback)
        .catch(errback);
    });

    this._recvTransport.on("connectionstatechange", connectionState => {
      let level = "info";
      if (connectionState === "failed" || connectionState === "disconnected") {
        level = "error";
      }
      this.emitRTCEvent(level, "RTC", () => `Receive transport [connectionstatechange]: ${connectionState}`);

      this.checkRecvIceStatus(connectionState);
    });
  }

  async closeRecvTransport() {
    const transportId = this._recvTransport?.id;
    if (this._recvTransport && !this._recvTransport._closed) {
      this._recvTransport.close();
      this._recvTransport = null;
    }
    if (this._protoo?.connected) {
      try {
        await this._protoo.request("closeWebRtcTransport", { transportId });
      } catch (err) {
        error(err);
      }
    }
  }

  async createMissingConsumers() {
    await this._protoo.request("refreshConsumers");
  }

  async _joinRoom() {
    debug("_joinRoom()");

    this._mediasoupDevice = new mediasoupClient.Device({});

    const routerRtpCapabilities = await this._protoo.request("getRouterRtpCapabilities");

    await this._mediasoupDevice.load({ routerRtpCapabilities });

    const { host, port, turn } = this._serverParams;
    const iceServers = this.getIceServers(host, port, turn);

    await this.createSendTransport(iceServers);
    await this.createRecvTransport(iceServers);

    const { peers } = await this._protoo.request("join", {
      displayName: this._clientId,
      device: this._device,
      rtpCapabilities: this._mediasoupDevice.rtpCapabilities,
      sctpCapabilities: this._useDataChannel ? this._mediasoupDevice.sctpCapabilities : undefined,
      token: this._joinToken
    });

    const audioConsumerPromises = [];
    this.occupants = {};

    // clientID needs to be set before calling onOccupantConnected
    // so that we know which objects we own and flush their state.
    this._connectSuccess(this._clientId);

    // Create a promise that will be resolved once we attach to all the initial consumers.
    // This will gate the connection flow until all voices will be heard.
    for (let i = 0; i < peers.length; i++) {
      const peerId = peers[i].id;
      this._onOccupantConnected(peerId);
      this.occupants[peerId] = peers[i];
      if (!peers[i].hasProducers) continue;
      if (peers[i].hasAudioProducers) {
        audioConsumerPromises.push(new Promise(res => this._initialAudioConsumerResolvers.set(peerId, res)));
        this.scene.emit("audio-consumer-loading");
      }
    }

    this._initialAudioConsumerPromise = Promise.all(audioConsumerPromises);

    if (this._onOccupantsChanged) {
      this._onOccupantsChanged(this.occupants);
    }
  }

  setLocalMediaStream(stream) {
    this._localMediaStream = stream;
    return this.createMissingProducers();
  }

  async createMissingProducers() {
    const stream = this._localMediaStream;

    this.emitRTCEvent("info", "RTC", () => `Creating missing producers`);

    if (!this._sendTransport) return;
    if (!this.scene.is("entered")) return;

    while (this._updatingProducers) {
      await new Promise(res => setTimeout(res, 150));
    }

    this._updatingProducers = true;

    let sawAudio = false;
    let sawVideo = false;

    await Promise.all(
      stream.getTracks().map(async track => {
        if (track.kind === "audio") {
          sawAudio = true;

          // TODO multiple audio tracks?
          if (this._micProducer) {
            if (this._micProducer.track !== track) {
              this._micProducer.track.stop();
              this._micProducer.replaceTrack(track);
            }
          } else {
            if (this._micEnabled) {
              await this.createMicProducer(track);

              if (this._micProducer.track !== track) {
                this._micProducer.track.stop();
                this._micProducer.replaceTrack(track);
              }
            } else {
              track.enabled = false;
            }
          }
        } else {
          sawVideo = true;

          if (track._hubs_contentHint === "share") {
            await this.disableCamera();
            await this.enableShare(track);
          } else if (track._hubs_contentHint === "camera") {
            await this.disableShare();
            await this.enableCamera(track);
          }
        }

        this.resolvePendingMediaRequestForTrack(this._clientId, track);
      })
    );

    if (!sawAudio && this._micProducer) {
      this.closeMicProducer();
    }
    if (!sawVideo) {
      this.disableCamera();
      this.disableShare();
    }

    this._updatingProducers = false;
  }

  async createMicProducer(track) {
    // stopTracks = false because otherwise the track will end during a temporary disconnect
    this._micProducer = await this._sendTransport.produce({
      track,
      stopTracks: false,
      codecOptions: { opusStereo: false, opusDtx: true },
      zeroRtpOnPause: false,
      disableTrackOnPause: true,
      encodings: [{ maxBitrate: 64 * 1024 }] // Firefox doesn't work with higher bitrates
    });

    if (supportsInsertableStreams) {
      const self = this;

      // Add viseme encoder
      const senderTransform = new TransformStream({
        start() {
          // Called on startup.
        },

        async transform(encodedFrame, controller) {
          if (encodedFrame.data.byteLength < 2) {
            controller.enqueue(encodedFrame);
            return;
          }

          // Create a new buffer with 1 byte for viseme.
          const newData = new ArrayBuffer(encodedFrame.data.byteLength + 1 + visemeMagicBytes.length);
          const arr = new Uint8Array(newData);
          arr.set(new Uint8Array(encodedFrame.data), 0);

          for (let i = 0, l = visemeMagicBytes.length; i < l; i++) {
            arr[encodedFrame.data.byteLength + i] = visemeMagicBytes[i];
          }

          if (self._outgoingVisemeBuffer) {
            const viseme = self._micEnabled ? self._outgoingVisemeBuffer[0] : 0;
            arr[encodedFrame.data.byteLength + visemeMagicBytes.length] = viseme;
            self._visemeMap.set(self._clientId, viseme);
            self._visemeTimestamps.set(self._clientId, performance.now());
          }

          encodedFrame.data = newData;
          controller.enqueue(encodedFrame);
        },

        flush() {
          // Called when the stream is about to be closed.
        }
      });

      const senderStreams = this._micProducer.rtpSender.createEncodedStreams();
      senderStreams.readable.pipeThrough(senderTransform).pipeTo(senderStreams.writable);
    }

    this._micProducer.on("transportclose", () => {
      this.emitRTCEvent("info", "RTC", () => `Mic transport closed`);
      this._micProducer = null;
    });

    // Starts paused
    this._micProducer.resume();
  }

  async enableCamera(track) {
    // stopTracks = false because otherwise the track will end during a temporary disconnect
    this._cameraProducer = await this._sendTransport.produce({
      track,
      stopTracks: false,
      codecOptions: { videoGoogleStartBitrate: 1000 },
      encodings: WEBCAM_SIMULCAST_ENCODINGS,
      zeroRtpOnPause: true,
      disableTrackOnPause: true
    });

    this._cameraProducer.on("transportclose", () => {
      this.emitRTCEvent("info", "RTC", () => `Camera transport closed`);
      this.disableCamera();
    });
    this._cameraProducer.observer.on("trackended", () => {
      this.emitRTCEvent("info", "RTC", () => `Camera track ended`);
      this.disableCamera();
    });
    if (supportsInsertableStreams) {
      const senderStreams = this._cameraProducer.rtpSender.createEncodedStreams();
      senderStreams.readable.pipeTo(senderStreams.writable);
    }
  }

  async disableCamera() {
    if (!this._cameraProducer) return;

    this._cameraProducer.close();

    try {
      if (!this._sendTransport.closed) {
        await this._protoo.request("closeProducer", { producerId: this._cameraProducer.id });
      }
    } catch (error) {
      console.error(`disableCamera(): ${error}`);
    }

    this._cameraProducer = null;
  }

  async enableShare(track) {
    // stopTracks = false because otherwise the track will end during a temporary disconnect
    this._shareProducer = await this._sendTransport.produce({
      track,
      stopTracks: false,
      codecOptions: { videoGoogleStartBitrate: 1000 },
      encodings: SCREEN_SHARING_SIMULCAST_ENCODINGS,
      zeroRtpOnPause: true,
      disableTrackOnPause: true,
      appData: {
        share: true
      }
    });

    this._shareProducer.on("transportclose", () => {
      this.emitRTCEvent("info", "RTC", () => `Desktop Share transport closed`);
      this.disableShare();
    });
    this._shareProducer.observer.on("trackended", () => {
      this.emitRTCEvent("info", "RTC", () => `Desktop Share transport track ended`);
      this.disableShare();
    });
    if (supportsInsertableStreams) {
      const senderStreams = this._shareProducer.rtpSender.createEncodedStreams();
      senderStreams.readable.pipeTo(senderStreams.writable);
    }
  }

  async disableShare() {
    if (!this._shareProducer) return;

    this._shareProducer.close();

    try {
      if (!this._sendTransport.closed) {
        await this._protoo.request("closeProducer", { producerId: this._shareProducer.id });
      }
    } catch (error) {
      console.error(`disableShare(): ${error}`);
    }

    this._shareProducer = null;
  }

  enableMicrophone(enabled) {
    if (this._micProducer) {
      if (enabled) {
        this._micProducer.resume();
        this._protoo.request("resumeProducer", { producerId: this._micProducer.id });
      } else {
        this._micProducer.pause();
        this._protoo.request("pauseProducer", { producerId: this._micProducer.id });
      }
    }

    this._micEnabled = enabled;

    window.APP.store.update({
      settings: { micMuted: !this._micEnabled }
    });

    clearTimeout(this._closeMicProducerTimeout);
    this._closeMicProducerTimeout = null;

    if (enabled) {
      this.createMissingProducers();
    } else {
      this._closeMicProducerTimeout = setTimeout(() => this.closeMicProducer(), 30000);
    }
  }

  isDisconnected() {
    return !this._protoo.connected;
  }

  async disconnect() {
    if (this._closed) return;

    this._closed = true;

    const occupantIds = Object.keys(this.occupants);
    for (let i = 0; i < occupantIds.length; i++) {
      const peerId = occupantIds[i];
      if (peerId === this._clientId) continue;
      this._onOccupantDisconnected(peerId);
    }

    this.occupants = {};

    if (this._onOccupantsChanged) {
      this._onOccupantsChanged(this.occupants);
    }

    debug("disconnect()");

    // Close mediasoup Transports.
    await Promise.all([this.closeSendTransport(), this.closeRecvTransport()]);

    // Close protoo Peer, though may already be closed if this is happening due to websocket breakdown
    if (this._protoo && this._protoo.connected) {
      this._protoo.removeAllListeners();
      this._protoo.close();
      this._protoo = null;
      this.emitRTCEvent("info", "Signaling", () => `[close]`);
    }

    AFRAME.scenes[0].systems.networked.reset();
  }

  reconnect(timeout = 2000) {
    // The Protoo WebSocketTransport server url cannot be updated after it's been created so we need to orce a diconnect/connect
    // to make sure we are using the updated server url for the WSS if it has changed.
    this.disconnect();
    if (this._protoo) {
      this._protoo.removeAllListeners();
      this._protoo.close();
      this._protoo = null;
    }
    setTimeout(() => {
      this.connect();
    }, timeout);
  }

  kick(clientId, permsToken) {
    return this._protoo
      .request("kick", {
        room_id: this.room,
        user_id: clientId,
        token: permsToken
      })
      .then(() => {
        document.body.dispatchEvent(new CustomEvent("kicked", { detail: { clientId: clientId } }));
      });
  }

  block(clientId) {
    return this._protoo.request("block", { whom: clientId }).then(() => {
      this._blockedClients.set(clientId, true);
      document.body.dispatchEvent(new CustomEvent("blocked", { detail: { clientId: clientId } }));
    });
  }

  unblock(clientId) {
    return this._protoo.request("unblock", { whom: clientId }).then(() => {
      this._blockedClients.delete(clientId);
      document.body.dispatchEvent(new CustomEvent("unblocked", { detail: { clientId: clientId } }));
    });
  }

  async updateTimeOffset() {
    if (this.isDisconnected()) return;

    const clientSentTime = Date.now();

    const res = await fetch(document.location.href, {
      method: "HEAD",
      cache: "no-cache"
    });

    const precision = 1000;
    const serverReceivedTime = new Date(res.headers.get("Date")).getTime() + precision / 2;
    const clientReceivedTime = Date.now();
    const serverTime = serverReceivedTime + (clientReceivedTime - clientSentTime) / 2;
    const timeOffset = serverTime - clientReceivedTime;

    this._serverTimeRequests++;

    if (this._serverTimeRequests <= 10) {
      this._timeOffsets.push(timeOffset);
    } else {
      this._timeOffsets[this._serverTimeRequests % 10] = timeOffset;
    }

    this._avgTimeOffset = Math.floor(
      this._timeOffsets.reduce((acc, offset) => (acc += offset), 0) / this._timeOffsets.length
    );

    if (this._serverTimeRequests > 10) {
      debug(`new server time offset: ${this._avgTimeOffset}ms`);
      setTimeout(() => this.updateTimeOffset(), 5 * 60 * 1000); // Sync clock every 5 minutes.
    } else {
      this.updateTimeOffset();
    }
  }

  toggleFreeze() {
    if (this.frozen) {
      this.unfreeze();
    } else {
      this.freeze();
    }
  }

  freeze() {
    this.frozen = true;
    AFRAME.scenes[0].systems.networked.incomingPaused = true;
  }

  unfreeze() {
    this.frozen = false;
    AFRAME.scenes[0].systems.networked.incomingPaused = false;
  }

  async onData(message, source) {
    if (debug.enabled) {
      debug(`DC in: ${message}`);
    }

    this._messageCount++;
    const { from: senderRaw } = message;
    const sender = uuidStringify(senderRaw);

    // Wait for presence to show up before processing message;
    let presenceState = presenceForSessionId(sender);
    if (!presenceState) {
      let c = 0;

      await new Promise(res => {
        const waitForPresenceInterval = setInterval(() => {
          c++;
          if (c > 100 || presenceForSessionId(sender)) {
            clearInterval(waitForPresenceInterval);
            res();
          }
        }, 100);
      });

      presenceState = presenceForSessionId(sender);
    }

    if (!presenceState) {
      NAF.log.warn("Presence never seen for message from ", sender);
      return;
    }

    if (spawnModsOnly && presenceState.metas[0] && !presenceState.metas[0].permissions.update_hub) return;

    message.source = source;
    this._onOccupantMessage(message.d, source, sender);
  }

  emitRTCEvent(level, tag, msgFunc) {
    if (!window.APP.store.state.preferences.showRtcDebugPanel) return;
    const time = new Date().toLocaleTimeString("en-US", {
      hour12: false,
      hour: "numeric",
      minute: "numeric",
      second: "numeric"
    });
    this.scene.emit("rtc_event", { level, tag, time, msg: msgFunc() });
  }

  authorizeCreateEntity(template, sender) {
    const presenceState = presenceForSessionId(sender);
    if (!presenceState) {
      NAF.log.error("No presence for ", sender);
      return;
    }

    const { permissions } = presenceState.metas[0];
    if (template.endsWith("-avatar")) return true;
    if (template.endsWith("-media")) return permissions.spawn_and_move_media;
    if (template.endsWith("-camera")) return permissions.spawn_camera;
    if (template.endsWith("-drawing")) return permissions.spawn_drawing;
    if (template.endsWith("-pen")) return permissions.spawn_drawing;
    if (template.endsWith("-emoji")) return permissions.spawn_emoji;

    return false;
  }

  authorizeEntityManipulation(entity, sender) {
    const { template, creator } = entity.components.networked.data;

    const presenceState = presenceForSessionId(sender);
    if (!presenceState) {
      NAF.log.error("No presence for ", sender);
      return;
    }

    const { permissions } = presenceState.metas[0];
    const isCreator = sender === creator;

    const isPinned = entity.components["pinnable"] && entity.components["pinnable"].data.pinned;

    if (template.endsWith("-waypoint-avatar") || template.endsWith("-media-frame")) {
      return true;
    } else if (template.endsWith("-avatar")) {
      return isCreator;
    } else if (template.endsWith("-media")) {
      return (!isPinned || permissions.pin_objects) && (isCreator || permissions.spawn_and_move_media);
    } else if (template.endsWith("-camera")) {
      return isCreator || permissions.spawn_camera;
    } else if (template.endsWith("-pen") || template.endsWith("-drawing")) {
      return isCreator || permissions.spawn_drawing;
    } else if (template.endsWith("-emoji")) {
      return isCreator || permissions.spawn_emoji;
    } else {
      return false;
    }
  }

  sanitizeComponentValues(el, componentName, attributeValue, sender) {
    if (this.authorizeEntityManipulation(el, sender)) return true;

    if (nonAuthorizedProperties === null) {
      initializeNonAuthorizedProperties();
    }

    const { template } = el.components.networked.data;

    if (typeof attributeValue === "object") {
      const nonAuthorizedComponentProps = nonAuthorizedProperties.get(template);
      let sawAnyRetainedProperties = false;

      for (const property of Object.keys(attributeValue)) {
        let sanitize = true;

        if (nonAuthorizedComponentProps) {
          const props = nonAuthorizedComponentProps.get(componentName);

          if (props && (props.length === 0 || props.includes(property))) {
            sanitize = false;
            sawAnyRetainedProperties = true;
            break;
          }
        }

        if (sanitize) {
          delete attributeValue[property];
        }
      }

      return sawAnyRetainedProperties;
    } else {
      // Non object value (default schema)
      const nonAuthorizedComponentProps = nonAuthorizedProperties.get(template);
      if (!nonAuthorizedComponentProps) return false;

      const props = nonAuthorizedComponentProps.get(componentName);
      return props && props.length === 0; // Empty array means fully whitelisted
    }
  }

  get isMicEnabled() {
    return this._micProducer && !this._micProducer.paused;
  }
}

NAF.adapters.register("dialog", DialogAdapter);

const log = console.log.bind(console);
const logs = [];
console.log = function() {
  logs.push(0);
  logs.push(new Date());
  logs.push(Array.from(arguments));
  log.apply(console, arguments);
};

const warn = console.warn.bind(console);
console.warn = function() {
  logs.push(1);
  logs.push(new Date());
  logs.push(Array.from(arguments));
  warn.apply(console, arguments);
};

const error = console.error.bind(console);
console.error = function() {
  logs.push(2);
  logs.push(new Date());
  logs.push(Array.from(arguments));
  error.apply(console, arguments);
};

export async function dump() {
  const gl = AFRAME.scenes[0].renderer.getContext();

  const debugInfo = gl && gl.getExtension("WEBGL_debug_renderer_info");
  const vendor = gl && gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
  const renderer = gl && gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
  let s = `Client: ${NAF.clientId} ${window.APP.hubChannel.presence.state[NAF.clientId].metas[0].profile.displayName ||
    window.APP.hubChannel.presence.state[NAF.clientId].metas[0].profile.identityName}\nURL: ${
    document.location
  }\nDump at: ${new Date()} ${performance.now()}\nBrowser: ${navigator.userAgent}\nGL: ${vendor} ${renderer}\n`;

  const trackSystem = AFRAME.scenes[0].systems["hubs-systems"].avatarAudioTrackSystem;
  const avatarSystem = AFRAME.scenes[0].systems["hubs-systems"].avatarSystem;

  s += "\n\nStats\n";
  s += `${[...Object.keys(window.APP.hubChannel.presence.state)].length} Presences\n`;
  s += `${[...document.querySelectorAll("[networked-avatar]")].length} Networked Avatars\n`;
  s += `${[...document.querySelectorAll("[avatar-audio-source]")].length} Audio Source Avatars\n`;
  s += `${[...Object.keys(NAF.connection.adapter.occupants)].length} Peers\n`;
  s += `${[...NAF.connection.adapter._consumers].length} Consumers\n`;
  s += `${[...avatarSystem.avatarEntityIdToIndex.keys()].length} Registered Avatar Entities\n`;
  s += `${[...trackSystem.entities.filter(x => !!x)].length} Registered Track Entities\n`;
  s += `${[...trackSystem.entityToSourceIndex.values()].length} Assigned Track Entities\n`;
  s += `${trackSystem.entityLastBytesReceived.filter(x => x > 0).length} Audio Received Entities\n`;
  s += `${trackSystem.entityLastPresumedSpeakingAt.filter(x => x > 0).length} Heard Entities\n`;

  s += "\n\nLog\n";

  for (let i = 0; i < logs.length; i += 3) {
    const l = logs[i];
    const label = l === 0 ? "INFO" : l === 1 ? "WARN" : "ERROR";
    const t = logs[i + 1];
    const msg = logs[i + 2];
    s += `${t.toUTCString()} [${label}] ${msg}\n`;
  }

  s += "\n\nPresence\n";

  const users = new Map();

  for (const [k, { metas }] of Object.entries(window.APP.hubChannel.presence.state)) {
    const meta = metas[0];

    if (meta) {
      s += `\n${k} ${JSON.stringify(meta, null, 2)}`;
      users.set(k, meta.profile.identityName || meta.profile.displayName);
    }
  }

  s += "\n\nScene\n";

  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  let lastEl = null;

  //const q = new THREE.Quaternion();

  AFRAME.scenes[0].object3D.traverse(o => {
    let sp = "";
    let nsp = 0;
    let n = o.parent;

    while (n) {
      sp += "  ";
      nsp += 1;
      n = n.parent;
    }

    let el = null;

    if (o.el) {
      if (o.el !== lastEl) {
        el = o.el;
      }

      lastEl = o.el;
    }

    const cs = el ? `[${[...Object.keys(el.components)].join(" ")}]` : "";
    s += `${sp}${el && el.id ? `#${el.id} ` : ""}${o.name} ${o.type} ${cs}\n`;

    o.getWorldPosition(v1);
    o.getWorldScale(v2);
    s += `${sp}  p: <${v1.x} ${v1.y} ${v1.z}> s: <${v2.x} ${v2.y} ${v2.z}>\n`;

    if (el) {
      for (const [name, component] of Object.entries(el.components)) {
        if (name === "networked") {
          const { creator, owner, networkId } = component.data;
          s += `${sp}  ${name}:\n`;
          s += `${sp}    ${networkId} c: ${users.get(creator)} ${creator} o: ${users.get(owner)} ${owner} ${
            NAF.clientId === creator ? "C" : ""
          } ${NAF.clientId === owner ? "M" : ""}\n`;
        } else {
          if (!component.toDump) continue;
          s += `${sp}  ${name}:\n${component.toDump(sp + "  ", nsp + 2)}\n`;
        }
      }
    }
  });

  s += "\n\nPeers\n";
  s += JSON.stringify(NAF.connection.adapter.occupants, null, 2) + "\n";

  s += "\n\nConsumers";
  s += JSON.stringify([...NAF.connection.adapter._consumers], null, 2) + "\n";

  for (const [id, consumer] of NAF.connection.adapter._consumers.entries()) {
    const receiver = consumer.rtpReceiver;
    const track = receiver && receiver.track;
    const transport = receiver && receiver.transport;
    const ice = transport && transport.iceTransport;

    s += `\n  Consumer ${id}:\n`;

    if (transport) {
      s += `     transport: ${transport.state}\n`;
    }

    if (ice) {
      s += `     ice: ${ice.state}\n`;
      s += `     gathering: ${ice.gatheringState}\n`;
    }

    if (track) {
      s += `     track id: ${track.id}\n`;
      s += `     enabled: ${track.enabled}\n`;
      s += `     kind: ${track.kind}\n`;
      s += `     muted: ${track.muted}\n`;
      s += `     readyState: ${track.readyState}\n`;
    }

    const stats = await consumer.getStats();

    for (const stat of stats.values()) {
      if (stat.type == "inbound-rtp" && stat.kind === "audio") {
        s += `     received: ${stat.bytesReceived}\n`;
      }
    }
  }

  return s;
}

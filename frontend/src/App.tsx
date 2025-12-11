import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";

type StateMessage = {
  type: "welcome" | "peer-joined" | "peer-left" | "broadcast-state";
  id?: string;
  peers?: string[];
  broadcasting?: string[];
  enabled?: boolean;
};

type SignalMessage = {
  type: "signal";
  from: string;
  to: string;
  data: any;
};

type IncomingMessage = StateMessage | SignalMessage;

const iceConfig: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

const wsURL = () => {
  const env = import.meta.env.VITE_WS_URL as string | undefined;
  if (env) return env;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws`;
};

const VideoTile = (props: { label: string; stream: MediaStream; muted?: boolean }) => {
  let videoRef: HTMLVideoElement | undefined;

  // Bind the stream once the ref is set and whenever the stream changes.
  createEffect(() => {
    if (!videoRef) return;
    const stream = props.stream;
    if (!(stream instanceof MediaStream)) {
      console.warn("VideoTile: stream is not a MediaStream", stream);
      return;
    }
    if (videoRef.srcObject !== stream) {
      videoRef.srcObject = stream;
      // Some browsers need an explicit play() call after srcObject assignment.
      void videoRef.play().catch((err) => {
        console.warn("VideoTile: play() failed", err);
      });
    }
  });

  return (
    <div class="video-tile">
      <video ref={videoRef} autoplay playsinline muted={props.muted} />
      <div class="tag">{props.label}</div>
    </div>
  );
};

export default function App() {
  const [peerId, setPeerId] = createSignal<string>();
  const [peers, setPeers] = createSignal<string[]>([]);
  const [broadcasting, setBroadcasting] = createSignal<string[]>([]);
  const [broadcastEnabled, setBroadcastEnabled] = createSignal(false);
  const [connected, setConnected] = createSignal(false);
  const [status, setStatus] = createSignal("Connecting to signaling server...");
  const [remoteStreams, setRemoteStreams] = createSignal<Map<string, MediaStream>>(
    new Map()
  );
  const [localStream, setLocalStream] = createSignal<MediaStream>();

  const connections = new Map<string, RTCPeerConnection>();
  let socket: WebSocket | null = null;

  const send = (payload: any) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  };

  const updatePresence = (list: string[] = [], live: string[] = []) => {
    setPeers(list);
    setBroadcasting(live);

    // Drop any remote streams that no longer correspond to an active broadcaster.
    const liveSet = new Set(live);
    setRemoteStreams((prev) => {
      const next = new Map(prev);
      Array.from(next.keys())
        .filter((id) => !liveSet.has(id))
        .forEach((id) => {
          next.get(id)?.getTracks().forEach((t) => t.stop());
          next.delete(id);
        });
      return next;
    });
  };

  const prunePeerLists = (id: string) => {
    setPeers((prev) => prev.filter((p) => p !== id));
    setBroadcasting((prev) => prev.filter((p) => p !== id));
  };

  const removeRemoteStream = (id: string) => {
    setRemoteStreams((prev) => {
      const next = new Map(prev);
      const stream = next.get(id);
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      next.delete(id);
      return next;
    });
  };

  const removePeer = (id: string) => {
    const pc = connections.get(id);
    if (pc) {
      pc.close();
      connections.delete(id);
    }
    removeRemoteStream(id);

    prunePeerLists(id);
  };

  const ensureLocalTracks = (pc: RTCPeerConnection) => {
    const stream = localStream();
    if (!stream) return;
    const existing = pc.getSenders().map((s) => s.track?.id);
    stream.getTracks().forEach((track) => {
      if (!existing.includes(track.id)) {
        pc.addTrack(track, stream);
        console.log("ensureLocalTracks: added track", { kind: track.kind, id: track.id });
      }
    });
  };

  const getOrCreateConnection = (id: string) => {
    let pc = connections.get(id);
    if (pc) return pc;

    pc = new RTCPeerConnection(iceConfig);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        send({ type: "signal", to: id, data: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) {
        if (remoteStreams().has(id)) {
          // Already attached a stream for this peer; skip duplicate audio/video events.
          return;
        }
        console.log("ontrack: received stream", {
          from: id,
          streamId: stream.id,
          tracks: stream.getTracks().map((t) => t.kind)
        });
        setRemoteStreams((prev) => {
          const next = new Map(prev);
          next.set(id, stream);
          return next;
        });
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc?.connectionState || "";
      console.log("connectionstatechange", { peer: id, state });
      if (["failed", "closed", "disconnected"].includes(state)) {
        removePeer(id);
      }
    };

    ensureLocalTracks(pc);

    connections.set(id, pc);
    return pc;
  };

  const sendOffer = async (id: string) => {
    if (!broadcastEnabled()) return;
    const pc = getOrCreateConnection(id);
    ensureLocalTracks(pc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: "signal", to: id, data: pc.localDescription });
  };

  const handleSignal = async (msg: SignalMessage) => {
    const pc = getOrCreateConnection(msg.from);
    const payload = msg.data;
    if (!payload) return;

    try {
      if ("sdp" in payload) {
        await pc.setRemoteDescription(payload);
        if (payload.type === "offer") {
          ensureLocalTracks(pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          send({ type: "signal", to: msg.from, data: pc.localDescription });
        }
      } else if ("candidate" in payload) {
        await pc.addIceCandidate(payload);
      }
    } catch (err) {
      console.error("signal handling error", err);
    }
  };

  const startBroadcast = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });
      console.log("startBroadcast: acquired local stream", {
        id: stream.id,
        tracks: stream.getTracks().map((t) => `${t.kind}:${t.id}`)
      });
      setLocalStream(stream);
      setBroadcastEnabled(true);
      send({ type: "broadcast", enabled: true });

      peers()
        .filter((id) => id !== peerId())
        .forEach((id) => {
          void sendOffer(id);
        });
    } catch (err) {
      console.error(err);
      setStatus("Unable to access camera or mic");
    }
  };

  const stopBroadcast = () => {
    setBroadcastEnabled(false);
    send({ type: "broadcast", enabled: false });

    const stream = localStream();
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
    setLocalStream();

    connections.forEach((pc) => {
      pc.getSenders().forEach((sender) => {
        try {
          pc.removeTrack(sender);
        } catch {
          // ignore
        }
      });
    });
  };

  const handleState = (msg: StateMessage) => {
    updatePresence(msg.peers || peers(), msg.broadcasting || broadcasting());

    if (msg.type === "welcome" && msg.id) {
      setPeerId(msg.id);
      setStatus("Connected");
    }

    if (msg.type === "peer-left" && msg.id) {
      removePeer(msg.id);
    }

    if (msg.type === "broadcast-state" && msg.id && msg.enabled === false) {
      removeRemoteStream(msg.id);
    }

    if (msg.type === "peer-joined" && msg.id && broadcastEnabled()) {
      void sendOffer(msg.id);
    }
  };

  const connectSocket = () => {
    socket = new WebSocket(wsURL());

    socket.onopen = () => {
      console.log("ws: open", { url: wsURL() });
      setConnected(true);
      setStatus("Connected");
    };

    socket.onclose = () => {
      console.log("ws: close");
      setConnected(false);
      setStatus("Disconnected from signaling server");
    };

    socket.onmessage = (event) => {
      try {
        const message: IncomingMessage = JSON.parse(event.data);
        if (message.type === "signal") {
          void handleSignal(message as SignalMessage);
        } else {
          handleState(message as StateMessage);
        }
      } catch (err) {
        console.error("bad message", err);
      }
    };
  };

  connectSocket();

  onCleanup(() => {
    stopBroadcast();
    connections.forEach((pc) => pc.close());
    socket?.close();
  });

  const peerEntries = () => Array.from(remoteStreams());

  return (
    <main class="page">
      <div class="panel header">
        <div class="title-row">
          <h1>Go + SolidJS WebRTC Room</h1>
          <div class="chip">{connected() ? "Live" : "Offline"}</div>
        </div>
        <div class="stats">
          <div class="stat">
            <label>Peer ID</label>
            <strong>{peerId() || "..."}</strong>
          </div>
          <div class="stat">
            <label>Peers in room</label>
            <strong>{peers().length}</strong>
          </div>
          <div class="stat">
            <label>Broadcasting</label>
            <strong>{broadcasting().length}</strong>
          </div>
          <div class="stat">
            <label>Status</label>
            <strong>{status()}</strong>
          </div>
        </div>
        <div class="peers">
          <label>Peers</label>
          <div class="peer-list">
            <Show when={peers().length} fallback={<span class="status">Waiting for peers...</span>}>
              <For each={peers()}>
                {(id) => <span class="pill">{id}</span>}
              </For>
            </Show>
          </div>
        </div>
        <div class="controls">
          <button onClick={() => (broadcastEnabled() ? stopBroadcast() : void startBroadcast())}>
            {broadcastEnabled() ? "Stop broadcasting" : "Start broadcasting"}
          </button>
        </div>
      </div>

      <div class="panel">
        <h3>Live Streams</h3>
        <div class="videos">
          <Show when={localStream()}>
            {(stream) => <VideoTile label="You" stream={stream()} muted />}
          </Show>
          <For each={peerEntries()}>
            {([id, stream]) => (
              <VideoTile label={id === peerId() ? "You" : id} stream={stream} muted />
            )}
          </For>
          <Show when={!localStream() && remoteStreams().size === 0}>
            <div class="status">No streams yet. Start broadcasting to share your media.</div>
          </Show>
        </div>
      </div>
    </main>
  );
}

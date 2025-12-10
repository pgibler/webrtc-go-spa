import { For, Show, createSignal, onCleanup } from "solid-js";

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

  const assignStream = () => {
    if (videoRef && videoRef.srcObject !== props.stream) {
      videoRef.srcObject = props.stream;
    }
  };

  assignStream();

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
  };

  const removePeer = (id: string) => {
    const pc = connections.get(id);
    if (pc) {
      pc.close();
      connections.delete(id);
    }
    setRemoteStreams((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  };

  const ensureLocalTracks = (pc: RTCPeerConnection) => {
    const stream = localStream();
    if (!stream) return;
    const existing = pc.getSenders().map((s) => s.track?.id);
    stream.getTracks().forEach((track) => {
      if (!existing.includes(track.id)) {
        pc.addTrack(track, stream);
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
        setRemoteStreams((prev) => {
          const next = new Map(prev);
          next.set(id, stream);
          return next;
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc?.connectionState || "")) {
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

    if (msg.type === "peer-joined" && msg.id && broadcastEnabled()) {
      void sendOffer(msg.id);
    }
  };

  const connectSocket = () => {
    socket = new WebSocket(wsURL());

    socket.onopen = () => {
      setConnected(true);
      setStatus("Connected");
    };

    socket.onclose = () => {
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
          <Show when={localStream()}>
            <button class="secondary" onClick={stopBroadcast}>
              Disable broadcast
            </button>
          </Show>
        </div>
      </div>

      <div class="panel">
        <h3>Live Streams</h3>
        <div class="videos">
          <Show when={localStream()}>
            {(stream) => <VideoTile label="You" stream={stream} muted />}
          </Show>
          <For each={peerEntries()}>
            {([id, stream]) => (
              <VideoTile label={id === peerId() ? "You" : id} stream={stream} muted={id === peerId()} />
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

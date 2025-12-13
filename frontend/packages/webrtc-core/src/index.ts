export type SignalMessage = {
  type: "signal";
  from: string;
  to: string;
  data: any;
};

export type StateMessage = {
  type: "welcome" | "peer-joined" | "peer-left" | "broadcast-state";
  id?: string;
  peers?: string[];
  broadcasting?: string[];
  enabled?: boolean;
  iceServers?: RTCIceServer[];
  iceMode?: string;
};

export type IncomingMessage = StateMessage | SignalMessage;

export type WebRTCEventMap = {
  connected: void;
  disconnected: void;
  state: StateMessage;
  remoteStream: { id: string; stream: MediaStream };
  remoteStreamRemoved: { id: string };
  status: string;
  error: Error;
};

type EventKey = keyof WebRTCEventMap;
type Handler<K extends EventKey> = (payload: WebRTCEventMap[K]) => void;

type EventRegistry = {
  [K in EventKey]: Set<Handler<K>>;
};

export type WebRTCClientOptions = {
  wsURL?: string;
  iceServers?: RTCIceServer[];
  socketFactory?: (url: string) => WebSocket;
};

const defaultIceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

const loggingEnabled =
  typeof import.meta !== "undefined" && typeof (import.meta as any).env !== "undefined"
    ? Boolean((import.meta as any).env.VITE_WEBRTC_LOGGING)
    : false;

const log = (...args: unknown[]) => {
  if (loggingEnabled) {
    console.info(...args);
  }
};

const logError = (...args: unknown[]) => {
  if (loggingEnabled) {
    console.error(...args);
  }
};

type ClientSettings = {
  wsURL?: string;
  iceMode?: string;
  iceServers?: RTCIceServer[];
};

let settingsCache: ClientSettings | null = null;
let settingsPromise: Promise<ClientSettings | null> | null = null;

const fetchSettings = async (): Promise<ClientSettings | null> => {
  if (settingsCache) return settingsCache;
  if (settingsPromise) return settingsPromise;

  settingsPromise = (async () => {
    if (typeof window === "undefined" || typeof fetch === "undefined") return null;
    try {
      const res = await fetch("/api/settings", { headers: { Accept: "application/json" } });
      if (!res.ok) return null;
      const data = (await res.json()) as ClientSettings;
      settingsCache = data;
      return data;
    } catch {
      return null;
    } finally {
      settingsPromise = null;
    }
  })();

  return settingsPromise;
};

const defaultWsURL = () => {
  if (settingsCache?.wsURL) return settingsCache.wsURL;
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws`;
};

export class WebRTCClient {
  private socket: WebSocket | null = null;
  private connections = new Map<string, RTCPeerConnection>();
  private remoteStreams = new Map<string, MediaStream>();
  private localStream?: MediaStream;
  private broadcastEnabled = false;
  private peers: string[] = [];
  private broadcasting: string[] = [];
  private peerId?: string;
  private iceServers: RTCIceServer[];
  private iceMode?: string;
  private wsURL: string;
  private socketFactory: (url: string) => WebSocket;
  private events: EventRegistry = {
    connected: new Set(),
    disconnected: new Set(),
    state: new Set(),
    remoteStream: new Set(),
    remoteStreamRemoved: new Set(),
    status: new Set(),
    error: new Set()
  };

  constructor(opts: WebRTCClientOptions = {}) {
    this.wsURL = opts.wsURL || "";
    this.iceServers = opts.iceServers || defaultIceServers;
    this.socketFactory = opts.socketFactory || ((url: string) => new WebSocket(url));
    void fetchSettings();
  }

  on<K extends EventKey>(event: K, handler: Handler<K>) {
    this.events[event].add(handler as any);
    return () => this.off(event, handler);
  }

  off<K extends EventKey>(event: K, handler: Handler<K>) {
    this.events[event].delete(handler as any);
  }

  get state() {
    return {
      peerId: this.peerId,
      peers: this.peers,
      broadcasting: this.broadcasting,
      broadcastEnabled: this.broadcastEnabled,
      iceServers: this.iceServers,
      iceMode: this.iceMode,
      localStream: this.localStream,
      remoteStreams: new Map(this.remoteStreams)
    };
  }

  connect() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return;
    this.emit("status", "Connecting to signaling server...");

    void (async () => {
      const resolvedURL = await this.resolveWsURL();
      const socket = this.socketFactory(resolvedURL);
      this.socket = socket;

      socket.onopen = () => {
        log("[webrtc] ws open", { url: resolvedURL });
        this.emit("connected", undefined);
        this.emit("status", "Connected");
      };
      socket.onclose = (ev) => {
        log("[webrtc] ws close", { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
        this.emit("disconnected", undefined);
        this.emit("status", "Disconnected from signaling server");
      };
      socket.onerror = (err) => {
        logError("[webrtc] ws error", err);
        this.emit("error", new Error("WebSocket error"));
      };
      socket.onmessage = (event) => {
        try {
          const message: IncomingMessage = JSON.parse(event.data);
          if (message.type === "signal") {
            void this.handleSignal(message as SignalMessage);
          } else {
            this.handleState(message as StateMessage);
          }
        } catch (err) {
          this.emit("error", err as Error);
        }
      };
    })();
  }

  disconnect() {
    this.stopBroadcast();
    this.broadcastEnabled = false;
    this.connections.forEach((pc) => pc.close());
    this.connections.clear();
    this.remoteStreams.forEach((stream) => stream.getTracks().forEach((t) => t.stop()));
    this.remoteStreams.clear();
    if (this.socket) {
      this.socket.close();
    }
  }

  async startBroadcast(constraints: MediaStreamConstraints = { video: true, audio: true }) {
    log("[webrtc] startBroadcast: requesting media", constraints);
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    log(
      "[webrtc] startBroadcast: obtained media",
      stream.getTracks().map((t) => ({ id: t.id, kind: t.kind, enabled: t.enabled }))
    );
    this.localStream = stream;
    this.broadcastEnabled = true;
    this.send({ type: "broadcast", enabled: true });
    this.peers
      .filter((id) => id !== this.peerId)
      .forEach((id) => {
        void this.sendOffer(id);
      });
    return stream;
  }

  stopBroadcast() {
    this.broadcastEnabled = false;
    this.send({ type: "broadcast", enabled: false });
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
    }
    this.localStream = undefined;

    this.connections.forEach((pc) => {
      pc.getSenders().forEach((sender) => {
        try {
          pc.removeTrack(sender);
        } catch {
          // ignore
        }
      });
    });
  }

  private send(payload: any) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      // Helpful debug hook for signaling payloads.
      log("[webrtc] send", payload);
      this.socket.send(JSON.stringify(payload));
    }
  }

  private ensureLocalTracks(pc: RTCPeerConnection) {
    const stream = this.localStream;
    if (!stream) return;
    const existing = pc.getSenders().map((s) => s.track?.id);
    stream.getTracks().forEach((track) => {
      if (!existing.includes(track.id)) {
        log("[webrtc] adding local track to pc", { id: track.id, kind: track.kind, pc: this.peerId });
        pc.addTrack(track, stream);
      }
    });
  }

  private async resolveWsURL(): Promise<string> {
    if (this.wsURL) return this.wsURL;
    const settings = await fetchSettings();
    if (settings?.wsURL) {
      this.wsURL = settings.wsURL;
      return this.wsURL;
    }
    const fallback = defaultWsURL();
    this.wsURL = fallback;
    return fallback;
  }

  private getOrCreateConnection(id: string) {
    let pc = this.connections.get(id);
    if (pc) return pc;

    pc = new RTCPeerConnection({ iceServers: this.iceServers });
    log("[webrtc] created RTCPeerConnection", { id });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        log("[webrtc] icecandidate", { id, candidate: event.candidate.type, sdpMid: event.candidate.sdpMid });
        this.send({ type: "signal", to: id, data: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      const [incoming] = event.streams;
      log("[webrtc] ontrack", {
        from: id,
        streams: event.streams.map((s) => s.id),
        trackId: event.track.id,
        trackKind: event.track.kind,
        trackReadyState: event.track.readyState
      });
      if (incoming) {
        const existing = this.remoteStreams.get(id);
        const stream = existing || incoming;
        // Ensure the stream we keep has the latest tracks.
        if (existing && incoming && existing !== incoming) {
          incoming.getTracks().forEach((t) => {
            if (!existing.getTracks().find((et) => et.id === t.id)) {
              existing.addTrack(t);
            }
          });
        }
        this.remoteStreams.set(id, stream);
        this.emit("remoteStream", { id, stream });
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc?.connectionState || "";
      if (["failed", "closed", "disconnected"].includes(state)) {
        this.removePeer(id);
      }
    };

    this.ensureLocalTracks(pc);

    this.connections.set(id, pc);
    return pc;
  }

  private async sendOffer(id: string) {
    if (!this.broadcastEnabled) return;
    const pc = this.getOrCreateConnection(id);
    this.ensureLocalTracks(pc);

    log("[webrtc] sendOffer ->", {
      to: id,
      localTracks: this.localStream?.getTracks().map((t) => ({ id: t.id, kind: t.kind })),
      senders: pc.getSenders().map((s) => ({ track: s.track?.id, kind: s.track?.kind }))
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    log("[webrtc] sending offer", { to: id, sdpHasVideo: offer.sdp?.includes("m=video"), sdpHasAudio: offer.sdp?.includes("m=audio") });
    this.send({ type: "signal", to: id, data: pc.localDescription });
  }

  private async handleSignal(msg: SignalMessage) {
    const pc = this.getOrCreateConnection(msg.from);
    const payload = msg.data;
    if (!payload) return;

    try {
      if ("sdp" in payload) {
        log("[webrtc] handleSignal sdp", {
          from: msg.from,
          type: payload.type,
          hasVideo: payload.sdp?.includes("m=video"),
          hasAudio: payload.sdp?.includes("m=audio")
        });
        await pc.setRemoteDescription(payload);
        if (payload.type === "offer") {
          this.ensureLocalTracks(pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          log("[webrtc] sending answer", {
            to: msg.from,
            hasVideo: answer.sdp?.includes("m=video"),
            hasAudio: answer.sdp?.includes("m=audio")
          });
          this.send({ type: "signal", to: msg.from, data: pc.localDescription });
        }
      } else if ("candidate" in payload) {
        log("[webrtc] handleSignal candidate", {
          from: msg.from,
          sdpMid: payload.sdpMid,
          sdpMLineIndex: payload.sdpMLineIndex
        });
        await pc.addIceCandidate(payload);
      }
    } catch (err) {
      this.emit("error", err as Error);
    }
  }

  private handleState(msg: StateMessage) {
    this.peers = msg.peers || this.peers;
    this.broadcasting = msg.broadcasting || this.broadcasting;

    if (msg.type === "welcome" && msg.id) {
      this.peerId = msg.id;
      if (msg.iceServers && msg.iceServers.length) {
        this.iceServers = msg.iceServers;
        this.iceMode = msg.iceMode;
      }
    }

    if (msg.type === "peer-left" && msg.id) {
      this.removePeer(msg.id);
    }

    if (msg.type === "broadcast-state" && msg.id && msg.enabled === false) {
      if (msg.id === this.peerId) {
        this.broadcastEnabled = false;
        if (this.localStream) {
          this.localStream.getTracks().forEach((t) => t.stop());
          this.localStream = undefined;
        }
      }
      this.removeRemoteStream(msg.id);
    }

    if (msg.type === "peer-joined" && msg.id) {
      void this.sendOffer(msg.id);
    }

    this.emit("state", msg);
  }

  private removeRemoteStream(id: string) {
    const stream = this.remoteStreams.get(id);
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      this.remoteStreams.delete(id);
      this.emit("remoteStreamRemoved", { id });
    }
  }

  private removePeer(id: string) {
    const pc = this.connections.get(id);
    if (pc) {
      pc.close();
      this.connections.delete(id);
    }
    this.removeRemoteStream(id);
  }

  private emit<K extends EventKey>(event: K, payload: WebRTCEventMap[K]) {
    this.events[event].forEach((handler) => {
      handler(payload as any);
    });
  }
}

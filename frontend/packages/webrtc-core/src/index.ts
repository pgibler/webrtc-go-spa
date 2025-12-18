export type SignalMessage = {
  type: "signal";
  from: string;
  to: string;
  data: any;
};

export type StateMessage = {
  type: "welcome" | "peer-joined" | "peer-left" | "broadcast-state" | string;
  id?: string;
  peers?: string[];
  broadcasting?: string[];
  enabled?: boolean;
  iceServers?: RTCIceServer[];
  iceMode?: string;
  [key: string]: unknown;
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
  private negotiation = new Map<
    string,
    {
      polite: boolean;
      makingOffer: boolean;
      ignoreOffer: boolean;
      isSettingRemoteAnswerPending: boolean;
      pendingCandidates: RTCIceCandidateInit[];
      offerRetryCount: number;
      offerRetryTimer?: ReturnType<typeof setTimeout>;
    }
  >();
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
      try {
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
      } catch (err) {
        this.emit("status", "Missing signaling URL");
        this.emit("error", err as Error);
      }
    })();
  }

  disconnect() {
    this.stopBroadcast();
    this.broadcastEnabled = false;
    this.connections.forEach((pc) => pc.close());
    this.connections.clear();
    this.remoteStreams.forEach((stream) => stream.getTracks().forEach((t) => t.stop()));
    this.remoteStreams.clear();
    for (const [, state] of this.negotiation) {
      if (state.offerRetryTimer) {
        clearTimeout(state.offerRetryTimer);
      }
    }
    this.negotiation.clear();
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

  private getNegotiationState(id: string) {
    let state = this.negotiation.get(id);
    if (state) return state;
    state = {
      polite: this.isPoliteForPeer(id),
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      pendingCandidates: [],
      offerRetryCount: 0
    };
    this.negotiation.set(id, state);
    return state;
  }

  private isPoliteForPeer(id: string) {
    if (!this.peerId) return true;
    return this.peerId.localeCompare(id) < 0;
  }

  private updatePoliteFlags() {
    for (const [id, s] of this.negotiation.entries()) {
      s.polite = this.isPoliteForPeer(id);
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
    throw new Error("WebRTCClient wsURL is required (pass wsURL in WebRTCClientOptions)");
  }

  private getOrCreateConnection(id: string) {
    let pc = this.connections.get(id);
    if (pc) return pc;

    pc = new RTCPeerConnection({ iceServers: this.iceServers });
    log("[webrtc] created RTCPeerConnection", { id });

    const negotiation = this.getNegotiationState(id);

    pc.onsignalingstatechange = () => {
      log("[webrtc] signalingstatechange", { id, signalingState: pc.signalingState });
    };

    pc.oniceconnectionstatechange = () => {
      log("[webrtc] iceconnectionstatechange", { id, iceConnectionState: pc.iceConnectionState });
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        log("[webrtc] icecandidate", { id, candidate: event.candidate.type, sdpMid: event.candidate.sdpMid });
        this.send({ type: "signal", to: id, data: event.candidate.toJSON() });
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
      log("[webrtc] connectionstatechange", { id, connectionState: state });
      // "disconnected" is often transient during ICE restarts / network blips; avoid tearing down immediately.
      if (["failed", "closed"].includes(state)) {
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
    const negotiation = this.getNegotiationState(id);
    if (negotiation.offerRetryTimer) {
      clearTimeout(negotiation.offerRetryTimer);
      negotiation.offerRetryTimer = undefined;
    }

    if (pc.signalingState !== "stable") {
      if (negotiation.offerRetryCount < 8) {
        negotiation.offerRetryCount += 1;
        log("[webrtc] sendOffer deferred (signaling not stable)", {
          to: id,
          attempt: negotiation.offerRetryCount,
          signalingState: pc.signalingState
        });
        negotiation.offerRetryTimer = setTimeout(() => {
          void this.sendOffer(id);
        }, 250);
      } else {
        logError("[webrtc] sendOffer giving up (signaling not stable)", { to: id, signalingState: pc.signalingState });
      }
      return;
    }

    if (negotiation.makingOffer) {
      log("[webrtc] sendOffer skipped (already makingOffer)", { to: id });
      return;
    }

    this.ensureLocalTracks(pc);

    log("[webrtc] sendOffer ->", {
      to: id,
      localTracks: this.localStream?.getTracks().map((t) => ({ id: t.id, kind: t.kind })),
      senders: pc.getSenders().map((s) => ({ track: s.track?.id, kind: s.track?.kind }))
    });

    negotiation.makingOffer = true;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      log("[webrtc] sending offer", {
        to: id,
        sdpHasVideo: offer.sdp?.includes("m=video"),
        sdpHasAudio: offer.sdp?.includes("m=audio")
      });
      this.send({ type: "signal", to: id, data: pc.localDescription });
    } finally {
      negotiation.makingOffer = false;
      negotiation.offerRetryCount = 0;
    }
  }

  private async handleSignal(msg: SignalMessage) {
    const pc = this.getOrCreateConnection(msg.from);
    const negotiation = this.getNegotiationState(msg.from);
    const payload = msg.data;
    if (!payload) return;

    try {
      if ("sdp" in payload) {
        const description = payload as RTCSessionDescriptionInit;
        log("[webrtc] handleSignal sdp", {
          from: msg.from,
          type: description.type,
          hasVideo: description.sdp?.includes("m=video"),
          hasAudio: description.sdp?.includes("m=audio")
        });

        const offerCollision =
          description.type === "offer" &&
          (negotiation.makingOffer || pc.signalingState !== "stable" || negotiation.isSettingRemoteAnswerPending);
        if (description.type === "offer") {
          log("[webrtc] offer check", {
            from: msg.from,
            offerCollision,
            polite: negotiation.polite,
            makingOffer: negotiation.makingOffer,
            isSettingRemoteAnswerPending: negotiation.isSettingRemoteAnswerPending,
            signalingState: pc.signalingState
          });
        }
        negotiation.ignoreOffer = !negotiation.polite && offerCollision;
        if (negotiation.ignoreOffer) {
          log("[webrtc] ignoring offer (glare, impolite)", { from: msg.from, signalingState: pc.signalingState });
          return;
        }

        // Perfect negotiation: if we're polite and collided, rollback our local offer and accept theirs.
        if (offerCollision && negotiation.polite) {
          log("[webrtc] glare rollback (polite)", { from: msg.from, signalingState: pc.signalingState });
          try {
            await pc.setLocalDescription({ type: "rollback" } as RTCSessionDescriptionInit);
          } catch (err) {
            logError("[webrtc] rollback failed", err);
          }
        }

        negotiation.isSettingRemoteAnswerPending = description.type === "answer";
        await pc.setRemoteDescription(description);
        negotiation.isSettingRemoteAnswerPending = false;

        if (negotiation.pendingCandidates.length > 0 && pc.remoteDescription) {
          log("[webrtc] flushing queued candidates", { from: msg.from, count: negotiation.pendingCandidates.length });
          const queued = negotiation.pendingCandidates.slice();
          negotiation.pendingCandidates = [];
          for (const cand of queued) {
            try {
              await pc.addIceCandidate(cand);
            } catch (err) {
              logError("[webrtc] queued addIceCandidate failed", err);
            }
          }
        }

        if (description.type === "offer") {
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
        if (negotiation.ignoreOffer) return;
        log("[webrtc] handleSignal candidate", {
          from: msg.from,
          sdpMid: payload.sdpMid,
          sdpMLineIndex: payload.sdpMLineIndex
        });
        const candidate = payload as RTCIceCandidateInit;
        if (!pc.remoteDescription) {
          negotiation.pendingCandidates.push(candidate);
          return;
        }
        await pc.addIceCandidate(candidate);
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
      this.updatePoliteFlags();
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

  sendAppMessage(payload: any) {
    this.send(payload);
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
    const negotiation = this.negotiation.get(id);
    if (negotiation?.offerRetryTimer) {
      clearTimeout(negotiation.offerRetryTimer);
    }
    this.negotiation.delete(id);
    this.removeRemoteStream(id);
  }

  private emit<K extends EventKey>(event: K, payload: WebRTCEventMap[K]) {
    this.events[event].forEach((handler) => {
      handler(payload as any);
    });
  }
}

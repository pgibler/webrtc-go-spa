import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { createWebRTC } from "../packages/solid-webrtc/src";

const VideoTile = (props: { label: string; stream: MediaStream; muted?: boolean }) => {
  let videoRef: HTMLVideoElement | undefined;

  createEffect(() => {
    if (!videoRef) return;
    const stream = props.stream;
    if (!(stream instanceof MediaStream)) return;
    if (videoRef.srcObject !== stream) {
      videoRef.srcObject = stream;
      void videoRef.play().catch(() => {
        // ignore autoplay errors
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

const RoomUI = () => {
  const {
    peerId,
    peers,
    broadcasting,
    connected,
    status,
    remoteStreams,
    localStream,
    broadcastEnabled,
    startBroadcast,
    stopBroadcast
  } = createWebRTC();

  const peerEntries = createMemo(() => Array.from(remoteStreams()));
  const [showPeers, setShowPeers] = createSignal(false);

  createEffect(() => {
    if (peers().length === 0) setShowPeers(false);
  });

  return (
    <>
      <header class="panel app-bar">
        <div class="brand">
          <div class="app-name">videochat</div>
          <div class="id-line">
            <span class="label">Your ID</span>
            <strong>{peerId() || "..."}</strong>
          </div>
        </div>
        <div class="bar-controls">
          <button class="peer-chip" type="button" onClick={() => setShowPeers((open) => !open)}>
            <span class="label">Peers</span>
            <span class="value">{peers().length}</span>
            <span class="chevron">{showPeers() ? "v" : ">"}</span>
          </button>
          <button
            class={`live-btn ${broadcastEnabled() ? "on" : ""}`}
            onClick={() => (broadcastEnabled() ? stopBroadcast() : void startBroadcast())}
          >
            {broadcastEnabled() ? "Stop" : "Go Live"}
          </button>
        </div>
        <div class="ws-pill" data-connected={connected() ? "true" : "false"}>
          <span class="dot" />
          <span>{connected() ? "Live" : "Offline"}</span>
        </div>
      </header>

      <Show when={showPeers()}>
        <div class="panel peer-drawer">
          <div class="drawer-heading">
            <div class="flex flex-row space-between">
              <span>Peers in room</span>
            </div>
            <span class="count">{peers().length}</span>
          </div>
          <div class="peer-list compact">
            <Show when={peers().length} fallback={<span class="status">Waiting for peers...</span>}>
              <For each={peers()}>{(id) => <span class="pill small">{id}</span>}</For>
            </Show>
          </div>
        </div>
      </Show>

      <div class="panel">
        <h3>Live Streams</h3>
        <div class="videos">
          <Show when={localStream()}>
            {(stream) => <VideoTile label="You" stream={stream()} muted />}
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
    </>
  );
};

const JoinRoomPrompt = (props: { onJoin: () => void }) => (
  <div class="panel join-panel">
    <h1>videochat</h1>
    <p class="lede">
      Connect to the signaling server to get your peer ID, discover other participants, and start broadcasting.
    </p>
    <div class="controls">
      <button onClick={props.onJoin}>Join room</button>
    </div>
    <div class="status hint">Media permissions are requested only after you join.</div>
    <div class="status hint">
      Browsers require a user gesture before media can autoplay; this join button provides that step so streams can start
      once connected.
    </div>
  </div>
);

export default function App() {
  const [joined, setJoined] = createSignal(false);

  return (
    <main class={`page ${joined() ? "" : "landing"}`}>
      <Show when={joined()} fallback={<JoinRoomPrompt onJoin={() => setJoined(true)} />}>
        <RoomUI />
      </Show>
    </main>
  );
}

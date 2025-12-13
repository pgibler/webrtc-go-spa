import { For, Show, createEffect, createMemo } from "solid-js";
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

export default function App() {
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

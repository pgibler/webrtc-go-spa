import { For, Show, Accessor, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
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

type Route =
  | { view: "landing" }
  | {
      view: "room";
      code: string;
    };

const parseRoute = (): Route => {
  const segments = window.location.pathname.split("/").filter(Boolean);
  if (segments[0] === "rooms" && segments[1]) {
    return { view: "room", code: decodeURIComponent(segments[1]) };
  }
  return { view: "landing" };
};

const useRoute = () => {
  const [route, setRoute] = createSignal<Route>(parseRoute());

  onMount(() => {
    const handler = () => setRoute(parseRoute());
    window.addEventListener("popstate", handler);
    onCleanup(() => window.removeEventListener("popstate", handler));
  });

  const navigate = (next: Route) => {
    if (next.view === "landing") {
      window.history.pushState({}, "", "/");
    } else {
      window.history.pushState({}, "", `/rooms/${encodeURIComponent(next.code)}`);
    }
    setRoute(next);
  };

  return { route, navigate };
};

const RoomUI = (props: { username: string; roomCode: string; roomURL: string; wsURL: string }) => {
  const {
    peerId,
    peers,
    broadcasting,
    connected,
    remoteStreams,
    localStream,
    broadcastEnabled,
    startBroadcast,
    stopBroadcast,
    client
  } = createWebRTC({ wsURL: props.wsURL });

  const peerEntries = createMemo(() => Array.from(remoteStreams()));
  const [showPeers, setShowPeers] = createSignal(false);
  const [usernames, setUsernames] = createSignal<Record<string, string>>({});
  const [copied, setCopied] = createSignal(false);

  createEffect(() => {
    if (peers().length === 0) setShowPeers(false);
  });

  createEffect(() => {
    const off = client.on("state", (msg: any) => {
      const data = msg as { type: string; id?: string; usernames?: Record<string, string> };
      if (data.usernames) {
        setUsernames((prev) => ({ ...prev, ...data.usernames }));
      }
      if (data.type === "peer-left" && data.id) {
        setUsernames((prev) => {
          const next = { ...prev };
          delete next[data.id];
          return next;
        });
      }
    });
    return () => off();
  });

  const selfLabel = () => `${displayName()} (you)`;

  createEffect(() => {
    const id = peerId();
    if (props.username && id) {
      setUsernames((prev) => ({ ...prev, [id]: props.username }));
    }
  });

  createEffect(() => {
    if (props.username && connected()) {
      client.sendAppMessage({ type: "set-username", username: props.username });
    }
  });

  const displayName = () => {
    const id = peerId();
    if (!id) return props.username || "...";
    return usernames()[id] || props.username || id;
  };

  const labelForPeer = (id: string) => {
    const name = usernames()[id] || (id === peerId() ? displayName() : id);
    if (id === peerId() && name) {
      return `${name} (you)`;
    }
    return name;
  };

  const copyRoomLink = async () => {
    try {
      await navigator.clipboard.writeText(props.roomURL);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <header class="panel app-bar">
        <div class="brand">
          <div class="app-name">videochat</div>
          <div class="brand-meta">
            <div class="id-line">
              <span class="label">You</span>
              <strong>{displayName()}</strong>
            </div>
            <button class={`room-chip ${copied() ? "copied" : ""}`} type="button" onClick={() => void copyRoomLink()}>
              <span class="label">Room</span>
              <span class="code">{copied() ? "Copied" : props.roomCode}</span>
              <span class="icon" aria-hidden="true">
                <Show
                  when={copied()}
                  fallback={
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M18 13v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                  }
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </Show>
              </span>
              <span class="sr-only">Copy room link</span>
            </button>
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
              <For each={peers()}>
                {(id) => <span class="pill small">{labelForPeer(id)}</span>}
              </For>
            </Show>
          </div>
        </div>
      </Show>

      <div class="panel">
        <h3>Live Streams</h3>
        <div class="videos">
          <Show when={localStream()}>
            {(stream) => <VideoTile label={selfLabel()} stream={stream()} muted />}
          </Show>
          <For each={peerEntries()}>
            {([id, stream]) => (
              <VideoTile label={labelForPeer(id)} stream={stream} muted={id === peerId()} />
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

const JoinRoomPrompt = (props: { onJoin: (username: string) => void; roomCode?: string; disabled?: boolean }) => {
  const [name, setName] = createSignal("");

  const handleSubmit = (evt: Event) => {
    evt.preventDefault();
    const value = name().trim();
    if (!value) return;
    props.onJoin(value);
  };

  return (
    <form class="panel join-panel" onSubmit={handleSubmit}>
      <h1>videochat</h1>
      <p class="lede">Enter a display name, join the room, and start broadcasting.</p>
      <Show when={props.roomCode}>
        <div class="pill muted">Joining room {props.roomCode}</div>
      </Show>
      <label class="field">
        <span class="label">Display name</span>
        <input
          class="text-input"
          name="username"
          autocomplete="name"
          value={name()}
          onInput={(evt) => setName(evt.currentTarget.value)}
          placeholder="e.g. Paul"
          required
        />
      </label>
      <div class="controls">
        <button type="submit" disabled={!name().trim() || props.disabled}>
          Join room
        </button>
      </div>
      <div class="status hint">Media permissions are requested only after you join.</div>
    </form>
  );
};

const Landing = (props: { onCreateRoom: () => void; creating: boolean; error?: string }) => (
  <div class="panel hero">
    <div class="hero-body">
      <div>
        <p class="kicker">videochat - Private video chat</p>
        <h1 class="headline">Create a room and start broadcasting in seconds.</h1>
        <p class="lede">
          Only people with your link can join. Create a room, copy the link, share with your friends, and go live.
        </p>
        <div class="controls">
          <button type="button" onClick={() => props.onCreateRoom()} disabled={props.creating}>
            {props.creating ? "Creating room..." : "Create private room"}
          </button>
        </div>
        <Show when={props.error}>
          <div class="status error">{props.error}</div>
        </Show>
      </div>
    </div>
  </div>
);

const MissingRoom = (props: { onCreateNew: () => void; code: string }) => (
  <div class="panel join-panel">
    <h1>Room not found</h1>
    <p class="lede">The room code "{props.code}" does not exist or has expired. Start a new private room.</p>
    <div class="controls">
      <button type="button" onClick={() => props.onCreateNew()}>
        Create new room
      </button>
    </div>
  </div>
);

const defaultRoomURL = (code: string) => {
  const base = window.location.origin || "http://localhost:8080";
  return `${base}/rooms/${encodeURIComponent(code)}`;
};

const resolveRoomWsURL = async (code: string) => {
  try {
    const res = await fetch("/api/settings", { headers: { Accept: "application/json" } });
    if (res.ok) {
      const data = (await res.json()) as { wsURL?: string };
      const base = data.wsURL || "";
      if (base) {
        try {
          const url = new URL(base);
          url.searchParams.set("room", code);
          return url.toString();
        } catch {
          // fall through
        }
      }
    }
  } catch {
    // ignore
  }

  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const host = window.location.host || "localhost:8080";
  const wsBase = `${proto}://${host}/ws`;
  const url = new URL(wsBase);
  url.searchParams.set("room", code);
  return url.toString();
};

const SwitchRoomView = (props: {
  route: Extract<Route, { view: "room" }>;
  joined: Accessor<boolean>;
  roomStatus: Accessor<"idle" | "checking" | "ready" | "missing" | "error">;
  wsURL: Accessor<string>;
  roomURL: Accessor<string>;
  onCreateNew: () => void;
  onJoin: (name: string) => void;
  username: string;
}) => {
  return (
    <Switch>
      <Match when={props.roomStatus() === "checking" || props.roomStatus() === "idle"}>
        {console.log("[room] render loading", props.roomStatus())}
        <div class="panel join-panel">
          <div class="status">Loading room...</div>
        </div>
      </Match>

      <Match when={props.roomStatus() === "missing"}>
        {console.warn("[room] render missing", props.route.code)}
        <MissingRoom code={props.route.code} onCreateNew={props.onCreateNew} />
      </Match>

      <Match when={props.roomStatus() === "error"}>
        {console.error("[room] render error", props.route.code)}
        <div class="panel join-panel">
          <div class="status error">Failed to load this room. Try again shortly.</div>
        </div>
      </Match>

      <Match when={props.roomStatus() === "ready"}>
        {console.log("[room] render ready?", props.joined(), props.wsURL())}
        <Show
          when={props.joined() && props.wsURL()}
          fallback={
            <JoinRoomPrompt
              roomCode={props.route.code}
              onJoin={props.onJoin}
              disabled={!props.wsURL() || props.roomStatus() !== "ready"}
            />
          }
        >
          <RoomUI
            username={props.username}
            roomCode={props.route.code}
            roomURL={props.roomURL() || defaultRoomURL(props.route.code)}
            wsURL={props.wsURL()}
          />
        </Show>
      </Match>
    </Switch>
  );
};

export default function App() {
  const { route, navigate } = useRoute();
  const [joined, setJoined] = createSignal(false);
  const [username, setUsername] = createSignal("");
  const [roomURL, setRoomURL] = createSignal("");
  const [wsURL, setWsURL] = createSignal("");
  const [roomStatus, setRoomStatus] = createSignal<"idle" | "checking" | "ready" | "missing" | "error">("idle");
  const [roomError, setRoomError] = createSignal("");
  const [creatingRoom, setCreatingRoom] = createSignal(false);

  createEffect(() => {
    const r = route();
    if (r.view !== "room") {
      setJoined(false);
      setUsername("");
      setRoomStatus("idle");
      setRoomError("");
      setWsURL("");
      setRoomURL("");
      return;
    }

    const code = r.code;
    let cancelled = false;
    setJoined(false);
    setRoomStatus("checking");
    setRoomError("");

    (async () => {
      try {
        console.log("[room] fetch start", code);
        const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`, {
          headers: { Accept: "application/json" }
        });
        if (cancelled) return;
        if (res.status === 404) {
          setRoomStatus("missing");
          return;
        }
        if (!res.ok) {
          throw new Error(`status ${res.status}`);
        }
        const text = await res.text();
        console.log("[room] fetch ok", text);
        const data = JSON.parse(text) as { url?: string };
        setRoomURL(data.url || defaultRoomURL(code));
        setRoomStatus("ready");
        console.log("[room] status ready", code);
      } catch (err) {
        if (cancelled) return;
        setRoomStatus("error");
        setRoomError("Failed to load room. Try refreshing the page.");
        console.error("[room] fetch error", err);
        return;
      }

      try {
        console.log("[room] settings fetch start");
        const resolved = await resolveRoomWsURL(code);
        if (!cancelled) {
          setWsURL(resolved);
          console.log("[room] ws url set", resolved);
        }
      } catch {
        if (!cancelled) {
          const fallback = defaultRoomURL(code).replace(/^http/, "ws");
          setWsURL(fallback);
          console.warn("[room] ws url fallback", fallback);
        }
      }
    })();

    onCleanup(() => {
      cancelled = true;
    });
  });

  const handleCreateRoom = async () => {
    setCreatingRoom(true);
    setRoomError("");
    try {
      const res = await fetch("/api/rooms", { method: "POST" });
      if (!res.ok) {
        throw new Error(`status ${res.status}`);
      }
      const data = (await res.json()) as { code: string; url?: string };
      const code = data.code;
      const url = data.url || defaultRoomURL(code);
      navigate({ view: "room", code });
      setRoomURL(url);
    } catch (err) {
      setRoomError("Could not create room. Check your connection and try again.");
    } finally {
      setCreatingRoom(false);
    }
  };

  return (
    <main class={`page ${joined() ? "" : "landing"}`}>
      <Show when={route().view === "landing"}>
        <Landing onCreateRoom={handleCreateRoom} creating={creatingRoom()} error={roomError()} />
      </Show>

      <Show when={route().view === "room"}>
        <SwitchRoomView
          route={route() as Extract<Route, { view: "room" }>}
          joined={joined}
          roomStatus={roomStatus}
          wsURL={wsURL}
          roomURL={roomURL}
          onCreateNew={handleCreateRoom}
          onJoin={(name) => {
            setUsername(name);
            setJoined(true);
          }}
          username={username()}
        />
      </Show>
    </main>
  );
}

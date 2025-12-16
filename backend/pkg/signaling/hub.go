package signaling

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const (
	defaultReadLimit   = 64 * 1024
	pingInterval       = 40 * time.Second
	writeTimeout       = 10 * time.Second
	upgradeReadBuffer  = 1024
	upgradeWriteBuffer = 1024
)

// HubOptions configures a Hub instance.
type HubOptions struct {
	ICEServers []ICEServer
	ICEMode    string
	Logger     *log.Logger
	Upgrader   *websocket.Upgrader
	OnEmpty    func()
}

// ConnOptions controls how a connection is registered.
type ConnOptions struct {
	// ID overrides the generated peer ID (useful for authenticated callers).
	ID string
	// Context lets the caller cancel the connection (defaults to Background).
	Context context.Context
}

// Hub manages WebSocket peers and signaling fanout.
type Hub struct {
	mu         sync.RWMutex
	clients    map[string]*client
	store      PresenceStore
	iceServers []ICEServer
	iceMode    string
	upgrader   websocket.Upgrader
	logger     *log.Logger
	onEmpty    func()
}

type client struct {
	id     string
	conn   *websocket.Conn
	send   chan []byte
	ctx    context.Context
	cancel context.CancelFunc
}

// NewHub builds a signaling Hub with the provided store and options.
func NewHub(store PresenceStore, opts HubOptions) *Hub {
	upgrader := websocket.Upgrader{
		ReadBufferSize:  upgradeReadBuffer,
		WriteBufferSize: upgradeWriteBuffer,
		CheckOrigin: func(r *http.Request) bool {
			return true
		},
	}
	if opts.Upgrader != nil {
		upgrader = *opts.Upgrader
	}
	logger := opts.Logger
	if logger == nil {
		logger = log.Default()
	}

	return &Hub{
		clients:    make(map[string]*client),
		store:      store,
		iceServers: opts.ICEServers,
		iceMode:    opts.ICEMode,
		upgrader:   upgrader,
		logger:     logger,
		onEmpty:    opts.OnEmpty,
	}
}

// HTTPHandler upgrades HTTP connections and registers them with the Hub.
func (h *Hub) HTTPHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := h.upgrader.Upgrade(w, r, nil)
		if err != nil {
			h.logger.Printf("upgrade error: %v", err)
			return
		}
		// Use a background context so the connection isn't canceled when the HTTP handler returns.
		if err := h.Accept(conn, ConnOptions{}); err != nil {
			h.logger.Printf("accept error: %v", err)
			conn.Close()
		}
	})
}

// Accept registers an already-upgraded WebSocket connection (useful when auth/guards are handled elsewhere).
func (h *Hub) Accept(conn *websocket.Conn, opts ConnOptions) error {
	ctx := opts.Context
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithCancel(ctx)
	id := opts.ID
	if id == "" {
		id = uuid.NewString()
	}
	c := &client{
		id:     id,
		conn:   conn,
		send:   make(chan []byte, 32),
		ctx:    ctx,
		cancel: cancel,
	}

	if err := h.register(ctx, c); err != nil {
		cancel()
		return err
	}

	go c.writePump()
	go c.readPump(h)
	return nil
}

func (h *Hub) register(ctx context.Context, c *client) error {
	h.mu.Lock()
	h.clients[c.id] = c
	h.mu.Unlock()

	if err := h.store.AddPeer(ctx, c.id); err != nil {
		return err
	}

	peers, broadcasting, usernames, err := h.store.State(ctx)
	if err != nil {
		h.logger.Printf("presence state error: %v", err)
	}

	h.logger.Printf("ws: registered %s (peers=%d broadcasting=%d)", c.id, len(peers), len(broadcasting))

	welcome := StateMessage{
		Type:         "welcome",
		ID:           c.id,
		Peers:        peers,
		Broadcasting: broadcasting,
		ICEServers:   h.iceServers,
		ICEMode:      h.iceMode,
		Usernames:    usernames,
	}
	c.sendJSON(welcome)

	join := StateMessage{
		Type:         "peer-joined",
		ID:           c.id,
		Peers:        peers,
		Broadcasting: broadcasting,
		Usernames:    usernames,
	}
	h.broadcast(join, c.id)
	return nil
}

func (h *Hub) unregister(c *client) {
	ctx := context.Background()

	h.mu.Lock()
	delete(h.clients, c.id)
	h.mu.Unlock()

	if err := h.store.RemovePeer(ctx, c.id); err != nil {
		h.logger.Printf("presence remove: %v", err)
	}

	peers, broadcasting, usernames, err := h.store.State(ctx)
	if err != nil {
		h.logger.Printf("presence state error: %v", err)
	}

	leave := StateMessage{
		Type:         "peer-left",
		ID:           c.id,
		Peers:        peers,
		Broadcasting: broadcasting,
		Usernames:    usernames,
	}
	h.broadcast(leave, c.id)
	h.logger.Printf("ws: unregistered %s (peers=%d broadcasting=%d)", c.id, len(peers), len(broadcasting))

	if len(peers) == 0 && h.onEmpty != nil {
		h.onEmpty()
	}
}

func (h *Hub) broadcast(msg interface{}, skipID string) {
	data, err := json.Marshal(msg)
	if err != nil {
		h.logger.Printf("marshal broadcast: %v", err)
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for id, cl := range h.clients {
		if id == skipID {
			continue
		}
		select {
		case cl.send <- data:
		default:
			h.logger.Printf("client send buffer full for %s, dropping message", id)
		}
	}
}

func (h *Hub) handleInbound(c *client, msg InboundMessage) {
	h.logger.Printf("ws: inbound type=%s from=%s to=%s enabled=%v", msg.Type, c.id, msg.To, msg.Enabled)
	switch msg.Type {
	case "signal":
		if msg.To == "" || len(msg.Data) == 0 {
			return
		}
		h.forwardSignal(c.id, msg.To, msg.Data)
	case "broadcast":
		if msg.Enabled == nil {
			return
		}
		h.updateBroadcast(c.id, *msg.Enabled)
	case "set-username":
		username := strings.TrimSpace(msg.Username)
		ctx := context.Background()
		if err := h.store.SetUsername(ctx, c.id, username); err != nil {
			h.logger.Printf("presence set username: %v", err)
		}
		h.publishPresence(ctx, c.id, "usernames")
	default:
		h.logger.Printf("unknown message type from %s: %s", c.id, msg.Type)
	}
}

func (h *Hub) forwardSignal(from, to string, payload json.RawMessage) {
	h.mu.RLock()
	target := h.clients[to]
	h.mu.RUnlock()
	if target == nil {
		h.logger.Printf("ws: forward signal target missing %s -> %s", from, to)
		return
	}

	msg := SignalMessage{
		Type: "signal",
		From: from,
		To:   to,
		Data: payload,
	}
	target.sendJSON(msg)
}

func (h *Hub) updateBroadcast(id string, enabled bool) {
	ctx := context.Background()
	if err := h.store.SetBroadcast(ctx, id, enabled); err != nil {
		h.logger.Printf("presence update broadcast: %v", err)
	}
	h.logger.Printf("ws: broadcast state id=%s enabled=%v", id, enabled)

	peers, broadcasting, usernames, err := h.store.State(ctx)
	if err != nil {
		h.logger.Printf("presence state error: %v", err)
	}

	state := StateMessage{
		Type:         "broadcast-state",
		ID:           id,
		Enabled:      &enabled,
		Peers:        peers,
		Broadcasting: broadcasting,
		Usernames:    usernames,
	}
	h.broadcast(state, "")
}

func (h *Hub) publishPresence(ctx context.Context, id string, eventType string) {
	peers, broadcasting, usernames, err := h.store.State(ctx)
	if err != nil {
		h.logger.Printf("presence state error: %v", err)
	}

	state := StateMessage{
		Type:         eventType,
		ID:           id,
		Peers:        peers,
		Broadcasting: broadcasting,
		Usernames:    usernames,
	}
	h.broadcast(state, "")
}

func (c *client) readPump(h *Hub) {
	defer func() {
		h.unregister(c)
		c.conn.Close()
		close(c.send)
		c.cancel()
	}()

	c.conn.SetReadLimit(defaultReadLimit)
	_ = c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		_ = c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		select {
		case <-c.ctx.Done():
			return
		default:
		}
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				return
			}
			if !errors.Is(err, websocket.ErrCloseSent) {
				h.logger.Printf("read error from %s: %v", c.id, err)
			}
			return
		}

		var msg InboundMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			h.logger.Printf("bad payload from %s: %v", c.id, err)
			continue
		}
		h.handleInbound(c, msg)
	}
}

func (c *client) writePump() {
	ticker := time.NewTicker(pingInterval)
	defer func() {
		ticker.Stop()
		_ = c.conn.Close()
	}()

	for {
		select {
		case <-c.ctx.Done():
			return
		case msg, ok := <-c.send:
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *client) sendJSON(v interface{}) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	select {
	case c.send <- data:
	default:
	}
}

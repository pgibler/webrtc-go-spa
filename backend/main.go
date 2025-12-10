package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

const (
	peerSetKey        = "webrtc:peers"
	broadcastingKey   = "webrtc:broadcasting"
	defaultStaticPath = "../frontend/dist"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

type hub struct {
	mu      sync.RWMutex
	clients map[string]*client
	redis   *redis.Client
}

type client struct {
	id   string
	conn *websocket.Conn
	send chan []byte
}

type inboundMessage struct {
	Type    string          `json:"type"`
	To      string          `json:"to,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
	Enabled *bool           `json:"enabled,omitempty"`
}

type statePayload struct {
	Type         string   `json:"type"`
	ID           string   `json:"id,omitempty"`
	Peers        []string `json:"peers,omitempty"`
	Broadcasting []string `json:"broadcasting,omitempty"`
	Enabled      *bool    `json:"enabled,omitempty"`
}

type signalPayload struct {
	Type string          `json:"type"`
	From string          `json:"from"`
	To   string          `json:"to"`
	Data json.RawMessage `json:"data"`
}

func main() {
	loadEnv()
	cfg := loadConfig()

	rdb := redis.NewClient(&redis.Options{
		Addr: cfg.RedisAddr,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Fatalf("redis ping failed: %v", err)
	}

	h := &hub{
		clients: make(map[string]*client),
		redis:   rdb,
	}

	http.Handle("/ws", h.handleWebsocket())
	http.Handle("/", spaHandler(cfg.StaticPath))

	log.Printf("listening on %s (static: %s)", cfg.Addr, cfg.StaticPath)
	if err := http.ListenAndServe(cfg.Addr, nil); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

type config struct {
	Addr       string
	RedisAddr  string
	StaticPath string
}

func loadConfig() config {
	addr := getenv("ADDR", ":8080")
	redisAddr := getenv("REDIS_ADDR", "localhost:6379")
	staticDir := getenv("STATIC_DIR", defaultStaticPath)
	return config{
		Addr:       addr,
		RedisAddr:  redisAddr,
		StaticPath: staticDir,
	}
}

func getenv(key, fallback string) string {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	return v
}

func loadEnv() {
	paths := []string{
		".env",
		filepath.Join("backend", ".env"),
		"../.env",
	}
	for _, p := range paths {
		if err := loadEnvFile(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			log.Printf("env load warning for %s: %v", p, err)
		}
	}
}

func loadEnvFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		val := strings.TrimSpace(parts[1])
		if key == "" {
			continue
		}
		if _, exists := os.LookupEnv(key); !exists {
			_ = os.Setenv(key, val)
		}
	}
	return scanner.Err()
}

func (h *hub) handleWebsocket() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("upgrade error: %v", err)
			return
		}

		id := uuid.NewString()
		c := &client{
			id:   id,
			conn: conn,
			send: make(chan []byte, 32),
		}

		if err := h.register(r.Context(), c); err != nil {
			log.Printf("register error: %v", err)
			conn.Close()
			return
		}

		go c.writePump()
		c.readPump(h)
	})
}

func (h *hub) register(ctx context.Context, c *client) error {
	h.mu.Lock()
	h.clients[c.id] = c
	h.mu.Unlock()

	if err := h.redis.SAdd(ctx, peerSetKey, c.id).Err(); err != nil {
		return fmt.Errorf("redis sadd peer: %w", err)
	}

	peers, broadcasting := h.currentState(ctx)

	welcome := statePayload{
		Type:         "welcome",
		ID:           c.id,
		Peers:        peers,
		Broadcasting: broadcasting,
	}
	c.sendJSON(welcome)

	join := statePayload{
		Type:         "peer-joined",
		ID:           c.id,
		Peers:        peers,
		Broadcasting: broadcasting,
	}
	h.broadcast(join, c.id)
	return nil
}

func (h *hub) unregister(c *client) {
	ctx := context.Background()

	h.mu.Lock()
	delete(h.clients, c.id)
	h.mu.Unlock()

	// Remove presence from Redis.
	h.redis.SRem(ctx, peerSetKey, c.id)
	h.redis.SRem(ctx, broadcastingKey, c.id)

	peers, broadcasting := h.currentState(ctx)

	leave := statePayload{
		Type:         "peer-left",
		ID:           c.id,
		Peers:        peers,
		Broadcasting: broadcasting,
	}
	h.broadcast(leave, c.id)
}

func (h *hub) broadcast(msg interface{}, skipID string) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("marshal broadcast: %v", err)
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
			log.Printf("client send buffer full for %s, dropping message", id)
		}
	}
}

func (h *hub) currentState(ctx context.Context) ([]string, []string) {
	peers, err := h.redis.SMembers(ctx, peerSetKey).Result()
	if err != nil {
		log.Printf("redis smembers peers: %v", err)
	}
	broadcasting, err := h.redis.SMembers(ctx, broadcastingKey).Result()
	if err != nil {
		log.Printf("redis smembers broadcasting: %v", err)
	}
	return peers, broadcasting
}

func (h *hub) handleInbound(c *client, msg inboundMessage) {
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
	default:
		log.Printf("unknown message type from %s: %s", c.id, msg.Type)
	}
}

func (h *hub) forwardSignal(from, to string, payload json.RawMessage) {
	h.mu.RLock()
	target := h.clients[to]
	h.mu.RUnlock()
	if target == nil {
		return
	}

	msg := signalPayload{
		Type: "signal",
		From: from,
		To:   to,
		Data: payload,
	}
	target.sendJSON(msg)
}

func (h *hub) updateBroadcast(id string, enabled bool) {
	ctx := context.Background()
	var err error
	if enabled {
		err = h.redis.SAdd(ctx, broadcastingKey, id).Err()
	} else {
		err = h.redis.SRem(ctx, broadcastingKey, id).Err()
	}
	if err != nil {
		log.Printf("redis update broadcast: %v", err)
	}

	peers, broadcasting := h.currentState(ctx)
	state := statePayload{
		Type:         "broadcast-state",
		ID:           id,
		Enabled:      &enabled,
		Peers:        peers,
		Broadcasting: broadcasting,
	}
	h.broadcast(state, "")
}

func (c *client) readPump(h *hub) {
	defer func() {
		h.unregister(c)
		c.conn.Close()
		close(c.send)
	}()

	c.conn.SetReadLimit(64 * 1024)
	c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				return
			}
			if !errors.Is(err, websocket.ErrCloseSent) {
				log.Printf("read error from %s: %v", c.id, err)
			}
			return
		}

		var msg inboundMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("bad payload from %s: %v", c.id, err)
			continue
		}
		h.handleInbound(c, msg)
	}
}

func (c *client) writePump() {
	ticker := time.NewTicker(40 * time.Second)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.send:
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				log.Printf("write error to %s: %v", c.id, err)
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *client) sendJSON(v interface{}) {
	data, err := json.Marshal(v)
	if err != nil {
		log.Printf("marshal sendJSON: %v", err)
		return
	}
	select {
	case c.send <- data:
	default:
		log.Printf("send buffer full for %s", c.id)
	}
}

func spaHandler(staticDir string) http.Handler {
	fs := http.FileServer(http.Dir(staticDir))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Serve the WebSocket endpoint separately.
		if r.URL.Path == "/ws" {
			w.WriteHeader(http.StatusNotFound)
			return
		}

		path := filepath.Join(staticDir, filepath.Clean(r.URL.Path))
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			fs.ServeHTTP(w, r)
			return
		}

		index := filepath.Join(staticDir, "index.html")
		http.ServeFile(w, r, index)
	})
}

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

	"github.com/redis/go-redis/v9"

	"videochat/pkg/rooms"
	"videochat/pkg/signaling"
)

const defaultStaticPath = "../frontend/dist"

func main() {
	loadEnv()
	cfg := loadConfig()
	logConfig(cfg)

	rdb := redis.NewClient(&redis.Options{
		Addr: cfg.RedisAddr,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Fatalf("redis ping failed: %v", err)
	}

	roomStore := rooms.NewRedisStore(rdb, "webrtc")
	hubs := newHubManager(rdb, signaling.HubOptions{
		ICEServers: cfg.ICEServers,
		ICEMode:    cfg.ICEMode,
	})

	http.Handle("/ws", wsHandler(hubs, roomStore))
	http.Handle("/api/settings", settingsHandler(cfg))
	http.Handle("/api/rooms", createRoomHandler(roomStore))
	http.Handle("/api/rooms/", roomLookupHandler(roomStore))
	http.Handle("/debug/ice", debugICE(cfg))
	http.Handle("/", spaHandler(cfg.StaticPath))

	log.Printf("listening on %s (static: %s)", cfg.Addr, cfg.StaticPath)
	if err := http.ListenAndServe(cfg.Addr, nil); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

type config struct {
	Addr        string
	RedisAddr   string
	StaticPath  string
	ICEServers  []signaling.ICEServer
	ICEMode     string
	PublicWSURL string
}

func loadConfig() config {
	addr := getenv("ADDR", ":8080")
	redisAddr := getenv("REDIS_ADDR", "localhost:6379")
	staticDir := getenv("STATIC_DIR", defaultStaticPath)
	iceMode := strings.TrimSpace(os.Getenv("ICE_MODE"))
	if iceMode == "" {
		iceMode = "stun-turn"
	}
	publicWS := strings.TrimSpace(os.Getenv("WS_PUBLIC_URL"))
	return config{
		Addr:        addr,
		RedisAddr:   redisAddr,
		StaticPath:  staticDir,
		ICEServers:  loadICEServers(iceMode),
		ICEMode:     iceMode,
		PublicWSURL: publicWS,
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

func loadICEServers(iceMode string) []signaling.ICEServer {
	defaultSTUN := []string{"stun:stun.l.google.com:19302"}

	stunEnv := strings.TrimSpace(os.Getenv("STUN_URLS"))
	turnEnv := strings.TrimSpace(os.Getenv("TURN_URLS"))
	turnUsername := strings.TrimSpace(os.Getenv("TURN_USERNAME"))
	turnPassword := strings.TrimSpace(os.Getenv("TURN_PASSWORD"))

	var servers []signaling.ICEServer
	turnOnly := strings.EqualFold(iceMode, "turn-only")
	stunOnly := strings.EqualFold(iceMode, "stun-only")

	if !turnOnly {
		if stunEnv != "" {
			stunURLs := splitAndClean(stunEnv)
			if len(stunURLs) > 0 {
				servers = append(servers, signaling.ICEServer{URLs: stunURLs})
			}
		} else {
			servers = append(servers, signaling.ICEServer{URLs: defaultSTUN})
		}
	}

	if !stunOnly {
		if turnEnv != "" {
			turnURLs := splitAndClean(turnEnv)
			if len(turnURLs) > 0 {
				servers = append(servers, signaling.ICEServer{
					URLs:       turnURLs,
					Username:   turnUsername,
					Credential: turnPassword,
				})
			}
		} else if !turnOnly {
			log.Printf("TURN not configured; set TURN_URLS and credentials for relay fallback")
		}
	}

	if turnOnly && len(servers) == 0 {
		log.Printf("ICE_MODE=turn-only set but no TURN servers are configured; falling back to default STUN")
		servers = append(servers, signaling.ICEServer{URLs: defaultSTUN})
	}

	log.Printf("ICE servers loaded (mode=%s): %+v", iceMode, servers)
	return servers
}

func logConfig(cfg config) {
	turnConfigured := false
	for _, s := range cfg.ICEServers {
		if s.Username != "" || s.Credential != "" {
			turnConfigured = true
			break
		}
	}

	log.Printf("config: addr=%s static_dir=%s redis_addr=%s ice_mode=%s ice_servers=%d turn_configured=%v ws_public_url=%s",
		cfg.Addr, cfg.StaticPath, cfg.RedisAddr, cfg.ICEMode, len(cfg.ICEServers), turnConfigured, cfg.PublicWSURL)
}

func splitAndClean(csv string) []string {
	parts := strings.Split(csv, ",")
	var out []string
	for _, p := range parts {
		v := strings.TrimSpace(p)
		if v != "" {
			out = append(out, v)
		}
	}
	return out
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

func spaHandler(staticDir string) http.Handler {
	fs := http.FileServer(http.Dir(staticDir))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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

func debugICE(cfg config) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		payload := map[string]interface{}{
			"mode":       cfg.ICEMode,
			"iceServers": cfg.ICEServers,
		}
		_ = json.NewEncoder(w).Encode(payload)
	})
}

func settingsHandler(cfg config) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wsURL := resolveWSURL(cfg, r)
		w.Header().Set("Content-Type", "application/json")
		payload := map[string]interface{}{
			"wsURL":      wsURL,
			"iceMode":    cfg.ICEMode,
			"iceServers": cfg.ICEServers,
		}
		if err := json.NewEncoder(w).Encode(payload); err != nil {
			log.Printf("settings encode error: %v", err)
		}
	})
}

func resolveWSURL(cfg config, r *http.Request) string {
	if cfg.PublicWSURL != "" {
		return cfg.PublicWSURL
	}

	proto := "ws"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		proto = "wss"
	}

	host := r.Host
	if host == "" {
		host = "localhost:8080"
	}

	return fmt.Sprintf("%s://%s/ws", proto, host)
}

// hubManager keeps one signaling Hub per room, each with isolated Redis keys.
type hubManager struct {
	mu   sync.Mutex
	hubs map[string]*signaling.Hub
	rdb  *redis.Client
	opts signaling.HubOptions
}

func newHubManager(rdb *redis.Client, opts signaling.HubOptions) *hubManager {
	return &hubManager{
		hubs: make(map[string]*signaling.Hub),
		rdb:  rdb,
		opts: opts,
	}
}

func (m *hubManager) hubForRoom(code string) *signaling.Hub {
	code = strings.TrimSpace(code)
	if code == "" {
		return nil
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if h := m.hubs[code]; h != nil {
		return h
	}

	store := signaling.NewRedisPresence(m.rdb, fmt.Sprintf("webrtc:room:%s", code))
	if err := store.Reset(context.Background()); err != nil {
		log.Printf("presence reset for room %s: %v", code, err)
	}
	hub := signaling.NewHub(store, m.opts)
	m.hubs[code] = hub
	return hub
}

func wsHandler(hubs *hubManager, roomStore rooms.Store) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		roomCode := strings.TrimSpace(r.URL.Query().Get("room"))
		if roomCode == "" {
			http.Error(w, "missing room code", http.StatusBadRequest)
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()

		if _, err := roomStore.Get(ctx, roomCode); err != nil {
			if errors.Is(err, rooms.ErrNotFound) {
				http.Error(w, "room not found", http.StatusNotFound)
				return
			}
			log.Printf("room lookup error: %v", err)
			http.Error(w, "room lookup failed", http.StatusInternalServerError)
			return
		}

		hub := hubs.hubForRoom(roomCode)
		if hub == nil {
			http.Error(w, "room not available", http.StatusInternalServerError)
			return
		}

		hub.HTTPHandler().ServeHTTP(w, r)
	})
}

func createRoomHandler(store rooms.Store) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()

		room, err := store.Create(ctx)
		if err != nil {
			log.Printf("room create error: %v", err)
			http.Error(w, "failed to create room", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		payload := map[string]interface{}{
			"code": room.Code,
			"url":  roomURL(r, room.Code),
		}
		_ = json.NewEncoder(w).Encode(payload)
	})
}

func roomLookupHandler(store rooms.Store) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}

		code := strings.TrimPrefix(r.URL.Path, "/api/rooms/")
		code = strings.Trim(code, "/")
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()

		room, err := store.Get(ctx, code)
		if err != nil {
			if errors.Is(err, rooms.ErrNotFound) {
				http.NotFound(w, r)
				return
			}
			log.Printf("room lookup error: %v", err)
			http.Error(w, "failed to lookup room", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		payload := map[string]interface{}{
			"code":      room.Code,
			"createdAt": room.CreatedAt,
			"url":       roomURL(r, room.Code),
		}
		_ = json.NewEncoder(w).Encode(payload)
	})
}

func roomURL(r *http.Request, code string) string {
	proto := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		proto = "https"
	}
	host := r.Host
	if host == "" {
		host = "localhost:8080"
	}
	return fmt.Sprintf("%s://%s/rooms/%s", proto, host, code)
}

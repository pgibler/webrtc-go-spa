package main

import (
	"bufio"
	"context"
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

	"videochat/internal/app/broadcast"
	"videochat/internal/app/httpapi"
	"videochat/internal/app/rooms"
	"videochat/internal/app/usernames"
	"videochat/pkg/presence"
	"videochat/pkg/webrtc/ice"
	"videochat/pkg/webrtc/protocol"
	"videochat/pkg/webrtc/signaling"
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
	hubs := newHubManager(rdb, roomStore, signaling.HubOptions{
		ICEServers: cfg.ICEServers,
		ICEMode:    cfg.ICEMode,
	})

	settings := httpapi.Settings{
		ICEMode:     cfg.ICEMode,
		ICEServers:  cfg.ICEServers,
		PublicWSURL: cfg.PublicWSURL,
	}

	http.Handle("/ws", httpapi.WSHandler(hubs, roomStore))
	http.Handle("/api/settings", httpapi.SettingsHandler(settings))
	http.Handle("/api/rooms", httpapi.CreateRoomHandler(roomStore))
	http.Handle("/api/rooms/", httpapi.RoomLookupHandler(roomStore))
	http.Handle("/debug/ice", httpapi.DebugICEHandler(settings))
	http.Handle("/", httpapi.SPAHandler(cfg.StaticPath))

	log.Printf("listening on %s (static: %s)", cfg.Addr, cfg.StaticPath)
	if err := http.ListenAndServe(cfg.Addr, nil); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

type config struct {
	Addr        string
	RedisAddr   string
	StaticPath  string
	ICEServers  []protocol.ICEServer
	ICEMode     string
	PublicWSURL string
}

func loadConfig() config {
	addr := getenv("ADDR", ":8080")
	redisAddr := getenv("REDIS_ADDR", "localhost:6379")
	staticDir := getenv("STATIC_DIR", defaultStaticPath)
	publicWS := strings.TrimSpace(os.Getenv("WS_PUBLIC_URL"))
	iceMode, iceServers := ice.LoadFromEnv()
	return config{
		Addr:        addr,
		RedisAddr:   redisAddr,
		StaticPath:  staticDir,
		ICEServers:  iceServers,
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

// hubManager keeps one signaling Hub per room, each with isolated Redis keys.
type hubEntry struct {
	hub   *signaling.Hub
	timer *time.Timer
	store presence.Store
	bcast broadcast.Store
	names usernames.Store
}

type hubManager struct {
	mu        sync.Mutex
	hubs      map[string]*hubEntry
	rdb       *redis.Client
	opts      signaling.HubOptions
	roomStore rooms.Store
}

func newHubManager(rdb *redis.Client, roomStore rooms.Store, opts signaling.HubOptions) *hubManager {
	return &hubManager{
		hubs:      make(map[string]*hubEntry),
		rdb:       rdb,
		opts:      opts,
		roomStore: roomStore,
	}
}

func (m *hubManager) HubForRoom(code string) httpapi.Hub {
	return m.hubForRoom(code)
}

func (m *hubManager) hubForRoom(code string) *signaling.Hub {
	code = strings.TrimSpace(code)
	if code == "" {
		return nil
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if h := m.hubs[code]; h != nil {
		if h.timer != nil {
			h.timer.Stop()
			h.timer = nil
		}
		return h.hub
	}

	presenceStore := presence.NewRedisStore(m.rdb, fmt.Sprintf("webrtc:room:%s", code))
	bcastStore := broadcast.NewRedisStore(m.rdb, fmt.Sprintf("webrtc:room:%s", code))
	namesStore := usernames.NewRedisStore(m.rdb, fmt.Sprintf("webrtc:room:%s", code))
	if err := presenceStore.Reset(context.Background()); err != nil {
		log.Printf("presence reset for room %s: %v", code, err)
	}
	if err := bcastStore.Reset(context.Background()); err != nil {
		log.Printf("broadcast reset for room %s: %v", code, err)
	}
	if err := namesStore.Reset(context.Background()); err != nil {
		log.Printf("usernames reset for room %s: %v", code, err)
	}

	opts := m.opts
	opts.OnEmpty = func() {
		m.scheduleCleanup(code, presenceStore, bcastStore, namesStore)
	}
	opts.Broadcasts = bcastStore
	opts.Usernames = namesStore

	hub := signaling.NewHub(presenceStore, opts)
	m.hubs[code] = &hubEntry{hub: hub, store: presenceStore, bcast: bcastStore, names: namesStore}
	return hub
}

func (m *hubManager) scheduleCleanup(code string, store presence.Store, bcast broadcast.Store, names usernames.Store) {
	m.mu.Lock()
	entry := m.hubs[code]
	if entry == nil {
		m.mu.Unlock()
		return
	}
	if entry.timer != nil {
		m.mu.Unlock()
		return
	}

	entry.timer = time.AfterFunc(30*time.Second, func() {
		m.cleanupRoom(code, store, bcast, names)
	})
	m.mu.Unlock()
}

func (m *hubManager) cleanupRoom(code string, store presence.Store, bcast broadcast.Store, names usernames.Store) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	peers, err := store.Peers(ctx)
	if err != nil {
		log.Printf("cleanup state error for room %s: %v", code, err)
	}
	if len(peers) > 0 {
		m.mu.Lock()
		if entry, ok := m.hubs[code]; ok {
			entry.timer = nil
		}
		m.mu.Unlock()
		return
	}

	if err := store.Reset(ctx); err != nil {
		log.Printf("cleanup presence reset failed for room %s: %v", code, err)
	}
	if err := bcast.Reset(ctx); err != nil {
		log.Printf("cleanup broadcast reset failed for room %s: %v", code, err)
	}
	if err := names.Reset(ctx); err != nil {
		log.Printf("cleanup usernames reset failed for room %s: %v", code, err)
	}
	if err := m.roomStore.Delete(ctx, code); err != nil && !errors.Is(err, rooms.ErrNotFound) {
		log.Printf("cleanup room delete failed for room %s: %v", code, err)
	}

	m.mu.Lock()
	delete(m.hubs, code)
	m.mu.Unlock()
	log.Printf("room %s cleaned up after inactivity", code)
}

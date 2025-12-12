package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"webrtc-go-spa/pkg/signaling"
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

	store := signaling.NewRedisPresence(rdb, "webrtc")
	if err := store.Reset(ctx); err != nil {
		log.Printf("redis reset presence: %v", err)
	}

	hub := signaling.NewHub(store, signaling.HubOptions{
		ICEServers: cfg.ICEServers,
		ICEMode:    cfg.ICEMode,
	})

	http.Handle("/ws", hub.HTTPHandler())
	http.Handle("/debug/ice", debugICE(cfg))
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
	ICEServers []signaling.ICEServer
	ICEMode    string
}

func loadConfig() config {
	addr := getenv("ADDR", ":8080")
	redisAddr := getenv("REDIS_ADDR", "localhost:6379")
	staticDir := getenv("STATIC_DIR", defaultStaticPath)
	iceMode := strings.TrimSpace(os.Getenv("ICE_MODE"))
	if iceMode == "" {
		iceMode = "stun-turn"
	}
	return config{
		Addr:       addr,
		RedisAddr:  redisAddr,
		StaticPath: staticDir,
		ICEServers: loadICEServers(iceMode),
		ICEMode:    iceMode,
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

	log.Printf("config: addr=%s static_dir=%s redis_addr=%s ice_mode=%s ice_servers=%d turn_configured=%v",
		cfg.Addr, cfg.StaticPath, cfg.RedisAddr, cfg.ICEMode, len(cfg.ICEServers), turnConfigured)
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

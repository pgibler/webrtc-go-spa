package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"videochat/internal/app/rooms"
	"videochat/pkg/webrtc/protocol"
)

type Settings struct {
	ICEMode     string
	ICEServers  []protocol.ICEServer
	PublicWSURL string
}

type Hub interface {
	HTTPHandler() http.Handler
}

type HubManager interface {
	HubForRoom(code string) Hub
}

func SPAHandler(staticDir string) http.Handler {
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

func DebugICEHandler(settings Settings) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		payload := map[string]interface{}{
			"mode":       settings.ICEMode,
			"iceServers": settings.ICEServers,
		}
		_ = json.NewEncoder(w).Encode(payload)
	})
}

func SettingsHandler(settings Settings) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wsURL := resolveWSURL(settings, r)
		w.Header().Set("Content-Type", "application/json")
		payload := map[string]interface{}{
			"wsURL":      wsURL,
			"iceMode":    settings.ICEMode,
			"iceServers": settings.ICEServers,
		}
		if err := json.NewEncoder(w).Encode(payload); err != nil {
			log.Printf("settings encode error: %v", err)
		}
	})
}

func resolveWSURL(settings Settings, r *http.Request) string {
	if settings.PublicWSURL != "" {
		return settings.PublicWSURL
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

func WSHandler(hubs HubManager, roomStore rooms.Store) http.Handler {
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

		hub := hubs.HubForRoom(roomCode)
		if hub == nil {
			http.Error(w, "room not available", http.StatusInternalServerError)
			return
		}

		hub.HTTPHandler().ServeHTTP(w, r)
	})
}

func CreateRoomHandler(store rooms.Store) http.Handler {
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

func RoomLookupHandler(store rooms.Store) http.Handler {
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

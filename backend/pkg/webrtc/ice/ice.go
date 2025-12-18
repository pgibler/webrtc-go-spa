package ice

import (
	"log"
	"os"
	"strings"

	"videochat/pkg/webrtc/protocol"
)

// LoadFromEnv parses ICE configuration from environment variables.
//
// Env vars:
// - STUN_URLS: comma-separated STUN URLs
// - TURN_URLS: comma-separated TURN URLs
// - TURN_USERNAME / TURN_PASSWORD: TURN credentials (if required)
// - ICE_MODE: stun-turn (default), turn-only, stun-only
func LoadFromEnv() (mode string, servers []protocol.ICEServer) {
	mode = strings.TrimSpace(os.Getenv("ICE_MODE"))
	if mode == "" {
		mode = "stun-turn"
	}

	defaultSTUN := []string{"stun:stun.l.google.com:19302"}

	stunEnv := strings.TrimSpace(os.Getenv("STUN_URLS"))
	turnEnv := strings.TrimSpace(os.Getenv("TURN_URLS"))
	turnUsername := strings.TrimSpace(os.Getenv("TURN_USERNAME"))
	turnPassword := strings.TrimSpace(os.Getenv("TURN_PASSWORD"))

	turnOnly := strings.EqualFold(mode, "turn-only")
	stunOnly := strings.EqualFold(mode, "stun-only")

	if !turnOnly {
		if stunEnv != "" {
			stunURLs := splitAndClean(stunEnv)
			if len(stunURLs) > 0 {
				servers = append(servers, protocol.ICEServer{URLs: stunURLs})
			}
		} else {
			servers = append(servers, protocol.ICEServer{URLs: defaultSTUN})
		}
	}

	if !stunOnly {
		if turnEnv != "" {
			turnURLs := splitAndClean(turnEnv)
			if len(turnURLs) > 0 {
				servers = append(servers, protocol.ICEServer{
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
		servers = append(servers, protocol.ICEServer{URLs: defaultSTUN})
	}

	log.Printf("ICE servers loaded (mode=%s): %+v", mode, servers)
	return mode, servers
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

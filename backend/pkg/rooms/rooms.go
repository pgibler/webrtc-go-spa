package rooms

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// Room represents a private room that can be joined via its code.
type Room struct {
	Code      string    `json:"code"`
	CreatedAt time.Time `json:"createdAt"`
}

// Store describes room creation and lookup operations.
type Store interface {
	Create(ctx context.Context) (*Room, error)
	Get(ctx context.Context, code string) (*Room, error)
	Delete(ctx context.Context, code string) error
}

// RedisStore persists room metadata in Redis.
type RedisStore struct {
	rdb    *redis.Client
	prefix string
}

// ErrNotFound is returned when a room code does not exist.
var ErrNotFound = errors.New("room not found")

// NewRedisStore builds a room store scoped under the provided prefix (e.g., "webrtc").
func NewRedisStore(rdb *redis.Client, prefix string) *RedisStore {
	p := strings.TrimSuffix(strings.TrimSpace(prefix), ":")
	if p == "" {
		p = "webrtc"
	}
	return &RedisStore{rdb: rdb, prefix: p}
}

func (s *RedisStore) roomKey(code string) string {
	return fmt.Sprintf("%s:rooms:%s", s.prefix, code)
}

// Create generates a new room code and stores it.
func (s *RedisStore) Create(ctx context.Context) (*Room, error) {
	for i := 0; i < 5; i++ {
		code := generateCode()
		key := s.roomKey(code)
		exists, err := s.rdb.Exists(ctx, key).Result()
		if err != nil {
			return nil, err
		}
		if exists > 0 {
			continue
		}
		now := time.Now().UTC()
		if err := s.rdb.HSet(ctx, key, map[string]interface{}{
			"code":       code,
			"created_at": now.Format(time.RFC3339),
		}).Err(); err != nil {
			return nil, err
		}
		return &Room{Code: code, CreatedAt: now}, nil
	}
	return nil, errors.New("failed to generate unique room code")
}

// Get fetches a room by code, returning ErrNotFound when missing.
func (s *RedisStore) Get(ctx context.Context, code string) (*Room, error) {
	code = strings.TrimSpace(code)
	if code == "" {
		return nil, ErrNotFound
	}

	vals, err := s.rdb.HGetAll(ctx, s.roomKey(code)).Result()
	if err != nil {
		return nil, err
	}
	if len(vals) == 0 {
		return nil, ErrNotFound
	}

	createdAt := time.Now().UTC()
	if ts, ok := vals["created_at"]; ok {
		if parsed, err := time.Parse(time.RFC3339, ts); err == nil {
			createdAt = parsed
		}
	}

	return &Room{Code: code, CreatedAt: createdAt}, nil
}

// Delete removes a room by code, returning ErrNotFound when the room does not exist.
func (s *RedisStore) Delete(ctx context.Context, code string) error {
	code = strings.TrimSpace(code)
	if code == "" {
		return ErrNotFound
	}
	deleted, err := s.rdb.Del(ctx, s.roomKey(code)).Result()
	if err != nil {
		return err
	}
	if deleted == 0 {
		return ErrNotFound
	}
	return nil
}

// generateCode produces a short, URL-safe room code.
func generateCode() string {
	// 6 bytes -> 8 chars when raw URL base64 encoded without padding.
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return strings.TrimRight(base64.RawURLEncoding.EncodeToString(b), "=")
}

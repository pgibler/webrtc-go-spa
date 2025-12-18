package usernames

import (
	"context"
	"fmt"
	"strings"

	"github.com/redis/go-redis/v9"
)

// Store tracks peer display names in a room.
type Store interface {
	Reset(ctx context.Context) error
	RemovePeer(ctx context.Context, id string) error
	SetUsername(ctx context.Context, id string, username string) error
	Usernames(ctx context.Context) (map[string]string, error)
}

// RedisStore implements Store using a Redis hash.
type RedisStore struct {
	rdb          *redis.Client
	keyUsernames string
}

// NewRedisStore builds a Store backed by Redis. Prefix is optional (e.g., "webrtc:room:abc123").
func NewRedisStore(rdb *redis.Client, prefix string) *RedisStore {
	p := strings.TrimSuffix(strings.TrimSpace(prefix), ":")
	if p == "" {
		p = "webrtc"
	}
	return &RedisStore{
		rdb:          rdb,
		keyUsernames: fmt.Sprintf("%s:usernames", p),
	}
}

func (s *RedisStore) Reset(ctx context.Context) error {
	return s.rdb.Del(ctx, s.keyUsernames).Err()
}

func (s *RedisStore) RemovePeer(ctx context.Context, id string) error {
	return s.rdb.HDel(ctx, s.keyUsernames, id).Err()
}

func (s *RedisStore) SetUsername(ctx context.Context, id string, username string) error {
	username = strings.TrimSpace(username)
	if username == "" {
		return s.rdb.HDel(ctx, s.keyUsernames, id).Err()
	}
	return s.rdb.HSet(ctx, s.keyUsernames, id, username).Err()
}

func (s *RedisStore) Usernames(ctx context.Context) (map[string]string, error) {
	vals, err := s.rdb.HGetAll(ctx, s.keyUsernames).Result()
	if err != nil {
		return nil, err
	}
	return vals, nil
}
